import { Hono } from "hono";
import { buildStoreIndex, classifyItems } from "./match";
import { BINARY_TYPES, ExtractionError, extractItems, type InvoicePayload } from "./extract";
import {
  addSupplier,
  createProduct,
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
};

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
  const body = await c.req.json<{ filename?: unknown; text?: unknown }>().catch(() => null);
  const filename = typeof body?.filename === "string" ? body.filename.slice(0, 200) : "";
  const text = typeof body?.text === "string" ? body.text : "";
  if (!filename || !text.trim()) return c.json({ error: "The file is empty." }, 400);
  if (text.length > MAX_TEXT_CHARS) return c.json({ error: "This spreadsheet is too large. Split it into smaller files." }, 413);
  return runExtraction(c.env, { kind: "text", filename, text }, attemptOf(c.req.header("X-AI-Attempt")));
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
  const stream = c.req.raw.body;
  if (!stream) return c.json({ error: "The file is empty." }, 400);
  return runExtraction(c.env, { kind: "base64", filename, mimeType, stream, length }, attemptOf(c.req.header("X-AI-Attempt")));
});

const attemptOf = (h: string | undefined) => Math.min(5, Math.max(1, Number.parseInt(h ?? "1", 10) || 1));

async function runExtraction(env: Env, payload: InvoicePayload, attempt = 1) {
  let extracted: Awaited<ReturnType<typeof extractItems>>;
  try {
    extracted = await extractItems(env, payload, attempt);
  } catch (e) {
    if (e instanceof ExtractionError) {
      return Response.json({ error: e.message, fallback: "manual", retryable: e.retryable }, { status: 422 });
    }
    throw e;
  }
  return Response.json({ ...(await matchAgainstStore(env, extracted.items)), invoice: extracted.invoice, model: extracted.model });
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
  // Catalogue photos: only ones Shopify has finished processing (they have a CDN address).
  const photoIds = [...new Set(items.flatMap((i) => i.photos ?? []))];
  const files = photoIds.length ? await new CatalogueStore(c.env.DB!).filesById(photoIds) : new Map();

  const results = [];
  const ledger: Parameters<RunStore["recordProducts"]>[0] = [];
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
    const r = await createProduct(c.env, ctx, {
      title: row.title,
      barcode,
      sku: row.supplierCode,
      vendor: src?.vendor ?? null,
      importId: src?.importId ?? null,
      runCode,
      photos: (src?.photos ?? [])
        .map((id) => files.get(id))
        .filter((f) => f && f.status === "ready" && f.url)
        .map((f) => ({ url: f!.url!, alt: row.title })),
      description: src?.description ?? null,
      tags: settings.importTags,
    });
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
        ? { id: row.id, status: "created" as const, productId: r.productId, publishedToPos: r.published, photos: r.photos, photoError: r.photoError }
        : { id: row.id, status: "failed" as const, error: r.error },
    );
  }

  // Record what was created. If this fails the products still exist, so say so loudly.
  let ledgerError: string | null = null;
  try {
    await store.recordProducts(ledger, c.get("user"));
  } catch (e) {
    console.error("ledger", e);
    ledgerError = "The products were added, but the import record couldn't be saved. Note the import ID before leaving this page.";
  }
  return c.json({ results, posChannelFound: ctx.posPublicationId !== null, ledgerError });
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
  const run = await store.getRun(c.req.param("code"));
  return run ? c.json({ run }) : c.json({ error: "Run not found." }, 404);
});

app.put("/api/runs/:code", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const body = await c.req.json<{ version?: unknown; data?: unknown }>().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1 || body?.data === undefined) return c.json({ error: "Nothing to save." }, 400);
  try {
    return c.json(await store.saveRun(c.req.param("code"), version, JSON.stringify(body.data), c.get("user")));
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
