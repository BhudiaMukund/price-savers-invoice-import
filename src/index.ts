import { namedPhotos } from "./photo-names";
import { Hono } from "hono";
import { buildStoreIndex, classifyItems } from "./match";
import { BINARY_TYPES, ExtractionError, extractItems, type InvoicePayload, type PageRange } from "./extract";
import { mapInvoiceColumns } from "./invoice-map";
import { readTitleRequest, tidyTitles } from "./titles";
import {
  addSupplier,
  activateProducts,
  adjustStock,
  createProduct,
  listLocations,
  stockError,
  fetchStoreProducts,
  findVariantsByBarcodes,
  getShopContext,
  listSuppliers,
  removeSupplier,
  supplierDetails,
  ShopifyError,
  undoImport,
  type UndoResult,
} from "./shopify";
import { analyzeBarcode } from "./barcode";
import { requireAuth } from "./auth";
import type { Env, ExtractedItem } from "./types";
// Note: this is the Worker's main module, so it must only export the app (Cloudflare treats every
// other export as an entry point). Shared constants live in limits.ts.
import { CATALOGUE_LIMITS, IMPORT_ID_RE, MAX_CREATE_BATCH, MAX_UNDO_BATCH } from "./limits";
import { RUN_CODE_RE, RunStore, StoreError } from "./store";
import { catalogueRoutes, type AppEnv } from "./catalogue-routes";
import { CatalogueStore, FILE_ID_RE } from "./catalogue";
import { filesAccess } from "./files";
import { canManage, readSettings, writeSettings, admins } from "./settings";
import { supplierMatchKey } from "./catalogue";

const app = new Hono<AppEnv>();

// Every API route requires a valid Cloudflare Access sign-in.
app.use("/api/*", requireAuth);

/** Base64 of a ~7.5 MB file. The browser shrinks photos well below this. */
const MAX_BASE64_BYTES = 10 * 1024 * 1024;
/** CSV/Excel text. Invoices are far smaller than this. */
const MAX_TEXT_CHARS = 1_500_000;

const MAX_MATCH_ROWS = 2000;

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
});

type ClientItem = ExtractedItem & {
  vendor?: string | null;
  importId?: string | null;
  invoiceId?: string | null;
  /** Catalogue photos (Shopify file IDs), main photo first. */
  photos?: string[];
  description?: string | null;
  /** Whole units of stock the invoice line adds (null: not known). */
  qty?: number | null;
  /** Which invoice this is ("supplier|number"), so the same invoice can't add its stock twice. Empty without a number. */
  invoiceRef?: string;
};

/** What makes "this invoice adds stock to this product" the same thing twice. */
function stockKey(i: { invoiceRef?: string; importId?: string | null; barcode?: string | null; supplierCode?: string | null; title?: string }): string {
  const bc = analyzeBarcode(i.barcode).key;
  const who = bc ?? (i.supplierCode ? `code:${i.supplierCode}` : `title:${i.title ?? ""}`);
  return `${i.invoiceRef || i.importId || ""}|${who}`.toLowerCase().slice(0, 300);
}

function runStore(env: Env): RunStore | null {
  return env.DB ? new RunStore(env.DB) : null;
}

const NO_DB =
  "Run history isn't set up: the D1 database is missing. Create it with npx wrangler d1 create invoice-import-db, put its database_id in wrangler.toml, and deploy again.";



