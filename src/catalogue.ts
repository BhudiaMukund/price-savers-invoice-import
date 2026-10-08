/**
 * Supplier catalogues, stored in D1.
 *
 * A catalogue upload is reference data: the supplier's barcodes, codes, descriptions and photos. Nothing is
 * created in Shopify except the photos, which live in Shopify Files (so they never expire). When an invoice
 * is imported, its lines are matched against the catalogue and new products get a copy of the photos.
 *
 * Each upload keeps its own rows, and lookups use the newest upload that hasn't been undone. So uploading a
 * fresh export from a supplier replaces the old one, and undoing it brings the previous one back.
 */
import { analyzeBarcode } from "./barcode";
import { ensureSchema, StoreError, type Db } from "./store";

export const CATALOGUE_CODE_RE = /^C\d{1,9}$/;
export const FILE_ID_RE = /^gid:\/\/shopify\/(MediaImage|GenericFile)\/\d+$/;
export const MAX_PHOTOS_PER_ITEM = 12;
/** D1 allows 100 bound values per statement. */
const IN_CHUNK = 90;

const now = () => new Date().toISOString();

/** Supplier names come from the same list everywhere; compare them ignoring case and spacing. */
export function supplierMatchKey(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** "HN-7701", "hn 7701" and "HN7701" are the same supplier code. */
export function codeKey(code: string | null | undefined): string | null {
  const k = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return k || null;
}

export interface UploadSummary {
  code: string;
  supplier: string;
  fileNames: string[];
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
  itemCount: number;
  photoCount: number;
  undoneAt: string | null;
  undoneBy: string | null;
}

interface UploadRow {
  id: number;
  code: string;
  supplier: string;
  supplier_key: string;
  file_names: string;
  created_by: string;
  created_at: string;
  finished_at: string | null;
  item_count: number;
  photo_count: number;
  undone_at: string | null;
  undone_by: string | null;
}

function toSummary(r: UploadRow): UploadSummary {
  return {
    code: r.code,
    supplier: r.supplier,
    fileNames: r.file_names ? r.file_names.split("\n") : [],
    createdBy: r.created_by,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    itemCount: Number(r.item_count),
    photoCount: Number(r.photo_count),
    undoneAt: r.undone_at,
    undoneBy: r.undone_by,
  };
}

export interface CatalogueItemIn {
  barcode: string | null;
  code: string | null;
  title: string | null;
  description: string | null;
  photos: string[];
  mixed: boolean;
}

export interface PhotoInfo {
  fileId: string;
  status: "processing" | "ready" | "failed" | "deleted";
  url: string | null;
}

export interface CatalogueMatch {
  itemId: number;
  catalogue: string;
  supplier: string;
  by: "barcode" | "code";
  barcode: string | null;
  code: string | null;
  title: string | null;
  description: string | null;
  mixed: boolean;
  photos: PhotoInfo[];
}

interface ItemRow {
  id: number;
  upload_id: number;
  code_upload: string;
  supplier: string;
  supplier_key: string;
  barcode: string | null;
  barcode_key: string | null;
  code: string | null;
  code_key: string | null;
  title: string | null;
  description: string | null;
  mixed: number;
}

export class CatalogueStore {
  constructor(private db: Db) {}

  private ready() {
    return ensureSchema(this.db);
  }

  private async row(code: string): Promise<UploadRow | null> {
    if (!CATALOGUE_CODE_RE.test(code)) return null;
    return this.db.prepare(`SELECT * FROM catalogue_uploads WHERE code = ?`).bind(code).first<UploadRow>();
  }

  /** The upload, which must exist and not have been undone. */
  async open(code: string): Promise<UploadRow> {
    await this.ready();
    const r = await this.row(code);
    if (!r) throw new StoreError("Catalogue upload not found.", 404);
    if (r.undone_at) throw new StoreError("This catalogue upload was undone.", 409, "undone");
    return r;
  }

  async create(supplier: string, fileNames: string[], user: string): Promise<UploadSummary> {
    await this.ready();
    const name = supplier.replace(/\s+/g, " ").trim().slice(0, 100);
    if (!name) throw new StoreError("Choose the supplier this catalogue is from.", 400);
    const t = now();
    const res = await this.db
      .prepare(`INSERT INTO catalogue_uploads (supplier, supplier_key, file_names, created_by, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(name, supplierMatchKey(name), fileNames.map((f) => f.slice(0, 200)).slice(0, 50).join("\n"), user, t)
      .run();
    const id = Number(res.meta.last_row_id);
    await this.db.prepare(`UPDATE catalogue_uploads SET code = ? WHERE id = ?`).bind(`C${id}`, id).run();
    return toSummary((await this.row(`C${id}`))!);
  }

  async get(code: string): Promise<(UploadSummary & { photos: Record<string, number>; failed: { source: string; error: string }[] }) | null> {
    await this.ready();
    const r = await this.row(code);
    if (!r) return null;
    const { results } = await this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM catalogue_files WHERE upload_id = ? GROUP BY status`)
      .bind(r.id)
      .all<{ status: string; n: number }>();
    const failed = await this.db
      .prepare(`SELECT source, error FROM catalogue_files WHERE upload_id = ? AND status = 'failed' ORDER BY created_at LIMIT 100`)
      .bind(r.id)
      .all<{ source: string | null; error: string | null }>();
    return {
      ...toSummary(r),
      photos: Object.fromEntries(results.map((x) => [x.status, Number(x.n)])),
      failed: failed.results.map((f) => ({ source: f.source ?? "", error: f.error ?? "" })),
    };
  }

  async list(opts: { q?: string; before?: number; limit?: number }): Promise<{ uploads: UploadSummary[]; next: number | null }> {
    await this.ready();
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const where = ["finished_at IS NOT NULL"];
    const args: unknown[] = [];
    if (opts.q?.trim()) {
      where.push(`(LOWER(supplier) LIKE ? ESCAPE '\\' OR LOWER(file_names) LIKE ? ESCAPE '\\' OR LOWER(code) = ?)`);
      const like = `%${opts.q.trim().toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      args.push(like, like, opts.q.trim().toLowerCase());
    }
    if (opts.before) {
      where.push(`id < ?`);
      args.push(opts.before);
    }
    const { results } = await this.db
      .prepare(`SELECT * FROM catalogue_uploads WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .bind(...args, limit + 1)
      .all<UploadRow>();
    const page = results.slice(0, limit);
    return { uploads: page.map(toSummary), next: results.length > limit ? page[page.length - 1]!.id : null };
  }

  /* ---------------------------------------------------------------- photos */

  /** Photos already in Shopify Files, by fingerprint (so the same picture is never uploaded twice). */
  async knownFiles(fingerprints: string[]): Promise<Record<string, PhotoInfo>> {
    await this.ready();
    const out: Record<string, PhotoInfo> = {};
    for (let i = 0; i < fingerprints.length; i += IN_CHUNK) {
      const part = fingerprints.slice(i, i + IN_CHUNK);
      const { results } = await this.db
        .prepare(
          // A photo merged into a look-alike counts as that one (so the same bytes aren't uploaded again).
          `SELECT f.fingerprint, COALESCE(m.file_id, f.file_id) AS file_id, COALESCE(m.status, f.status) AS status, COALESCE(m.url, f.url) AS url
           FROM catalogue_files f LEFT JOIN catalogue_files m ON m.file_id = f.merged_into
           WHERE f.fingerprint IN (${part.map(() => "?").join(",")})
             AND (f.status != 'deleted' OR (m.file_id IS NOT NULL AND m.status != 'deleted'))`,
        )
        .bind(...part)
        .all<{ fingerprint: string; file_id: string; status: PhotoInfo["status"]; url: string | null }>();
      for (const r of results) out[r.fingerprint] = { fileId: r.file_id, status: r.status, url: r.url };
    }
    return out;
  }

  async addFile(f: { fileId: string; fingerprint: string | null; uploadId: number; status: PhotoInfo["status"]; url: string | null; source: string; error?: string | null }) {
    await this.db
      .prepare(
        `INSERT INTO catalogue_files (file_id, fingerprint, upload_id, status, url, error, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO NOTHING`,
      )
      .bind(f.fileId, f.fingerprint, f.uploadId, f.status, f.url, f.error ?? null, f.source.slice(0, 300), now())
      .run();
  }

  /** A photo that never reached Shopify (bad link, expired link). Kept so staff see what failed. */
  async addFailedSource(uploadId: number, source: string, error: string) {
    await this.addFile({ fileId: `failed:${uploadId}:${crypto.randomUUID()}`, fingerprint: null, uploadId, status: "failed", url: null, source, error });
  }

  async filesById(ids: string[]): Promise<Map<string, PhotoInfo>> {
    await this.ready();
    const out = new Map<string, PhotoInfo>();
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const part = ids.slice(i, i + IN_CHUNK);
      if (!part.length) continue;
      const { results } = await this.db
        .prepare(`SELECT file_id, status, url FROM catalogue_files WHERE file_id IN (${part.map(() => "?").join(",")})`)
        .bind(...part)
        .all<{ file_id: string; status: PhotoInfo["status"]; url: string | null }>();
      for (const r of results) out.set(r.file_id, { fileId: r.file_id, status: r.status, url: r.url });
    }
    return out;
  }

  /** Photos still being processed by Shopify, oldest first (their status is refreshed now and then). */
  async processingFiles(limit: number, uploadId?: number): Promise<string[]> {
    await this.ready();
    const { results } = await this.db
      .prepare(
        `SELECT file_id FROM catalogue_files WHERE status = 'processing' ${uploadId ? "AND upload_id = ?" : ""} ORDER BY created_at LIMIT ?`,
      )
      .bind(...(uploadId ? [uploadId] : []), limit)
      .all<{ file_id: string }>();
    return results.map((r) => r.file_id);
  }

  async setFileStatuses(updates: { fileId: string; status: PhotoInfo["status"]; url: string | null; error?: string | null }[]) {
    if (!updates.length) return;
    await this.db.batch(
      updates.map((u) =>
        this.db.prepare(`UPDATE catalogue_files SET status = ?, url = COALESCE(?, url), error = ? WHERE file_id = ?`).bind(u.status, u.url, u.error ?? null, u.fileId),
      ),
    );
  }

  /* ---------------------------------------------------------------- look-alike photos */

  /** Visual fingerprints of every stored photo (thumbnails are fetched separately, only when needed). */
  async signatures(): Promise<{ fileId: string; sig: string; pixels: number | null }[]> {
    await this.ready();
    const { results } = await this.db
      .prepare(`SELECT file_id, sig, pixels FROM catalogue_files WHERE status IN ('ready', 'processing') AND sig IS NOT NULL AND file_id LIKE 'gid:%'`)
      .all<{ file_id: string; sig: string; pixels: number | null }>();
    return results.map((r) => ({ fileId: r.file_id, sig: r.sig, pixels: r.pixels === null ? null : Number(r.pixels) }));
  }

  /** Ready photos with no fingerprint yet (from links, or stored before fingerprints existed). */
  async missingSignatures(limit: number): Promise<{ fileId: string; url: string }[]> {
    await this.ready();
    const { results } = await this.db
      .prepare(`SELECT file_id, url FROM catalogue_files WHERE status = 'ready' AND sig IS NULL AND url IS NOT NULL ORDER BY created_at LIMIT ?`)
      .bind(limit)
      .all<{ file_id: string; url: string }>();
    return results.map((r) => ({ fileId: r.file_id, url: r.url }));
  }

  async countMissingSignatures(): Promise<number> {
    await this.ready();
    const r = await this.db.prepare(`SELECT COUNT(*) AS n FROM catalogue_files WHERE status = 'ready' AND sig IS NULL AND url IS NOT NULL`).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async setSignatures(items: { fileId: string; sig: string; thumb: string; pixels: number }[]) {
    if (!items.length) return;
    await this.ready();
    await this.db.batch(
      items.map((i) => this.db.prepare(`UPDATE catalogue_files SET sig = ?, thumb = ?, pixels = ? WHERE file_id = ?`).bind(i.sig, i.thumb, i.pixels, i.fileId)),
    );
  }

  async thumbs(ids: string[]): Promise<Record<string, string>> {
    await this.ready();
    const out: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const part = ids.slice(i, i + IN_CHUNK);
      const { results } = await this.db
        .prepare(`SELECT file_id, thumb FROM catalogue_files WHERE thumb IS NOT NULL AND file_id IN (${part.map(() => "?").join(",")})`)
        .bind(...part)
        .all<{ file_id: string; thumb: string }>();
      for (const r of results) out[r.file_id] = r.thumb;
    }
    return out;
  }

  /**
   * Merge look-alike photos: everything that used `from` uses `to` instead, and `from` is retired (the caller
   * deletes it from Shopify Files). Products already in the store have their own copies, so they're unaffected.
   * Returns the photos actually merged.
   */
  async mergeFiles(pairs: { from: string; to: string }[]): Promise<string[]> {
    await this.ready();
    const ids = [...new Set(pairs.flatMap((p) => [p.from, p.to]))];
    const files = await this.filesById(ids);
    const merged: string[] = [];
    for (const { from, to } of pairs) {
      const a = files.get(from);
      const b = files.get(to);
      if (from === to || !a || !b || a.status === "deleted" || b.status === "deleted" || b.status === "failed") continue;
      await this.db.batch([
        // An item that already has `to` just loses `from`; the others switch over.
        this.db.prepare(`DELETE FROM catalogue_photos WHERE file_id = ? AND item_id IN (SELECT item_id FROM catalogue_photos WHERE file_id = ?)`).bind(from, to),
        this.db.prepare(`UPDATE catalogue_photos SET file_id = ? WHERE file_id = ?`).bind(to, from),
        this.db.prepare(`UPDATE catalogue_files SET status = 'deleted', merged_into = ? WHERE file_id = ?`).bind(to, from),
        // Anything merged into `from` earlier now points at `to`.
        this.db.prepare(`UPDATE catalogue_files SET merged_into = ? WHERE merged_into = ?`).bind(to, from),
      ]);
      files.set(from, { ...a, status: "deleted" });
      merged.push(from);
    }
    return merged;
  }

  /* ---------------------------------------------------------------- items */

  async addItems(code: string, items: CatalogueItemIn[]): Promise<number> {
    const up = await this.open(code);
    if (up.finished_at) throw new StoreError("This catalogue upload is already finished.", 409);
    let added = 0;
    for (const it of items) {
      const bc = analyzeBarcode(it.barcode);
      const ck = codeKey(it.code);
      if (!bc.key && !ck) continue; // nothing to match on
      const res = await this.db
        .prepare(
          `INSERT INTO catalogue_items (upload_id, supplier_key, barcode, barcode_key, code, code_key, title, description, mixed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(up.id, up.supplier_key, bc.key ? bc.digits : null, bc.key, it.code, ck, it.title, it.description, it.mixed ? 1 : 0)
        .run();
      const itemId = Number(res.meta.last_row_id);
      const photos = [...new Set(it.photos)].slice(0, MAX_PHOTOS_PER_ITEM);
      if (photos.length) {
        await this.db.batch(
          photos.map((fileId, position) =>
            this.db.prepare(`INSERT OR IGNORE INTO catalogue_photos (item_id, file_id, position) VALUES (?, ?, ?)`).bind(itemId, fileId, position),
          ),
        );
      }
      added++;
    }
    return added;
  }

  async finish(code: string): Promise<UploadSummary> {
    const up = await this.open(code);
    const items = await this.db.prepare(`SELECT COUNT(*) AS n FROM catalogue_items WHERE upload_id = ?`).bind(up.id).first<{ n: number }>();
    const photos = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT p.file_id) AS n FROM catalogue_photos p JOIN catalogue_items i ON i.id = p.item_id WHERE i.upload_id = ?`,
      )
      .bind(up.id)
      .first<{ n: number }>();
    await this.db
      .prepare(`UPDATE catalogue_uploads SET finished_at = COALESCE(finished_at, ?), item_count = ?, photo_count = ? WHERE id = ?`)
      .bind(now(), Number(items?.n ?? 0), Number(photos?.n ?? 0), up.id)
      .run();
    return toSummary((await this.row(code))!);
  }

  private async photosFor(itemIds: number[]): Promise<Map<number, PhotoInfo[]>> {
    const out = new Map<number, PhotoInfo[]>();
    for (let i = 0; i < itemIds.length; i += IN_CHUNK) {
      const part = itemIds.slice(i, i + IN_CHUNK);
      if (!part.length) continue;
      const { results } = await this.db
        .prepare(
          `SELECT p.item_id, p.file_id, f.status, f.url FROM catalogue_photos p LEFT JOIN catalogue_files f ON f.file_id = p.file_id
           WHERE p.item_id IN (${part.map(() => "?").join(",")}) ORDER BY p.item_id, p.position`,
        )
        .bind(...part)
        .all<{ item_id: number; file_id: string; status: PhotoInfo["status"] | null; url: string | null }>();
      for (const r of results) {
        const list = out.get(Number(r.item_id)) ?? [];
        list.push({ fileId: r.file_id, status: r.status ?? "deleted", url: r.url });
        out.set(Number(r.item_id), list);
      }
    }
    return out;
  }

  private toMatch(r: ItemRow, by: CatalogueMatch["by"], photos: PhotoInfo[]): CatalogueMatch {
    return {
      itemId: r.id,
      catalogue: r.code_upload,
      supplier: r.supplier,
      by,
      barcode: r.barcode,
      code: r.code,
      title: r.title,
      description: r.description,
      mixed: Boolean(r.mixed),
      photos: photos.filter((p) => p.status !== "deleted" && p.status !== "failed"),
    };
  }

  /**
   * Find catalogue entries for invoice lines. A barcode is the same product whoever sells it, so barcode
   * matches come from any supplier (this supplier's catalogue first). Supplier codes are only unique within
   * one supplier, so code matches only come from the invoice's own supplier.
   */
  async match(lines: { id: string; barcode: string | null; code: string | null }[], supplier: string | null): Promise<Record<string, CatalogueMatch>> {
    await this.ready();
    const sk = supplierMatchKey(supplier);
    const bKeys = [...new Set(lines.map((l) => analyzeBarcode(l.barcode).key).filter((k): k is string => !!k))];
    const cKeys = sk ? [...new Set(lines.map((l) => codeKey(l.code)).filter((k): k is string => !!k))] : [];
    const select = `SELECT i.*, u.code AS code_upload, u.supplier FROM catalogue_items i JOIN catalogue_uploads u ON u.id = i.upload_id
                    WHERE u.undone_at IS NULL AND u.finished_at IS NOT NULL`;
    const byBarcode = new Map<string, ItemRow>();
    for (let i = 0; i < bKeys.length; i += IN_CHUNK) {
      const part = bKeys.slice(i, i + IN_CHUNK);
      const { results } = await this.db
        .prepare(`${select} AND i.barcode_key IN (${part.map(() => "?").join(",")}) ORDER BY (i.supplier_key = ?) DESC, i.upload_id DESC, i.id`)
        .bind(...part, sk)
        .all<ItemRow>();
      for (const r of results) if (!byBarcode.has(r.barcode_key!)) byBarcode.set(r.barcode_key!, r);
    }
    const byCode = new Map<string, ItemRow>();
    for (let i = 0; i < cKeys.length; i += IN_CHUNK) {
      const part = cKeys.slice(i, i + IN_CHUNK);
      const { results } = await this.db
        .prepare(`${select} AND i.supplier_key = ? AND i.code_key IN (${part.map(() => "?").join(",")}) ORDER BY i.upload_id DESC, i.id`)
        .bind(sk, ...part)
        .all<ItemRow>();
      for (const r of results) if (!byCode.has(r.code_key!)) byCode.set(r.code_key!, r);
    }
    const found: { id: string; row: ItemRow; by: CatalogueMatch["by"] }[] = [];
    for (const l of lines) {
      const bk = analyzeBarcode(l.barcode).key;
      const ck = codeKey(l.code);
      const hit = bk ? byBarcode.get(bk) : undefined;
      if (hit) found.push({ id: l.id, row: hit, by: "barcode" });
      else if (ck && byCode.has(ck)) {
        const row = byCode.get(ck)!;
        // A code match whose catalogue barcode disagrees with the invoice's barcode is a different product.
        if (bk && row.barcode_key && row.barcode_key !== bk) continue;
        found.push({ id: l.id, row, by: "code" });
      }
    }
    const photos = await this.photosFor([...new Set(found.map((f) => f.row.id))]);
    return Object.fromEntries(found.map((f) => [f.id, this.toMatch(f.row, f.by, photos.get(f.row.id) ?? [])]));
  }

  /** Items of one upload, for its page. */
  async items(code: string, opts: { q?: string; offset?: number; limit?: number }) {
    await this.ready();
    const up = await this.row(code);
    if (!up) throw new StoreError("Catalogue upload not found.", 404);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const args: unknown[] = [up.id];
    let where = `i.upload_id = ?`;
    if (opts.q?.trim()) {
      const like = `%${opts.q.trim().toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where += ` AND (LOWER(COALESCE(i.title,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(i.code,'')) LIKE ? ESCAPE '\\' OR COALESCE(i.barcode,'') LIKE ? ESCAPE '\\')`;
      args.push(like, like, like);
    }
    const { results } = await this.db
      .prepare(`SELECT i.*, ? AS code_upload, ? AS supplier FROM catalogue_items i WHERE ${where} ORDER BY i.id LIMIT ? OFFSET ?`)
      .bind(up.code, up.supplier, ...args, limit + 1, Math.max(0, opts.offset ?? 0))
      .all<ItemRow>();
    const page = results.slice(0, limit);
    const photos = await this.photosFor(page.map((r) => r.id));
    return {
      items: page.map((r) => ({ ...this.toMatch(r, "barcode", []), photos: photos.get(r.id) ?? [] })),
      more: results.length > limit,
    };
  }

  /* ---------------------------------------------------------------- undo */

  /**
   * Undo an upload: it stops matching straight away, and its photos are queued for deletion from Shopify
   * Files. Photos that a newer, still-active upload also uses are handed over to that upload and kept.
   */
  async startUndo(code: string, user: string): Promise<number> {
    await this.ready();
    const up = await this.row(code);
    if (!up) throw new StoreError("Catalogue upload not found.", 404);
    if (!up.undone_at) {
      await this.db.prepare(`UPDATE catalogue_uploads SET undone_at = ?, undone_by = ? WHERE id = ?`).bind(now(), user, up.id).run();
    }
    const usedElsewhere = `SELECT MAX(i.upload_id) FROM catalogue_photos p JOIN catalogue_items i ON i.id = p.item_id
                            JOIN catalogue_uploads u ON u.id = i.upload_id
                            WHERE p.file_id = catalogue_files.file_id AND u.undone_at IS NULL`;
    await this.db
      .prepare(`UPDATE catalogue_files SET upload_id = (${usedElsewhere}) WHERE upload_id = ? AND status != 'deleted' AND (${usedElsewhere}) IS NOT NULL`)
      .bind(up.id)
      .run();
    return this.undoRemaining(up.id);
  }

  async undoRemaining(uploadId: number): Promise<number> {
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM catalogue_files WHERE upload_id = ? AND status != 'deleted' AND file_id LIKE 'gid:%'`)
      .bind(uploadId)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  /** The next photos to delete for an undone upload. */
  async undoBatch(code: string, limit: number): Promise<{ uploadId: number; fileIds: string[] }> {
    await this.ready();
    const up = await this.row(code);
    if (!up) throw new StoreError("Catalogue upload not found.", 404);
    if (!up.undone_at) throw new StoreError("Start the undo first.", 409);
    const { results } = await this.db
      .prepare(`SELECT file_id FROM catalogue_files WHERE upload_id = ? AND status != 'deleted' AND file_id LIKE 'gid:%' LIMIT ?`)
      .bind(up.id, limit)
      .all<{ file_id: string }>();
    return { uploadId: up.id, fileIds: results.map((r) => r.file_id) };
  }

  async markFilesDeleted(fileIds: string[]) {
    if (!fileIds.length) return;
    await this.db.batch(fileIds.map((id) => this.db.prepare(`UPDATE catalogue_files SET status = 'deleted' WHERE file_id = ?`).bind(id)));
  }

  /** Catalogue uploads (not undone) per supplier, keyed by supplierMatchKey. */
  async activeUploadsBySupplier(): Promise<Map<string, number>> {
    await this.ready();
    const { results } = await this.db
      .prepare(`SELECT supplier_key, COUNT(*) AS n FROM catalogue_uploads WHERE undone_at IS NULL AND finished_at IS NOT NULL GROUP BY supplier_key`)
      .all<{ supplier_key: string; n: number }>();
    return new Map(results.map((r) => [r.supplier_key, Number(r.n)]));
  }

  /** Catalogue entries for products already in the store (by barcode, or by SKU = supplier code + vendor). */
  async matchStoreProducts(products: { productId: string; barcode: string; sku: string; vendor: string }[]) {
    const out: Record<string, CatalogueMatch> = {};
    // Code matches need the supplier, so group by vendor.
    const byVendor = new Map<string, { id: string; barcode: string; code: string }[]>();
    for (const p of products) {
      const list = byVendor.get(p.vendor) ?? [];
      list.push({ id: p.productId, barcode: p.barcode, code: p.sku });
      byVendor.set(p.vendor, list);
    }
    for (const [vendor, list] of byVendor) Object.assign(out, await this.match(list, vendor || null));
    return out;
  }
}
