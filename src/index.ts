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
  countVariants,
  findVariantsByBarcodes,
  getShopContext,
  listSuppliers,
  productsPresent,
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
import { MAX_PRICE_BATCH, fetchPrices, normalisePrice, setPrices } from "./pricing";
import { canManage, readSettings, writeSettings, admins } from "./settings";
import { AIR_TYPE, BALLOON_TYPE, BUNDLE_TYPE, dropBundle, findInflation, linkBundle, repriceStoreBundles, syncBalloons, titlesInStore, type Inflation } from "./helium";
// @ts-expect-error plain JS module shared with the browser
import { bundlePrice, bundleTitle, FOIL_WEIGHT_KG, NUMBER_TAG, numberDigit, withoutPack } from "../public/js/helium.js";
import { BUNDLE_WEIGHT } from "./limits";
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
  /** Price including GST ("4.95"), or null to add the product at $0.00. */
  price?: string | null;
  /** Which invoice this is ("supplier|number"), so the same invoice can't add its stock twice. Empty without a number. */
  invoiceRef?: string;
  /** A foil balloon: posted online once priced, typed "Foil Balloons". */
  foil?: boolean;
  /** Make a helium bundle with this size of the Helium Inflation product (its variant ID). */
  helium?: string | null;
  /** A foil balloon filled with air (staff unticked the bundle, or it's under 40cm): typed "Air Foil Balloon". */
  air?: boolean;
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



const VARIANT_ID_RE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** Coerce client-sent rows into the shape we expect; drop anything else. */
function readItems(body: unknown, max: number): ClientItem[] | null {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length > max) return null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : typeof v === "number" ? String(v) : "");
  return items.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const title = str(r.title, 255).replace(/\s+/g, " ");
    return {
      id: str(r.id, 64) || undefined,
      // Foil balloons are sold singly: supplier pack wording ("Pack of 5") never goes in their title.
      title: r.foil === true ? withoutPack(title) || title : title,
      supplierCode: str(r.supplierCode, 64) || null,
      barcode: str(r.barcode, 64) || null,
      vendor: str(r.vendor, 100).replace(/\s+/g, " ") || null,
      importId: IMPORT_ID_RE.test(str(r.importId, 64)) ? str(r.importId, 64) : null,
      invoiceId: /^[A-Za-z0-9_-]{1,64}$/.test(str(r.invoiceId, 64)) ? str(r.invoiceId, 64) : null,
      photos: Array.isArray(r.photos) ? r.photos.filter((p): p is string => typeof p === "string" && FILE_ID_RE.test(p)).slice(0, 12) : [],
      description: typeof r.description === "string" ? r.description.trim().slice(0, 5000) || null : null,
      qty: Number.isInteger(r.qty) && (r.qty as number) >= 0 && (r.qty as number) <= 100_000 ? (r.qty as number) : null,
      invoiceRef: str(r.invoiceRef, 120),
      price: normalisePrice(r.price),
      foil: r.foil === true,
      helium: typeof r.helium === "string" && VARIANT_ID_RE.test(r.helium) ? r.helium : null,
      air: r.air === true,
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
    bundleWeight: BUNDLE_WEIGHT,
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
  // One count, not the whole catalogue: paging through every variant needs a request per 250 of them, and
  // the free Workers plan stops a call at 50 requests.
  return c.json({ variants: await countVariants(c.env), checkedAt: new Date().toISOString() });
});

