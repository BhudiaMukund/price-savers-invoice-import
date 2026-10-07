/**
 * Runs and the import ledger, stored in Cloudflare D1 (SQLite).
 *
 * - A run is one working session: who started it, when, and its working state (invoices + products) as JSON.
 * - The ledger (imported_products) records every product this tool created in Shopify, with its run,
 *   invoice and import ID. It is the source of truth for "this invoice still has products in Shopify",
 *   which is what stops an invoice being removed until its products are deleted.
 *
 * Tables are created on first use, so there are no migrations to run.
 */

/** The small part of D1 we use. Tests and demo mode pass an adapter over node:sqlite. */
export interface Db {
  prepare(sql: string): Stmt;
  batch(stmts: Stmt[]): Promise<unknown[]>;
}
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     code TEXT UNIQUE,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT,
     version INTEGER NOT NULL DEFAULT 1,
     data TEXT NOT NULL DEFAULT '{}',
     search TEXT NOT NULL DEFAULT '',
     invoice_count INTEGER NOT NULL DEFAULT 0,
     product_count INTEGER NOT NULL DEFAULT 0,
     invoice_names TEXT NOT NULL DEFAULT '',
     suppliers TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS imported_products (
     product_id TEXT PRIMARY KEY,
     run_id INTEGER NOT NULL,
     invoice_id TEXT NOT NULL,
     import_id TEXT NOT NULL,
     title TEXT,
     barcode TEXT,
     vendor TEXT,
     created_by TEXT,
     created_at TEXT NOT NULL,
     deleted_at TEXT,
     deleted_by TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS imported_by_run ON imported_products(run_id)`,
  `CREATE INDEX IF NOT EXISTS imported_by_import ON imported_products(import_id)`,
];

let ready: Promise<void> | null = null;
let readyFor: Db | null = null;

async function ensureSchema(db: Db) {
  if (ready && readyFor === db) return ready;
  readyFor = db;
  ready = db.batch(SCHEMA.map((s) => db.prepare(s))).then(() => undefined);
  ready.catch(() => {
    ready = null; // try again on the next request
  });
  return ready;
}

/** Test helper. */
export function resetSchemaCache() {
  ready = null;
  readyFor = null;
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413,
    readonly code?: string,
  ) {
    super(message);
  }
}

const MAX_DATA_BYTES = 1_500_000;
export const RUN_CODE_RE = /^R\d{1,9}$/;

export interface RunSummary {
  code: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  invoiceCount: number;
  productCount: number;
  invoiceNames: string[];
  suppliers: string[];
  /** Products this run put in Shopify that haven't been deleted. */
  liveProducts: number;
}

export interface RunDetail extends RunSummary {
  version: number;
  data: unknown;
  /** Live (not deleted) products in Shopify per invoice id. */
  liveByInvoice: Record<string, number>;
}

interface RunRow {
  id: number;
  code: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  version: number;
  data: string;
  invoice_count: number;
  product_count: number;
  invoice_names: string;
  suppliers: string;
  live?: number;
}

const now = () => new Date().toISOString();
const splitList = (s: string) => (s ? s.split("\n").filter(Boolean) : []);

function toSummary(r: RunRow): RunSummary {
  return {
    code: r.code,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    invoiceCount: r.invoice_count,
    productCount: r.product_count,
    invoiceNames: splitList(r.invoice_names),
    suppliers: splitList(r.suppliers),
    liveProducts: r.live ?? 0,
  };
}

/** What the page saves for a run. Only the fields the server reads are typed. */
interface RunData {
  sources?: { id?: unknown; name?: unknown; supplier?: unknown; invoiceNumber?: unknown; importId?: unknown }[];
  rows?: { title?: unknown; invoiceTitle?: unknown; barcode?: unknown; supplierCode?: unknown; sourceId?: unknown }[];
}

/** Columns used for the runs list and search, worked out from the saved data. */
export function summarise(data: RunData, code: string, user: string) {
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const names = sources.map((s) => str(s.name)).filter(Boolean);
  const suppliers = [...new Set(sources.map((s) => str(s.supplier)).filter(Boolean))];
  const bits = [
    code,
    user,
    ...names,
    ...suppliers,
    ...sources.flatMap((s) => [str(s.invoiceNumber), str(s.importId)]),
    ...rows.flatMap((r) => [str(r.title), str(r.invoiceTitle), str(r.barcode), str(r.supplierCode)]),
  ].filter(Boolean);
  return {
    invoiceIds: sources.map((s) => str(s.id)).filter(Boolean),
    invoiceCount: sources.length,
    productCount: rows.length,
    invoiceNames: names.join("\n").slice(0, 2000),
    suppliers: suppliers.join("\n").slice(0, 1000),
    search: bits.join(" \n ").toLowerCase().slice(0, 60_000),
  };
}

export class RunStore {
  constructor(private db: Db) {}

  private async ready() {
    await ensureSchema(this.db);
  }

  async createRun(user: string): Promise<RunDetail> {
    await this.ready();
    const t = now();
    const res = await this.db
      .prepare(`INSERT INTO runs (created_by, created_at, updated_at, updated_by, data) VALUES (?, ?, ?, ?, '{"sources":[],"rows":[]}')`)
      .bind(user, t, t, user)
      .run();
    const id = Number(res.meta.last_row_id);
    const code = `R${id}`;
    await this.db.prepare(`UPDATE runs SET code = ? WHERE id = ?`).bind(code, id).run();
    const run = await this.getRun(code);
    if (!run) throw new StoreError("The run couldn't be created.", 409);
    return run;
  }

  private async row(code: string): Promise<RunRow | null> {
    if (!RUN_CODE_RE.test(code)) return null;
    return this.db.prepare(`SELECT * FROM runs WHERE code = ?`).bind(code).first<RunRow>();
  }

  async getRun(code: string): Promise<RunDetail | null> {
    await this.ready();
    const r = await this.row(code);
    if (!r) return null;
    const live = await this.liveByInvoice(r.id);
    let data: unknown = {};
    try {
      data = JSON.parse(r.data);
    } catch {
      /* keep empty */
    }
    return {
      ...toSummary({ ...r, live: Object.values(live).reduce((a, b) => a + b, 0) }),
      version: r.version,
      data,
      liveByInvoice: live,
    };
  }

  private async liveByInvoice(runId: number): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare(`SELECT invoice_id, COUNT(*) AS n FROM imported_products WHERE run_id = ? AND deleted_at IS NULL GROUP BY invoice_id`)
      .bind(runId)
      .all<{ invoice_id: string; n: number }>();
    return Object.fromEntries(results.map((x) => [x.invoice_id, Number(x.n)]));
  }

  /**
   * Save the working state. Refuses (409) if someone else saved first (version moved on), or if the new state
   * drops an invoice that still has products in Shopify.
   */
  async saveRun(code: string, version: number, dataText: string, user: string): Promise<{ version: number; updatedAt: string }> {
    await this.ready();
    if (dataText.length > MAX_DATA_BYTES) throw new StoreError("This run is too large to save. Start a new run for more invoices.", 413);
    let data: RunData;
    try {
      data = JSON.parse(dataText);
    } catch {
      throw new StoreError("The run data couldn't be read.", 400);
    }
    if (!data || typeof data !== "object") throw new StoreError("The run data couldn't be read.", 400);

    const r = await this.row(code);
    if (!r) throw new StoreError("Run not found.", 404);
    const s = summarise(data, code, r.created_by);

    // An invoice whose products are still in Shopify can't disappear from its run.
    const live = await this.liveByInvoice(r.id);
    const kept = new Set(s.invoiceIds);
    const dropped = Object.keys(live).filter((id) => !kept.has(id));
    if (dropped.length) {
      throw new StoreError(
        "An invoice with products still in Shopify can't be removed. Use Undo import to delete its products first.",
        409,
        "invoice_has_products",
      );
    }

    const t = now();
    const res = await this.db
      .prepare(
        `UPDATE runs SET data = ?, version = version + 1, updated_at = ?, updated_by = ?, search = ?, invoice_count = ?,
           product_count = ?, invoice_names = ?, suppliers = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(dataText, t, user, s.search, s.invoiceCount, s.productCount, s.invoiceNames, s.suppliers, r.id, version)
      .run();
    if (!res.meta.changes) {
      throw new StoreError("Someone else changed this run since you opened it. Reload to see the latest.", 409, "version_conflict");
    }
    return { version: version + 1, updatedAt: t };
  }

  async listRuns(opts: { q?: string; createdBy?: string; before?: number; limit?: number }): Promise<{ runs: RunSummary[]; next: number | null }> {
    await this.ready();
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const where = ["invoice_count > 0"];
    const args: unknown[] = [];
    if (opts.q?.trim()) {
      for (const word of opts.q.trim().toLowerCase().split(/\s+/).slice(0, 6)) {
        where.push(`search LIKE ? ESCAPE '\\'`);
        args.push(`%${word.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      }
    }
    if (opts.createdBy) {
      where.push(`created_by = ?`);
      args.push(opts.createdBy);
    }
    if (opts.before) {
      where.push(`id < ?`);
      args.push(opts.before);
    }
    const { results } = await this.db
      .prepare(
        `SELECT r.id, r.code, r.created_by, r.created_at, r.updated_at, r.updated_by, r.version, '' AS data,
                r.invoice_count, r.product_count, r.invoice_names, r.suppliers,
                (SELECT COUNT(*) FROM imported_products p WHERE p.run_id = r.id AND p.deleted_at IS NULL) AS live
         FROM runs r WHERE ${where.join(" AND ")} ORDER BY r.id DESC LIMIT ?`,
      )
      .bind(...args, limit + 1)
      .all<RunRow>();
    const page = results.slice(0, limit);
    return { runs: page.map(toSummary), next: results.length > limit ? page[page.length - 1]!.id : null };
  }

  /** Delete a run. Only allowed when none of its products are still in Shopify. */
  async deleteRun(code: string): Promise<void> {
    await this.ready();
    const r = await this.row(code);
    if (!r) throw new StoreError("Run not found.", 404);
    const live = await this.liveByInvoice(r.id);
    if (Object.keys(live).length) {
      throw new StoreError("This run still has products in Shopify. Undo its imports first.", 409, "run_has_products");
    }
    await this.db.prepare(`DELETE FROM runs WHERE id = ?`).bind(r.id).run();
  }

  async runId(code: string): Promise<number | null> {
    await this.ready();
    return (await this.row(code))?.id ?? null;
  }

  /** Record products this tool just created in Shopify. */
  async recordProducts(
    entries: { productId: string; runId: number; invoiceId: string; importId: string; title: string; barcode: string | null; vendor: string | null }[],
    user: string,
  ) {
    if (!entries.length) return;
    await this.ready();
    const t = now();
    await this.db.batch(
      entries.map((e) =>
        this.db
          .prepare(
            `INSERT OR REPLACE INTO imported_products (product_id, run_id, invoice_id, import_id, title, barcode, vendor, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(e.productId, e.runId, e.invoiceId, e.importId, e.title, e.barcode, e.vendor, user, t),
      ),
    );
  }

  /** Which of these products the ledger says belong to this import and are still live. */
  async liveInImport(importId: string, productIds: string[]): Promise<Set<string>> {
    await this.ready();
    if (!productIds.length) return new Set();
    const marks = productIds.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT product_id FROM imported_products WHERE import_id = ? AND deleted_at IS NULL AND product_id IN (${marks})`)
      .bind(importId, ...productIds)
      .all<{ product_id: string }>();
    return new Set(results.map((r) => r.product_id));
  }

  async markDeleted(productIds: string[], user: string) {
    if (!productIds.length) return;
    await this.ready();
    const t = now();
    await this.db.batch(
      productIds.map((id) =>
        this.db.prepare(`UPDATE imported_products SET deleted_at = ?, deleted_by = ? WHERE product_id = ? AND deleted_at IS NULL`).bind(t, user, id),
      ),
    );
  }
}