/** Coerce client-sent rows into the shape we expect; drop anything else. */
function readItems(body: unknown, max: number): ClientItem[] | null {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length > max) return null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : typeof v === "number" ? String(v) : "");
  return items.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      id: str(r.id, 64) || undefined,
      title: str(r.title, 255).replace(/\s+/g, " "),
      supplierCode: str(r.supplierCode, 64) || null,
      barcode: str(r.barcode, 64) || null,
      vendor: str(r.vendor, 100).replace(/\s+/g, " ") || null,
      importId: IMPORT_ID_RE.test(str(r.importId, 64)) ? str(r.importId, 64) : null,
      invoiceId: /^[A-Za-z0-9_-]{1,64}$/.test(str(r.invoiceId, 64)) ? str(r.invoiceId, 64) : null,
      photos: Array.isArray(r.photos) ? r.photos.filter((p): p is string => typeof p === "string" && FILE_ID_RE.test(p)).slice(0, 12) : [],
      description: typeof r.description === "string" ? r.description.trim().slice(0, 5000) || null : null,
      qty: Number.isInteger(r.qty) && (r.qty as number) >= 0 && (r.qty as number) <= 100_000 ? (r.qty as number) : null,
      invoiceRef: str(r.invoiceRef, 120),
    };
  });
}

function storeHandle(domain: string): string {
  return domain.replace(/\.myshopify\.com$/i, "");
}

/** Who is signed in and whether AI + Shopify are reachable, so the UI can say what works. */
app.get("/api/health", async (c) => {
  const env = c.env;
  const ai = Boolean(env.GEMINI_API_KEY);
  let shopify = false;
  let posChannel = false;
  let shopifyError: string | null = null;
  let filesError: string | null = null;
  if (!env.SHOPIFY_STORE_DOMAIN || /your-store/i.test(env.SHOPIFY_STORE_DOMAIN)) {
    shopifyError = "SHOPIFY_STORE_DOMAIN in wrangler.toml is still the placeholder. Set it to your store's .myshopify.com address and deploy again.";
  } else if (!env.SHOPIFY_ADMIN_TOKEN && (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET)) {
    shopifyError = "The Shopify app's client ID and secret aren't set. Add them with wrangler secret put SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.";
  } else {
    try {
      const ctx = await getShopContext(env);
      shopify = true;
      posChannel = ctx.posPublicationId !== null;
      filesError = await filesAccess(env);
    } catch (e) {
      console.error("health: shopify", e);
      shopifyError = e instanceof Error ? e.message : String(e);
    }
  }
  return c.json({
    user: c.get("user"),
    ai,
    shopify,
    shopifyError,
    posChannel,
    model: env.AI_MODEL,
    storeHandle: storeHandle(env.SHOPIFY_STORE_DOMAIN),
    runs: Boolean(env.DB),
    runsError: env.DB ? null : NO_DB,
    maxCreateBatch: MAX_CREATE_BATCH,
    maxUndoBatch: MAX_UNDO_BATCH,
    importTags: env.IMPORT_TAGS !== "false",
    files: shopify && !filesError,
    filesError,
    catalogueLimits: CATALOGUE_LIMITS,
    settings: await readSettings(env).catch(() => null),
    canManage: canManage(env, c.get("user")),
  });
});

/** Size of the live catalogue, for the "store checked" line in the UI. */
app.get("/api/store", async (c) => {
  const store = await fetchStoreProducts(c.env);
  return c.json({
    variants: store.length,
    withBarcode: store.filter((p) => analyzeBarcode(p.barcode).digits).length,
    checkedAt: new Date().toISOString(),
  });
});

async function matchAgainstStore(env: Env, items: ExtractedItem[]) {
  const store = await fetchStoreProducts(env);
  return {
    rows: classifyItems(items, buildStoreIndex(store)),
    store: { variants: store.length, checkedAt: new Date().toISOString() },
  };
}

/** CSV / Excel (converted in the browser) -> extracted rows matched against the live store. */
app.post("/api/extract", async (c) => {
  const body = await c.req.json<{ filename?: unknown; text?: unknown; part?: unknown }>().catch(() => null);
  const filename = typeof body?.filename === "string" ? body.filename.slice(0, 200) : "";
  const text = typeof body?.text === "string" ? body.text : "";
  const part = typeof body?.part === "string" && body.part.trim() ? body.part.slice(0, 300) : undefined;
  if (!filename || !text.trim()) return c.json({ error: "The file is empty." }, 400);
  if (text.length > MAX_TEXT_CHARS) return c.json({ error: "This spreadsheet is too large. Split it into smaller files." }, 413);
  return runExtraction(c.env, { kind: "text", filename, text, ...(part ? { part } : {}) }, attemptOf(c.req.header("X-AI-Attempt")));
});