async function matchAgainstStore(env: Env, items: ExtractedItem[]) {
  // Look up only the barcodes on this invoice. Reading the whole catalogue costs a request per 250 variants and
  // breaks once the store is big (Workers free plan: 50 requests per call).
  const found = await findVariantsByBarcodes(env, items.map((i) => i.barcode));
  return {
    rows: classifyItems(items, buildStoreIndex(found)),
    store: { variants: await countVariants(env), checkedAt: new Date().toISOString() },
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
  const bundled = items.filter((i) => i.helium).length;
  if (items.length + bundled * (BUNDLE_WEIGHT - 1) > MAX_CREATE_BATCH) {
    return c.json({ error: `Too many helium bundles in one go. Send at most ${Math.floor(MAX_CREATE_BATCH / BUNDLE_WEIGHT)} balloons with bundles at a time.` }, 400);
  }

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

  // Helium bundles: the inflation sizes (read live, for their prices) and which bundle titles already exist.
  let inflation: Inflation | null = null;
  let takenTitles = new Set<string>();
  const wantBundles = rows.filter((r) => r.match !== "exists" && r.match !== "duplicate_in_invoice" && r.title && (items.find((i) => i.id === r.id) ?? items[rows.indexOf(r)])?.helium);
  if (wantBundles.length) {
    try {
      inflation = await findInflation(c.env);
      takenTitles = await titlesInStore(c.env, wantBundles.map((r) => bundleTitle(r.title) as string));
    } catch (e) {
      console.error("helium", e);
    }
  }
  const balloons: Parameters<RunStore["recordBalloons"]>[0] = [];

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
    // Air-filled foils (no bundle) are their own type, so the store doesn't offer them inflated.
    const air = !!(src?.foil && src.air && !src.helium);
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
      price: src?.price ?? undefined,
      stock: updateStock && src?.qty && src.qty > 0 ? { quantity: src.qty, locationId: stockLocationId } : undefined,
      // A foil balloon can be posted, and goes on every channel once it has a price (POS only while at $0).
      ...(src?.foil ? { productType: air ? AIR_TYPE : BALLOON_TYPE, requiresShipping: true, online: !!src.price, weightKg: FOIL_WEIGHT_KG } : {}),
    });
    let bundle: { status: "created"; productId: string } | { status: "skipped"; reason: string } | { status: "failed"; error: string } | undefined;
    let bundleRow: { bundleId: string; bundleVariantId: string; tierVariantId: string } | null = null;
    if (r.ok && src?.helium) {
      const tier = inflation?.tiers.find((t) => t.variantId === src.helium);
      const title: string = bundleTitle(row.title);
      if (!inflation) bundle = { status: "failed", error: "The Helium Inflation product wasn't found in Shopify, so no bundle was made." };
      else if (!tier) bundle = { status: "failed", error: "That helium size isn't on the Helium Inflation product any more. Reload the page." };
      else if (takenTitles.has(title)) bundle = { status: "skipped", reason: `“${title}” is already in the store.` };
      else if (!r.variantId) bundle = { status: "failed", error: "Shopify didn't return the balloon's variant." };
      else {
        const b = await createProduct(c.env, ctx, {
          title,
          barcode: null,
          sku: null,
          vendor: src.vendor ?? null,
          importId: src.importId ?? null,
          runCode,
          photos: namedPhotos(title, usedPhotos.map((f) => f.url!)),
          description: src.description ?? null,
          tags: settings.importTags,
          // Waits as a $0 draft until the balloon is priced: then it's balloon + inflation and goes live.
          price: src.price ? bundlePrice(src.price, tier.price) : "0.00",
          status: src.price ? "ACTIVE" : "DRAFT",
          online: true,
          productType: BUNDLE_TYPE,
          // Collected in store only: an inflated balloon can't be posted.
          requiresShipping: false,
          bundle: true,
          // The storefront's "Helium Inflated Numbers" collection and age finder group number balloons by this tag.
          extraTags: numberDigit(row.title) != null ? [NUMBER_TAG] : [],
        });
        if (!b.ok || !b.variantId) bundle = { status: "failed", error: b.ok ? "Shopify didn't return the bundle's variant." : b.error };
        else {
          const linkError = await linkBundle(c.env, b.variantId, r.variantId, tier.variantId);
          if (linkError) {
            // A bundle with no parts would sell nothing but helium: take it out again.
            await dropBundle(c.env, b.productId).catch((e) => console.error("drop bundle", e));
            bundle = { status: "failed", error: `The bundle couldn't be linked to the balloon: ${linkError}` };
          } else {
            bundle = { status: "created", productId: b.productId };
            bundleRow = { bundleId: b.productId, bundleVariantId: b.variantId, tierVariantId: tier.variantId };
            takenTitles.add(title);
          }
        }
      }
    }
    if (r.ok && src?.foil) {
      balloons.push({ productId: r.productId, importId: src.importId!, runId, bundleId: bundleRow?.bundleId ?? null, bundleVariantId: bundleRow?.bundleVariantId ?? null, tierVariantId: bundleRow?.tierVariantId ?? null, online: !!src.price });
    }
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
        ? { id: row.id, status: "created" as const, productId: r.productId, publishedToPos: r.published, photos: r.photos, photoError: r.photoError, stock: updateStock ? (src?.qty ?? 0) : 0, ...(bundle ? { bundle } : {}) }
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
    await store.recordBalloons(balloons);
  } catch (e) {
    console.error("balloon ledger", e);
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

/* ------------------------------------------------------------------ prices */

/**
 * A page of the products this tool added (one run, or every run), with their current prices from Shopify.
 * Only prices are read; nothing here touches stock. `after` continues from the previous page's `next`.
 */
app.get("/api/pricing", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const run = c.req.query("run") ?? "";
  if (run && !RUN_CODE_RE.test(run)) return c.json({ error: "That run code isn't valid." }, 400);
  const after = Math.max(0, Math.floor(Number(c.req.query("after") ?? 0)) || 0);
  const page = await store.liveProducts(run, after, MAX_PRICE_BATCH);
  const prices = new Map((await fetchPrices(c.env, page.rows.map((r) => r.productId))).map((p) => [p.productId, p]));
  const products = page.rows.flatMap((r) => {
    const p = prices.get(r.productId);
    // A product deleted in Shopify by hand has nothing to price.
    return p ? [{ ...p, vendor: r.vendor ?? "", run: r.run, title: p.title || r.title }] : [];
  });
  return c.json({ products, next: page.next });
});

