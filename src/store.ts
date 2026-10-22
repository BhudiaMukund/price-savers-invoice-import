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
  batch(stmts: Stmt[]): Promise<{ meta: { changes?: number; last_row_id?: number } }[]>;
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
  // Stock added from invoice quantities. dedupe_key (invoice + product) is what stops the same invoice adding
  // its stock twice; it is cleared when the stock is taken back out, so the invoice can be added again.
  `CREATE TABLE IF NOT EXISTS stock_changes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     dedupe_key TEXT UNIQUE,
     run_id INTEGER NOT NULL,
     import_id TEXT NOT NULL,
     product_id TEXT NOT NULL,
     barcode TEXT,
     qty INTEGER NOT NULL,
     location_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     created_by TEXT,
     created_at TEXT NOT NULL,
     undone_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS stock_by_import ON stock_changes(import_id)`,
  `CREATE INDEX IF NOT EXISTS imported_by_run ON imported_products(run_id)`,
  `CREATE INDEX IF NOT EXISTS imported_by_import ON imported_products(import_id)`,
  // Supplier catalogues: reference data only (nothing is created in Shopify except the photos, in Files).
  `CREATE TABLE IF NOT EXISTS catalogue_uploads (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     code TEXT UNIQUE,
     supplier TEXT NOT NULL,
     supplier_key TEXT NOT NULL,
     file_names TEXT NOT NULL DEFAULT '',
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     finished_at TEXT,
     item_count INTEGER NOT NULL DEFAULT 0,
     photo_count INTEGER NOT NULL DEFAULT 0,
     undone_at TEXT,
     undone_by TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS catalogue_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     upload_id INTEGER NOT NULL,
     supplier_key TEXT NOT NULL,
     barcode TEXT,
     barcode_key TEXT,
     code TEXT,
     code_key TEXT,
     title TEXT,
     description TEXT,
     mixed INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS cat_items_barcode ON catalogue_items(barcode_key)`,
  `CREATE INDEX IF NOT EXISTS cat_items_code ON catalogue_items(supplier_key, code_key)`,
  `CREATE INDEX IF NOT EXISTS cat_items_upload ON catalogue_items(upload_id)`,
  `CREATE TABLE IF NOT EXISTS catalogue_photos (
     item_id INTEGER NOT NULL,
     file_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     PRIMARY KEY (item_id, file_id)
   )`,
  `CREATE INDEX IF NOT EXISTS cat_photos_file ON catalogue_photos(file_id)`,
  `CREATE TABLE IF NOT EXISTS catalogue_files (
     file_id TEXT PRIMARY KEY,
     fingerprint TEXT UNIQUE,
     upload_id INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'processing',
     url TEXT,
     error TEXT,
     source TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS cat_files_upload ON catalogue_files(upload_id, status)`,
  // Which store products got a copy of which catalogue photo, so a catalogue in use can't be removed by
  // accident, and products whose photos were removed can get new ones later.
  `CREATE TABLE IF NOT EXISTS product_photos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     product_id TEXT NOT NULL,
     product_title TEXT,
     media_id TEXT,
     file_id TEXT NOT NULL,
     source TEXT NOT NULL,
     attached_at TEXT NOT NULL,
     attached_by TEXT,
     removed_at TEXT,
     removed_by TEXT,
     removed_reason TEXT,
     removed_catalogue TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS product_photos_file ON product_photos(file_id)`,
  `CREATE INDEX IF NOT EXISTS product_photos_product ON product_photos(product_id)`,
  // Shared settings (the Settings page), one row per setting.
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_by TEXT,
     updated_at TEXT NOT NULL
   )`,
];

let ready: Promise<void> | null = null;
let readyFor: Db | null = null;

/** Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS": each is tried on its own. */
const ADDED_COLUMNS = [
  `ALTER TABLE catalogue_files ADD COLUMN sig TEXT`,
  `ALTER TABLE catalogue_files ADD COLUMN thumb TEXT`,
  `ALTER TABLE catalogue_files ADD COLUMN pixels INTEGER`,
  `ALTER TABLE catalogue_files ADD COLUMN merged_into TEXT`,
];

async function addColumns(db: Db) {
  for (const sql of ADDED_COLUMNS) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* already there */
    }
  }
}

export async function ensureSchema(db: Db) {
  if (ready && readyFor === db) return ready;
  readyFor = db;
  ready = db
    .batch(SCHEMA.map((s) => db.prepare(s)))
    .then(() => addColumns(db))
    .then(() => undefined);
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

  /**
   * A run with its saved data as the stored text, so a big run is sent back without being parsed and
   * written out again (the free plan allows very little CPU per request).
   */
  async getRunText(code: string): Promise<{ detail: Omit<RunDetail, "data">; dataText: string } | null> {
    await this.ready();
    const r = await this.row(code);
    if (!r) return null;
    const live = await this.liveByInvoice(r.id);
    const t = (r.data ?? "").trim();
    return {
      detail: { ...toSummary({ ...r, live: Object.values(live).reduce((a, b) => a + b, 0) }), version: r.version, liveByInvoice: live },
      dataText: t.startsWith("{") && t.endsWith("}") ? t : "{}",
    };
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
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new StoreError("The run data couldn't be read.", 400);

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
    // A deleted product has no stock left, so the same invoice may add it again.
    await this.db.batch(productIds.map((id) => this.db.prepare(`UPDATE stock_changes SET undone_at = ?, dedupe_key = NULL WHERE product_id = ? AND undone_at IS NULL`).bind(t, id)));
  }

  /**
   * Claim "this invoice adds this stock to this product" before touching Shopify. Returns the keys that were
   * free; a key already held means the same invoice already added its stock, so that line is skipped.
   */
  async claimStock(
    entries: { key: string; runId: number; importId: string; productId: string; barcode: string | null; qty: number; locationId: string; kind: "created" | "added" }[],
    user: string,
  ): Promise<Set<string>> {
    const free = new Set<string>();
    if (!entries.length) return free;
    await this.ready();
    const t = now();
    const res = await this.db.batch(
      entries.map((e) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO stock_changes (dedupe_key, run_id, import_id, product_id, barcode, qty, location_id, kind, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(e.key, e.runId, e.importId, e.productId, e.barcode, e.qty, e.locationId, e.kind, user, t),
      ),
    );
    entries.forEach((e, i) => {
      if ((res[i]?.meta.changes ?? 0) > 0) free.add(e.key);
    });
    return free;
  }

  /** Shopify refused: give the claim back so the line can be tried again. */
  async releaseStock(keys: string[]) {
    if (!keys.length) return;
    await this.ready();
    await this.db.batch(keys.map((k) => this.db.prepare(`DELETE FROM stock_changes WHERE dedupe_key = ?`).bind(k)));
  }

  /** Stock this import added to products that were already in the store, and that hasn't been taken back out. */
  async stockAddedByImport(importId: string, productIds: string[]): Promise<{ id: number; productId: string; qty: number; locationId: string }[]> {
    await this.ready();
    if (!productIds.length) return [];
    const marks = productIds.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT id, product_id, qty, location_id FROM stock_changes WHERE import_id = ? AND kind = 'added' AND undone_at IS NULL AND product_id IN (${marks})`)
      .bind(importId, ...productIds)
      .all<{ id: number; product_id: string; qty: number; location_id: string }>();
    return results.map((r) => ({ id: r.id, productId: r.product_id, qty: r.qty, locationId: r.location_id }));
  }

  async markStockUndone(ids: number[]) {
    if (!ids.length) return;
    await this.ready();
    const t = now();
    await this.db.batch(ids.map((id) => this.db.prepare(`UPDATE stock_changes SET undone_at = ?, dedupe_key = NULL WHERE id = ?`).bind(t, id)));
  }
}