/** Spreadsheet invoices: the first rows only, to work out which column is which. */
app.post("/api/invoice/map", async (c) => {
  const body = await c.req.json<{ sample?: unknown }>().catch(() => null);
  const sample = typeof body?.sample === "string" ? body.sample : "";
  if (!sample.trim()) return c.json({ error: "The spreadsheet is empty." }, 400);
  if (sample.length > 80_000) return c.json({ error: "Send only the first rows." }, 413);
  try {
    return c.json(await mapInvoiceColumns(c.env, sample, attemptOf(c.req.header("X-AI-Attempt"))));
  } catch (e) {
    if (e instanceof ExtractionError) return c.json({ error: e.message, retryable: e.retryable, code: e.code }, 422);
    throw e;
  }
});

/** Tidy a batch of titles. Only titles that pass every check come back; the rest are listed as rejected. */
app.post("/api/titles", async (c) => {
  const req = readTitleRequest(await c.req.json().catch(() => null));
  if ("error" in req) return c.json({ error: req.error }, 400);
  try {
    return c.json(await tidyTitles(c.env, req.items, req.supplier, attemptOf(c.req.header("X-AI-Attempt"))));
  } catch (e) {
    if (e instanceof ExtractionError) return c.json({ error: e.message, retryable: e.retryable, code: e.code }, 422);
    throw e;
  }
});

/**
 * PDF / photo: the body is the file as base64 text, streamed straight to the AI without parsing.
 * Headers: X-File-Name (URI-encoded), X-File-Type (MIME type), Content-Length (required).
 */