/** Set prices (GST included) on products this tool added. Price only: stock and everything else stay as they are. */
app.post("/api/prices", async (c) => {
  const body = await c.req.json().catch(() => null);
  const raw = (body as { items?: unknown })?.items;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_PRICE_BATCH) return c.json({ error: `Send between 1 and ${MAX_PRICE_BATCH} prices at a time.` }, 400);
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const items: { productId: string; price: string }[] = [];
  const bad: { productId: string; ok: false; error: string }[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const productId = typeof r?.productId === "string" ? r.productId : "";
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) continue;
    const price = normalisePrice(r.price);
    if (price) items.push({ productId, price });
    else bad.push({ productId, ok: false, error: "Enter a price above $0, like 4.95." });
  }
  const own = await store.liveOwn(items.map((i) => i.productId));
  const allowed = items.filter((i) => own.has(i.productId));
  const refused = items.filter((i) => !own.has(i.productId)).map((i) => ({ productId: i.productId, ok: false as const, error: "This product wasn't added by this tool, so its price can't be set here." }));
  const saved = allowed.length ? await setPrices(c.env, allowed) : [];
  // Foil balloons just priced: on to every channel, and their helium bundles priced and made live.
  let balloons = null;
  const pricedBalloons = await store.balloonsFor(saved.filter((r) => r.ok).map((r) => r.productId));
  if (pricedBalloons.length) {
    try {
      balloons = await syncBalloons(c.env, await getShopContext(c.env), store, pricedBalloons);
    } catch (e) {
      balloons = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return c.json({ results: [...saved, ...refused, ...bad], balloons });
});