app.post("/api/extract-file", async (c) => {
  const filename = decodeURIComponent(c.req.header("X-File-Name") ?? "").slice(0, 200) || "invoice";
  const mimeType = (c.req.header("X-File-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  const length = Number(c.req.header("Content-Length") ?? NaN);
  if (!BINARY_TYPES.has(mimeType)) {
    return c.json({ error: "This file type can't be read. Use a PDF, a photo (JPG, PNG, WebP, HEIC), Excel or CSV." }, 415);
  }
  if (!Number.isFinite(length) || length <= 0) return c.json({ error: "The file is empty." }, 411);
  if (length > MAX_BASE64_BYTES) return c.json({ error: "This file is too large. Keep PDFs under 7 MB or split them." }, 413);
  const pages = pagesOf(c.req.header("X-Pages"));
  if (pages === "bad") return c.json({ error: "Pages must look like 3-4." }, 400);
  const stream = c.req.raw.body;
  if (!stream) return c.json({ error: "The file is empty." }, 400);
  return runExtraction(c.env, { kind: "base64", filename, mimeType, stream, length }, attemptOf(c.req.header("X-AI-Attempt")), pages ?? undefined);
});

const attemptOf = (h: string | undefined) => Math.min(5, Math.max(1, Number.parseInt(h ?? "1", 10) || 1));

/** "3-4" -> pages 3 to 4. Undefined when not sent. */
function pagesOf(h: string | undefined): PageRange | null | "bad" {
  if (!h) return null;
  const m = /^(\d{1,4})-(\d{1,4})$/.exec(h.trim());
  if (!m) return "bad";
  const from = Number(m[1]);
  const to = Number(m[2]);
  return from >= 1 && to >= from && to - from < 50 ? { from, to } : "bad";
}

async function runExtraction(env: Env, payload: InvoicePayload, attempt = 1, pages?: PageRange) {
  let extracted: Awaited<ReturnType<typeof extractItems>>;
  try {
    extracted = await extractItems(env, payload, attempt, pages);
  } catch (e) {
    if (e instanceof ExtractionError) {
      return Response.json({ error: e.message, fallback: "manual", retryable: e.retryable, code: e.code }, { status: 422 });
    }
    throw e;
  }
  return Response.json({
    ...(await matchAgainstStore(env, extracted.items)),
    invoice: extracted.invoice,
    pageCount: extracted.pageCount,
    model: extracted.model,
  });
}

/** Re-check rows against the full live catalogue (after edits, manual rows, or a refresh). */
app.post("/api/match", async (c) => {
  const items = readItems(await c.req.json().catch(() => null), MAX_MATCH_ROWS);
  if (!items) return c.json({ error: `Send between 0 and ${MAX_MATCH_ROWS} rows.` }, 400);
  return c.json(await matchAgainstStore(c.env, items));
});

/** Quick check of a few edited barcodes against the store (no full catalogue fetch). */
app.post("/api/lookup", async (c) => {
  const items = readItems(await c.req.json().catch(() => null), 50);
  if (!items) return c.json({ error: "Send at most 50 rows at a time." }, 400);
  const existing = await findVariantsByBarcodes(c.env, items.map((i) => i.barcode));
  return c.json({ rows: classifyItems(items, buildStoreIndex(existing)) });
});

/** Create a small batch. Re-checks these barcodes against the store first so nothing is created twice. */
app.post("/api/create", async (c) => {
  const body = await c.req.json().catch(() => null);
  const items = readItems(body, MAX_CREATE_BATCH);
  if (!items) return c.json({ error: `Send at most ${MAX_CREATE_BATCH} rows at a time.` }, 400);
  if (items.length === 0) return c.json({ error: "Nothing to create." }, 400);

  // Every product must belong to a run and an invoice, so it can be traced and undone later.
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const runCode = typeof (body as { runCode?: unknown })?.runCode === "string" ? (body as { runCode: string }).runCode : "";
  const runId = RUN_CODE_RE.test(runCode) ? await store.runId(runCode) : null;
  if (!runId) return c.json({ error: "This run wasn't found. Reload the page." }, 400);
  for (const i of items) {
    if (!i.invoiceId || !i.importId || !i.importId.includes(`-${runCode}-`)) {
      return c.json({ error: "Each product needs its invoice and an import ID from this run. Reload the page and try again." }, 400);
    }
  }

  const existing = await findVariantsByBarcodes(c.env, items.map((i) => i.barcode));
  const rows = classifyItems(items, buildStoreIndex(existing));
  const ctx = await getShopContext(c.env);
  const settings = await readSettings(c.env);
  // Chosen for this run on the import screen (on by default there), not a shared setting.
  const updateStock = (body as { stock?: unknown })?.stock === true;
  const stockLocationId = settings.stockLocationId || ctx.locationId;
  const stockLedger: Parameters<RunStore["claimStock"]>[0] = [];
  // Catalogue photos: only ones Shopify has finished processing (they have a CDN address).
  const photoIds = [...new Set(items.flatMap((i) => i.photos ?? []))];
  const files = photoIds.length ? await new CatalogueStore(c.env.DB!).filesById(photoIds) : new Map();

  const results = [];
  const ledger: Parameters<RunStore["recordProducts"]>[0] = [];
  const attachments: Parameters<CatalogueStore["recordAttachments"]>[0] = [];
  for (const row of rows) {
    if (!row.title) {
      results.push({ id: row.id, status: "failed" as const, error: "Add a title first." });
      continue;
    }
    if (row.match === "exists") {
      results.push({ id: row.id, status: "skipped" as const, reason: "exists" as const, existing: row.existing });
      continue;
    }
    if (row.match === "duplicate_in_invoice") {
      results.push({ id: row.id, status: "skipped" as const, reason: "duplicate" as const });
      continue;
    }
    if (row.barcodeStatus === "invalid_check_digit" || row.barcodeStatus === "invalid_format") {
      results.push({ id: row.id, status: "failed" as const, error: "The barcode doesn't look right. Fix it or clear it." });
      continue;
    }
    const barcode = analyzeBarcode(row.barcode).digits;
    const src = items.find((i) => i.id === row.id) ?? items[rows.indexOf(row)];
    const usedPhotos = (src?.photos ?? []).map((id) => files.get(id)).filter((f): f is NonNullable<typeof f> => !!f && f.status === "ready" && !!f.url);
    const r = await createProduct(c.env, ctx, {
      title: row.title,
      barcode,
      sku: row.supplierCode,
      vendor: src?.vendor ?? null,
      importId: src?.importId ?? null,
      runCode,
      photos: namedPhotos(row.title, usedPhotos.map((f) => f.url!)),
      description: src?.description ?? null,
      tags: settings.importTags,
      stock: updateStock && src?.qty && src.qty > 0 ? { quantity: src.qty, locationId: stockLocationId } : undefined,
    });
    if (r.ok && updateStock && src?.qty && src.qty > 0) {
      stockLedger.push({ key: stockKey({ ...src, barcode, title: row.title }), runId, importId: src.importId!, productId: r.productId, barcode, qty: src.qty, locationId: stockLocationId, kind: "created" });
    }
    if (r.ok && r.photos) {
      attachments.push(...usedPhotos.slice(0, r.photos).map((f, k) => ({ productId: r.productId, title: row.title, mediaId: r.mediaIds[k] ?? null, fileId: f.fileId, source: "invoice" as const })));
    }
    if (r.ok) {
      ledger.push({
        productId: r.productId,
        runId,
        invoiceId: src!.invoiceId!,
        importId: src!.importId!,
        title: row.title,
        barcode,
        vendor: src?.vendor ?? null,
      });
    }
    results.push(
      r.ok
        ? { id: row.id, status: "created" as const, productId: r.productId, publishedToPos: r.published, photos: r.photos, photoError: r.photoError, stock: updateStock ? (src?.qty ?? 0) : 0 }
        : { id: row.id, status: "failed" as const, error: r.error },
    );
  }

  // Record what was created. If this fails the products still exist, so say so loudly.
  let ledgerError: string | null = null;
  try {
    await new CatalogueStore(c.env.DB!).recordAttachments(attachments, c.get("user"));
  } catch (e) {
    console.error("record attachments", e); // only affects the "photos in use" warning later
  }
  try {
    await store.claimStock(stockLedger, c.get("user")); // only a record: the stock went in with the product
  } catch (e) {
    console.error("stock ledger", e);
  }
  try {
    await store.recordProducts(ledger, c.get("user"));
  } catch (e) {
    console.error("ledger", e);
    ledgerError = "The products were added, but the import record couldn't be saved. Note the import ID before leaving this page.";
  }
  return c.json({ results, posChannelFound: ctx.posPublicationId !== null, ledgerError });
});


/** The store's stock locations, for choosing where invoice quantities go. */
app.get("/api/locations", async (c) => {
  try {
    return c.json({ locations: await listLocations(c.env) });
  } catch (e) {
    return c.json({ error: stockError(e) }, 502);
  }
});

/**
 * Add invoice quantities to products already in the store. Each line first claims "this invoice adds this
 * stock to this product", so pressing the button twice, or importing the same invoice again, can't count it twice.
 */
app.post("/api/stock", async (c) => {
  const body = await c.req.json().catch(() => null);
  const items = readItems(body, MAX_CREATE_BATCH);
  if (!items || !items.length) return c.json({ error: `Send between 1 and ${MAX_CREATE_BATCH} rows at a time.` }, 400);
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const settings = await readSettings(c.env);
  const runCode = typeof (body as { runCode?: unknown })?.runCode === "string" ? (body as { runCode: string }).runCode : "";
  const runId = RUN_CODE_RE.test(runCode) ? await store.runId(runCode) : null;
  if (!runId) return c.json({ error: "This run wasn't found. Reload the page." }, 400);
  const rawItems = ((body as { items?: unknown[] }).items ?? []) as Record<string, unknown>[];
  const locationId = settings.stockLocationId || (await getShopContext(c.env)).locationId;

  const results: { id: string; status: "added" | "skipped" | "failed"; error?: string; reason?: string; qty?: number }[] = [];
  const todo: { item: (typeof items)[number]; productId: string; key: string }[] = [];
  items.forEach((it, i) => {
    const id = it.id ?? `row-${i}`;
    const productId = typeof rawItems[i]?.productId === "string" ? (rawItems[i]!.productId as string) : "";
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) return void results.push({ id, status: "failed", error: "That product wasn't found in the store." });
    if (!it.qty || it.qty <= 0) return void results.push({ id, status: "skipped", reason: "no_quantity" });
    if (!it.importId || !it.invoiceId || !it.importId.includes(`-${runCode}-`)) return void results.push({ id, status: "failed", error: "Reload the page and try again." });
    todo.push({ item: { ...it, id }, productId, key: stockKey(it) });
  });

  const free = await store.claimStock(
    todo.map((t) => ({ key: t.key, runId, importId: t.item.importId!, productId: t.productId, barcode: analyzeBarcode(t.item.barcode).digits, qty: t.item.qty!, locationId, kind: "added" as const })),
    c.get("user"),
  );
  const go = todo.filter((t) => {
    if (free.has(t.key)) return true;
    results.push({ id: t.item.id!, status: "skipped", reason: "already_added" });
    return false;
  });
  if (go.length) {
    let outcome;
    try {
      outcome = await adjustStock(c.env, locationId, go.map((t) => ({ productId: t.productId, barcode: t.item.barcode ?? null, qty: t.item.qty! })));
    } catch (e) {
      outcome = go.map(() => ({ ok: false as const, error: stockError(e) }));
    }
    const failed: string[] = [];
    go.forEach((t, k) => {
      const o = outcome[k]!;
      if (o.ok) results.push({ id: t.item.id!, status: "added", qty: t.item.qty! });
      else {
        failed.push(t.key);
        results.push({ id: t.item.id!, status: "failed", error: o.error });
      }
    });
    await store.releaseStock(failed).catch((e) => console.error("release stock", e));
  }
  return c.json({ results });
});

/**
 * Products already in the store as DRAFT are made active (and put on Point of Sale) when their invoice line is
 * imported, whether or not the run updates stock. Only drafts change; see activateProducts.
 */
app.post("/api/activate", async (c) => {
  const body = await c.req.json<{ items?: unknown }>().catch(() => null);
  const raw = Array.isArray(body?.items) ? (body!.items as Record<string, unknown>[]) : [];
  if (!raw.length || raw.length > MAX_CREATE_BATCH) return c.json({ error: `Send between 1 and ${MAX_CREATE_BATCH} products at a time.` }, 400);
  const results: { id: string; status: "activated" | "skipped" | "failed"; error?: string; published?: boolean }[] = [];
  const todo: { id: string; productId: string }[] = [];
  raw.forEach((it, i) => {
    const id = typeof it?.id === "string" && it.id ? it.id.slice(0, 64) : `row-${i}`;
    const productId = typeof it?.productId === "string" ? it.productId : "";
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) results.push({ id, status: "failed", error: "That product wasn't found in the store." });
    else todo.push({ id, productId });
  });
  if (todo.length) {
    try {
      const ctx = await getShopContext(c.env);
      const out = await activateProducts(c.env, ctx, todo.map((t) => t.productId));
      todo.forEach((t, i) => {
        const r = out[i]!;
        results.push(!r.ok ? { id: t.id, status: "failed", error: r.error } : r.activated ? { id: t.id, status: "activated", published: r.published } : { id: t.id, status: "skipped" });
      });
    } catch (e) {
      for (const t of todo) results.push({ id: t.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({ results });
});

/** Take back stock an import added to products that were already in the store (part of undoing an import). */
app.post("/api/stock/undo", async (c) => {
  const body = await c.req.json<{ importId?: unknown; productIds?: unknown }>().catch(() => null);
  const importId = typeof body?.importId === "string" ? body.importId : "";
  const ids = Array.isArray(body?.productIds) ? body.productIds.filter((x): x is string => typeof x === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(x)) : [];
  if (!IMPORT_ID_RE.test(importId)) return c.json({ error: "That import ID isn't valid." }, 400);
  if (!ids.length || ids.length > MAX_CREATE_BATCH) return c.json({ error: `Send between 1 and ${MAX_CREATE_BATCH} products at a time.` }, 400);
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const rows = await store.stockAddedByImport(importId, ids);
  const results: { id: string; status: "removed" | "kept" | "failed"; error?: string; qty?: number }[] = ids.filter((id) => !rows.some((r) => r.productId === id)).map((id) => ({ id, status: "kept" as const }));
  const byLocation = new Map<string, typeof rows>();
  for (const r of rows) byLocation.set(r.locationId, [...(byLocation.get(r.locationId) ?? []), r]);
  const undone: number[] = [];
  for (const [locationId, group] of byLocation) {
    let outcome;
    try {
      outcome = await adjustStock(c.env, locationId, group.map((r) => ({ productId: r.productId, barcode: null, qty: -r.qty })), "correction");
    } catch (e) {
      outcome = group.map(() => ({ ok: false as const, error: stockError(e) }));
    }
    group.forEach((r, k) => {
      const o = outcome[k]!;
      if (o.ok) {
        undone.push(r.id);
        results.push({ id: r.productId, status: "removed", qty: r.qty });
      } else results.push({ id: r.productId, status: "failed", error: o.error });
    });
  }
  await store.markStockUndone(undone).catch((e) => console.error("stock undo ledger", e));
  return c.json({ results });
});

/** Suppliers to choose from: every vendor already in the store, plus ones added here. */
app.get("/api/suppliers", async (c) => c.json({ suppliers: await listSuppliers(c.env) }));

app.post("/api/suppliers", async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name : "";
  try {
    return c.json({ suppliers: await addSupplier(c.env, name) });
  } catch (e) {
    if (e instanceof ShopifyError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * Undo an import: delete its products. Only products whose import_source holds this import ID and whose
 * price is still $0.00 are deleted; anything already priced is kept.
 */
app.post("/api/undo", async (c) => {
  const body = await c.req.json<{ importId?: unknown; productIds?: unknown }>().catch(() => null);
  const importId = typeof body?.importId === "string" ? body.importId : "";
  const ids = Array.isArray(body?.productIds) ? body.productIds.filter((x): x is string => typeof x === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(x)) : [];
  if (!IMPORT_ID_RE.test(importId)) return c.json({ error: "That import ID isn't valid." }, 400);
  if (!ids.length || ids.length > MAX_UNDO_BATCH) return c.json({ error: `Send between 1 and ${MAX_UNDO_BATCH} products at a time.` }, 400);
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);

  // Only products the ledger says this import created (and that are still there) can be deleted.
  const known = await store.liveInImport(importId, ids);
  const results: UndoResult[] = ids.filter((id) => !known.has(id)).map((id) => ({ id, status: "kept", reason: "not_this_import" }));
  if (known.size) results.push(...(await undoImport(c.env, importId, [...known])));
  const gone = results.filter((r) => r.status === "deleted" || (r.status === "kept" && r.reason === "gone")).map((r) => r.id);
  await store.markDeleted(gone, c.get("user"));
  await new CatalogueStore(c.env.DB!).markProductsGone(gone, c.get("user")).catch((e) => console.error("photos ledger", e));
  const order = new Map(ids.map((id, i) => [id, i]));
  results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return c.json({ results });
});

/* ------------------------------------------------------------------ settings */

app.get("/api/settings", async (c) =>
  c.json({ settings: await readSettings(c.env), canManage: canManage(c.env, c.get("user")), adminsSet: admins(c.env).length > 0 }),
);

app.put("/api/settings", async (c) => {
  if (!canManage(c.env, c.get("user"))) return c.json({ error: "Only the people listed in ADMIN_EMAILS can change settings." }, 403);
  if (!c.env.DB) return c.json({ error: NO_DB }, 503);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Nothing to save." }, 400);
  try {
    await writeSettings(c.env.DB, body, c.get("user"));
    return c.json({ settings: await readSettings(c.env) });
  } catch (e) {
    return storeErrorResponse(e);
  }
});

/** Every supplier with how it's used: products in the store, active catalogues, saved here. */
app.get("/api/suppliers/details", async (c) => {
  const list = await supplierDetails(c.env);
  const cats = c.env.DB ? await new CatalogueStore(c.env.DB).activeUploadsBySupplier() : new Map<string, number>();
  return c.json({
    suppliers: list.map((s) => ({ ...s, catalogues: cats.get(supplierMatchKey(s.name)) ?? 0 })),
    canManage: canManage(c.env, c.get("user")),
  });
});

/** Delete a supplier that no store product and no active catalogue uses. */
app.delete("/api/suppliers", async (c) => {
  if (!canManage(c.env, c.get("user"))) return c.json({ error: "Only the people listed in ADMIN_EMAILS can delete suppliers." }, 403);
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "Which supplier?" }, 400);
  const cats = c.env.DB ? (await new CatalogueStore(c.env.DB).activeUploadsBySupplier()).get(supplierMatchKey(name)) ?? 0 : 0;
  if (cats) {
    return c.json({ error: `${name} has ${cats === 1 ? "a catalogue" : `${cats} catalogues`}. Undo ${cats === 1 ? "it" : "them"} on the Catalogues page first.` }, 409);
  }
  try {
    return c.json({ suppliers: await removeSupplier(c.env, name) });
  } catch (e) {
    if (e instanceof ShopifyError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

/* ------------------------------------------------------------------ runs */

function storeErrorResponse(e: unknown) {
  if (e instanceof StoreError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  throw e;
}

app.get("/api/runs", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const q = (c.req.query("q") ?? "").slice(0, 100);
  const mine = c.req.query("mine") === "1";
  const before = Number(c.req.query("before")) || undefined;
  const limit = Number(c.req.query("limit")) || 30;
  return c.json(await store.listRuns({ q, createdBy: mine ? c.get("user") : undefined, before, limit }));
});

app.post("/api/runs", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  return c.json({ run: await store.createRun(c.get("user")) }, 201);
});

app.get("/api/runs/:code", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const run = await store.getRunText(c.req.param("code"));
  if (!run) return c.json({ error: "Run not found." }, 404);
  // The saved data goes back as stored: no parsing and re-writing of a big run.
  const head = JSON.stringify({ run: run.detail });
  return new Response(`${head.slice(0, -2)},"data":${run.dataText}}}`, { headers: { "Content-Type": "application/json; charset=UTF-8" } });
});

app.put("/api/runs/:code", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  // The page sends {"version":N,"data":{...}}. Take the data as text, so it's parsed once (in saveRun), not
  // parsed, written out and parsed again: a big run would use up the free plan's CPU allowance.
  const raw = await c.req.text().catch(() => "");
  const m = /^\s*\{\s*"version"\s*:\s*(\d{1,9})\s*,\s*"data"\s*:/.exec(raw);
  const end = raw.lastIndexOf("}");
  const version = Number(m?.[1]);
  if (!m || !Number.isInteger(version) || version < 1 || end <= m[0].length) return c.json({ error: "Nothing to save." }, 400);
  try {
    return c.json(await store.saveRun(c.req.param("code"), version, raw.slice(m[0].length, end).trim(), c.get("user")));
  } catch (e) {
    return storeErrorResponse(e);
  }
});

app.delete("/api/runs/:code", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  try {
    await store.deleteRun(c.req.param("code"));
    return c.json({ ok: true });
  } catch (e) {
    return storeErrorResponse(e);
  }
});

catalogueRoutes(app);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default app;