/** The Helium Inflation product and its sizes, for suggesting bundles on the review screen. */
app.get("/api/helium", async (c) => {
  try {
    return c.json({ inflation: await findInflation(c.env) });
  } catch (e) {
    return c.json({ inflation: null, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Bring every foil balloon this tool added up to date, 40 at a time (send `after` from the last reply until `next`
 * is null): balloons priced at the till go on every channel, and helium bundles get balloon + inflation (also
 * after an inflation price changes).
 */
app.post("/api/balloons/sync", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const body = await c.req.json<{ after?: unknown }>().catch(() => null);
  const after = Math.max(0, Math.floor(Number(body?.after ?? 0)) || 0);
  const page = await store.balloonsPage(after, 40);
  const out = page.rows.length ? await syncBalloons(c.env, await getShopContext(c.env), store, page.rows) : { checked: 0, online: 0, repriced: 0, waiting: 0, gone: 0, errors: [] };
  return c.json({ ...out, next: page.next });
});

/** Every helium bundle in the store, 50 at a time: price = the sum of its parts. See repriceStoreBundles. */
app.post("/api/bundles/reprice", async (c) => {
  const body = await c.req.json<{ after?: unknown }>().catch(() => null);
  const after = typeof body?.after === "string" ? body.after.slice(0, 500) : "";
  try {
    return c.json(await repriceStoreBundles(c.env, after));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
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
  // Helium bundles go first: a balloon is only deleted once its bundle is gone, so no bundle is left pointing at nothing.
  const balloonRows = await store.balloonsFor([...known]);
  const bundleOf = new Map(balloonRows.filter((b) => b.bundleId).map((b) => [b.productId, b.bundleId!]));
  const blocked = new Map<string, UndoResult>();
  if (bundleOf.size) {
    const bundleResults = await undoImport(c.env, importId, [...bundleOf.values()]);
    const byBundle = new Map(bundleResults.map((r) => [r.id, r]));
    for (const [base, bundleId] of bundleOf) {
      const r = byBundle.get(bundleId);
      if (!r || r.status === "deleted" || (r.status === "kept" && r.reason === "gone")) continue;
      blocked.set(
        base,
        r.status === "kept" && r.reason === "priced"
          ? { id: base, status: "kept", reason: "priced" }
          : { id: base, status: "failed", error: `Its helium bundle couldn't be removed${r.status === "failed" ? `: ${r.error}` : "."}` },
      );
    }
  }
  results.push(...blocked.values());
  const free = [...known].filter((id) => !blocked.has(id));
  if (free.length) results.push(...(await undoImport(c.env, importId, free)));
  const gone = results.filter((r) => r.status === "deleted" || (r.status === "kept" && r.reason === "gone")).map((r) => r.id);
  await store.markDeleted(gone, c.get("user"));
  await store.markBalloonsDeleted(gone).catch((e) => console.error("balloon ledger", e));
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

/**
 * Compare a run's products with what is really in Shopify. Products deleted by hand are marked gone, so they
 * stop blocking the invoice and the run. `productIds` are existing products this page added stock to: any that
 * no longer exist are reported as missing. Read-only on Shopify.
 */
app.post("/api/runs/:code/check", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const code = c.req.param("code");
  const runId = RUN_CODE_RE.test(code) ? await store.runId(code) : null;
  if (!runId) return c.json({ error: "Run not found." }, 404);
  const body = await c.req.json().catch(() => null);
  const extra = Array.isArray(body?.productIds) ? (body.productIds as unknown[]).filter((x): x is string => typeof x === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(x)).slice(0, 200) : [];
  const live = await store.liveForRun(runId);
  if (!live.length && !extra.length) return c.json({ removedIds: [], missingIds: [], remaining: [], liveByInvoice: {} });
  let present: Set<string>;
  try {
    present = await productsPresent(c.env, [...live.map((l) => l.productId), ...extra]);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Shopify couldn't be reached." }, 502);
  }
  const removed = live.filter((l) => !present.has(l.productId));
  const missingIds = extra.filter((id) => !present.has(id));
  const gone = [...new Set([...removed.map((r) => r.productId), ...missingIds])];
  if (gone.length) {
    await store.markDeleted(gone, c.get("user"));
    await new CatalogueStore(c.env.DB!).markProductsGone(gone, c.get("user")).catch((e) => console.error("photos ledger", e));
  }
  const remaining = live.filter((l) => present.has(l.productId));
  const liveByInvoice: Record<string, number> = {};
  for (const r of remaining) liveByInvoice[r.invoiceId] = (liveByInvoice[r.invoiceId] ?? 0) + 1;
  return c.json({ removedIds: removed.map((r) => r.productId), missingIds, remaining, liveByInvoice });
});

/** Let an invoice leave a run while its products stay in Shopify: they just stop being tracked as part of it. */
app.post("/api/runs/:code/release", async (c) => {
  const store = runStore(c.env);
  if (!store) return c.json({ error: NO_DB }, 503);
  const code = c.req.param("code");
  const runId = RUN_CODE_RE.test(code) ? await store.runId(code) : null;
  if (!runId) return c.json({ error: "Run not found." }, 404);
  const body = await c.req.json().catch(() => null);
  const invoiceId = typeof body?.invoiceId === "string" ? body.invoiceId : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(invoiceId)) return c.json({ error: "That invoice isn't valid." }, 400);
  return c.json({ released: await store.releaseInvoice(runId, invoiceId, c.get("user")) });
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
