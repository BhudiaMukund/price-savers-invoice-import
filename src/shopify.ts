import type { Env, StoreProduct } from "./types";
import { analyzeBarcode, searchForms } from "./barcode";

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
}

export class ShopifyError extends Error {}

/**
 * Access token for the Admin API. Two kinds of Shopify app are supported:
 *  - Dev Dashboard apps (the only kind Shopify lets you create since 1 Jan 2026): set SHOPIFY_CLIENT_ID and
 *    SHOPIFY_CLIENT_SECRET. Tokens come from the client credentials grant and last 24 hours, so we cache one
 *    and fetch a new one shortly before it expires.
 *  - Older "legacy" custom apps made in the Shopify admin: set SHOPIFY_ADMIN_TOKEN (a permanent shpat_ token).
 */
let cached: { key: string; token: string; expiresAt: number } | null = null;

export function resetTokenCache() {
  cached = null;
}

async function accessToken(env: Env, forceNew = false): Promise<string> {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new ShopifyError("Shopify isn't set up: add SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN).");
  }
  const key = `${env.SHOPIFY_STORE_DOMAIN}|${env.SHOPIFY_CLIENT_ID}`;
  if (!forceNew && cached && cached.key === key && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new ShopifyError(
      `Shopify refused the app's credentials (${res.status}). Check the client ID and secret, that the app is installed on ${env.SHOPIFY_STORE_DOMAIN}, and that the app and the store belong to the same Shopify organization.${detail ? ` Shopify said: ${detail}` : ""}`,
    );
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new ShopifyError("Shopify didn't return an access token.");
  const ttl = Math.max(60, Number(body.expires_in) || 86399);
  cached = { key, token: body.access_token, expiresAt: Date.now() + (ttl - 120) * 1000 };
  return body.access_token;
}

export async function gql<T>(env: Env, query: string, variables: Record<string, unknown> = {}, attempt = 0): Promise<T> {
  const url = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await accessToken(env),
    },
    body: JSON.stringify({ query, variables }),
  });

  // An expired or revoked short-lived token: get a fresh one and retry once.
  if (res.status === 401 && !env.SHOPIFY_ADMIN_TOKEN && attempt === 0) {
    await accessToken(env, true);
    return gql<T>(env, query, variables, attempt + 1);
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(800 * 2 ** attempt);
    return gql<T>(env, query, variables, attempt + 1);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401) throw new ShopifyError("Shopify rejected the access token. Check the app is installed on this store.");
    if (res.status === 403) {
      throw new ShopifyError(`Shopify refused access (403). The app is probably missing a permission: release an app version with the scopes in the README, then reinstall it. Details: ${text}`);
    }
    if (res.status === 404) throw new ShopifyError(`Shopify store not found at ${env.SHOPIFY_STORE_DOMAIN}. Check SHOPIFY_STORE_DOMAIN in wrangler.toml.`);
    throw new ShopifyError(`Shopify HTTP ${res.status}: ${text}`);
  }

  const body = (await res.json()) as GqlResponse<T>;
  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 5) {
      await sleep(1000 * (attempt + 1));
      return gql<T>(env, query, variables, attempt + 1);
    }
    throw new ShopifyError(body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data) throw new ShopifyError("Shopify returned no data");
  return body.data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch every variant in the store that has a barcode or SKU (paged, 250 at a time). */
export async function fetchStoreProducts(env: Env): Promise<StoreProduct[]> {
  const out: StoreProduct[] = [];
  let cursor: string | null = null;
  const query = `
    query Variants($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { barcode sku product { id title handle status } }
      }
    }`;
  type R = {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { barcode: string | null; sku: string | null; product: { id: string; title: string; handle: string; status?: StoreProduct["status"] } }[];
    };
  };
  for (let page = 0; page < 200; page++) {
    const data: R = await gql<R>(env, query, { cursor });
    for (const v of data.productVariants.nodes) {
      out.push({
        productId: v.product.id,
        title: v.product.title,
        handle: v.product.handle,
        barcode: v.barcode ?? "",
        sku: v.sku ?? "",
        status: v.product.status,
      });
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
  }
  return out;
}

/**
 * Look up only the variants whose barcode matches one of these codes (in any GTIN spelling).
 * Much cheaper than fetching the whole catalogue; used as the last check right before creating.
 * Results are a superset: callers must still match exactly (see classifyItems).
 */
export async function findVariantsByBarcodes(env: Env, barcodes: (string | null | undefined)[]): Promise<StoreProduct[]> {
  const forms = new Set<string>();
  for (const b of barcodes) for (const f of searchForms(b)) forms.add(f);
  if (forms.size === 0) return [];

  const terms = [...forms].map((f) => `barcode:${f}`);
  const out: StoreProduct[] = [];
  type R = {
    productVariants: {
      nodes: { barcode: string | null; sku: string | null; product: { id: string; title: string; handle: string; status?: StoreProduct["status"] } }[];
    };
  };
  // Keep each search query short.
  for (let i = 0; i < terms.length; i += 40) {
    const data = await gql<R>(
      env,
      `query Find($q: String!) {
         productVariants(first: 250, query: $q) { nodes { barcode sku product { id title handle status } } }
       }`,
      { q: terms.slice(i, i + 40).join(" OR ") },
    );
    for (const v of data.productVariants.nodes) {
      out.push({ productId: v.product.id, title: v.product.title, handle: v.product.handle, barcode: v.barcode ?? "", sku: v.sku ?? "", status: v.product.status });
    }
  }
  return out;
}

export interface ShopContext {
  locationId: string;
  posPublicationId: string | null;
  /** Where the import ID is saved on each product, with the type of the store's existing definition. */
  importSource: { namespace: string; key: string; type: string };
}

/** "custom.import_source" -> { namespace, key }. */
export function importSourceField(env: Env): { namespace: string; key: string } {
  const [namespace, key] = (env.IMPORT_SOURCE_METAFIELD || "custom.import_source").split(".");
  return { namespace: namespace || "custom", key: key || "import_source" };
}

/** Text-based metafield types we know how to write an import ID into. */
const IMPORT_SOURCE_TYPES = new Set(["single_line_text_field", "multi_line_text_field", "list.single_line_text_field"]);

/** Look up the stock location, the Point of Sale channel and the import-source field, once per batch. */
export async function getShopContext(env: Env): Promise<ShopContext> {
  const field = importSourceField(env);
  type R = {
    locations: { nodes: { id: string; name: string }[] };
    publications: { nodes: { id: string; name: string }[] };
    metafieldDefinitions?: { nodes?: { type?: { name: string } }[] };
  };
  const data = await gql<R>(
    env,
    `query Ctx($ns: String!, $key: String!) {
       locations(first: 5, includeInactive: false) { nodes { id name } }
       publications(first: 25) { nodes { id name } }
       metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: $ns, key: $key) { nodes { type { name } } }
     }`,
    { ns: field.namespace, key: field.key },
  );
  const location = data.locations.nodes[0];
  if (!location) throw new ShopifyError("No active stock location found in Shopify");
  const pos = data.publications.nodes.find((p) => /point of sale/i.test(p.name));
  const defType = data.metafieldDefinitions?.nodes?.[0]?.type?.name;
  return {
    locationId: location.id,
    posPublicationId: pos?.id ?? null,
    importSource: { ...field, type: defType && IMPORT_SOURCE_TYPES.has(defType) ? defType : "single_line_text_field" },
  };
}

/** The value to store for an import ID, shaped for the field's type. */
export function importSourceValue(type: string, importId: string): string {
  return type.startsWith("list.") ? JSON.stringify([importId]) : importId;
}

/** Product tag that carries the import ID, so a whole import can be filtered in Shopify admin. */
export function importTag(importId: string): string {
  return `import-${importId}`;
}

export interface NewProduct {
  title: string;
  barcode: string | null;
  sku: string | null;
  /** Shopify's Vendor field: the supplier. */
  vendor: string | null;
  /** Unique ID for the invoice import this product came from. */
  importId: string | null;
  /** The run (working session) it was added in, e.g. R42. */
  runCode: string | null;
  /** Catalogue photos (Shopify CDN addresses), main photo first. The product gets its own copies. */
  photos?: { url: string; alt: string; filename?: string }[];
  /** Description from the supplier catalogue, plain text. */
  description?: string | null;
  /** Add the import-<ID> and run-<code> tags (the "Tag new products" setting). Default on. */
  tags?: boolean;
  /** Start with this much stock at this location, with stock tracking turned on. */
  stock?: { quantity: number; locationId: string };
}

export type CreateResult =
  | { ok: true; productId: string; published: boolean; photos: number; photoError?: string; mediaIds: string[] }
  | { ok: false; error: string };

/** Plain text to safe HTML paragraphs. */
export function textToHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Create one ACTIVE product: price 0.00, inventory NOT tracked and NOT a physical/shippable item,
 * then publish it to Point of Sale ONLY (never the Online Store), so a $0 item can't be bought online
 * or leak into the Google Shopping feed.
 */
export async function createProduct(env: Env, ctx: ShopContext, p: NewProduct): Promise<CreateResult> {
  const mutation = `
    mutation Create($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id media(first: 20) { nodes { id } } }
        userErrors { field message code }
      }
    }`;
  const variant: Record<string, unknown> = {
    optionValues: [{ optionName: "Title", name: "Default Title" }],
    price: "0.00",
    // In-store only: no stock counting, and not shippable (so it can never be sent in an online order).
    inventoryItem: { tracked: false, requiresShipping: false },
  };
  if (p.stock && p.stock.quantity > 0) {
    // Counted stock: tracking on, and the invoice quantity as the starting count at the chosen location.
    variant.inventoryItem = { tracked: true, requiresShipping: false };
    variant.inventoryQuantities = [{ locationId: p.stock.locationId, name: "available", quantity: Math.floor(p.stock.quantity) }];
  }
  if (p.barcode) variant.barcode = p.barcode;
  if (p.sku) variant.sku = p.sku;

  type R = { productSet: { product: { id: string; media?: { nodes: { id: string }[] } } | null; userErrors: { field: string[] | null; message: string }[] } };
  try {
    const input: Record<string, unknown> = {
      title: p.title,
      status: "ACTIVE",
      productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
      variants: [variant],
    };
    if (p.vendor) input.vendor = p.vendor;
    if (p.description?.trim()) input.descriptionHtml = textToHtml(p.description);
    const photos = (p.photos ?? []).slice(0, 12);
    // Copies made from the catalogue's photo (Shopify downloads it from its own CDN), not links to it.
    if (photos.length) {
      input.files = photos.map((ph) => ({ originalSource: ph.url, contentType: "IMAGE", alt: ph.alt.slice(0, 500), ...(ph.filename ? { filename: ph.filename } : {}) }));
    }
    if (p.importId) {
      const f = ctx.importSource;
      input.metafields = [{ namespace: f.namespace, key: f.key, type: f.type, value: importSourceValue(f.type, p.importId) }];
      if (p.tags ?? env.IMPORT_TAGS !== "false") input.tags = [importTag(p.importId), ...(p.runCode ? [`run-${p.runCode}`] : [])];
    }
    let data = await gql<R>(env, mutation, { input });
    let photoError: string | undefined;
    const filesError = () => data.productSet.userErrors.some((e) => (e.field ?? []).includes("files"));
    // A photo problem shouldn't stop the product being added: try again with Shopify's own file names,
    // then without the photos.
    if (input.files && filesError() && photos.some((ph) => ph.filename)) {
      input.files = photos.map((ph) => ({ originalSource: ph.url, contentType: "IMAGE", alt: ph.alt.slice(0, 500) }));
      data = await gql<R>(env, mutation, { input });
    }
    if (input.files && filesError()) {
      photoError = data.productSet.userErrors.map((e) => e.message).join("; ");
      delete input.files;
      data = await gql<R>(env, mutation, { input });
    }
    const { product, userErrors } = data.productSet;
    if (userErrors.length || !product) {
      return { ok: false, error: userErrors.map((e) => e.message).join("; ") || "Unknown Shopify error" };
    }

    let published = false;
    if (ctx.posPublicationId) {
      type P = { publishablePublish: { userErrors: { message: string }[] } };
      const pub = await gql<P>(
        env,
        `mutation Pub($id: ID!, $input: [PublicationInput!]!) {
           publishablePublish(id: $id, input: $input) { userErrors { message } }
         }`,
        { id: product.id, input: [{ publicationId: ctx.posPublicationId }] },
      );
      published = pub.publishablePublish.userErrors.length === 0;
    }
    // The product's own photo copies, in the order the photos were sent (one per catalogue photo).
    const mediaIds = input.files ? (product.media?.nodes ?? []).map((m) => m.id).slice(0, photos.length) : [];
    return { ok: true, productId: product.id, published, photos: input.files ? photos.length : 0, mediaIds, ...(photoError ? { photoError } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ suppliers */

const SAVED_NS = "$app";
const SAVED_KEY = "suppliers";

/** Every vendor already used on a product in the store. */
async function storeVendors(env: Env): Promise<string[]> {
  type R = { productVendors: { edges: { node: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
  const out: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: R = await gql<R>(
      env,
      `query V($cursor: String) { productVendors(first: 250, after: $cursor) { edges { node } pageInfo { hasNextPage endCursor } } }`,
      { cursor },
    );
    out.push(...data.productVendors.edges.map((e) => e.node));
    if (!data.productVendors.pageInfo.hasNextPage) break;
    cursor = data.productVendors.pageInfo.endCursor;
  }
  return out;
}

/** Suppliers added in this tool but not yet used on any product, kept in a shop metafield owned by this app. */
async function savedSuppliers(env: Env): Promise<{ shopId: string; names: string[] }> {
  type R = { shop: { id: string; metafield: { value: string } | null } };
  const data = await gql<R>(env, `{ shop { id metafield(namespace: "${SAVED_NS}", key: "${SAVED_KEY}") { value } } }`);
  let names: string[] = [];
  try {
    const v = JSON.parse(data.shop.metafield?.value ?? "[]");
    if (Array.isArray(v)) names = v.filter((x) => typeof x === "string");
  } catch {
    /* treat a broken value as empty */
  }
  return { shopId: data.shop.id, names };
}

export function cleanSupplierName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 100);
}

/** Merge lists, ignoring case and spacing differences, and sort. */
export function mergeSuppliers(...lists: string[][]): string[] {
  const byKey = new Map<string, string>();
  for (const list of lists) {
    for (const raw of list) {
      const name = cleanSupplierName(raw);
      if (!name) continue;
      const k = name.toLowerCase();
      if (!byKey.has(k)) byKey.set(k, name);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "en-AU", { sensitivity: "base" }));
}

export async function listSuppliers(env: Env): Promise<string[]> {
  const [vendors, saved] = await Promise.all([storeVendors(env), savedSuppliers(env)]);
  return mergeSuppliers(vendors, saved.names);
}

/** Save a new supplier so it appears in the list before any product uses it. */
export async function addSupplier(env: Env, name: string): Promise<string[]> {
  const clean = cleanSupplierName(name);
  if (!clean) throw new ShopifyError("Type a supplier name.");
  const [vendors, saved] = await Promise.all([storeVendors(env), savedSuppliers(env)]);
  const all = mergeSuppliers(vendors, saved.names);
  if (all.some((n) => n.toLowerCase() === clean.toLowerCase())) return all;

  const names = mergeSuppliers(saved.names, [clean]);
  type R = { metafieldsSet: { userErrors: { message: string }[] } };
  const res = await gql<R>(
    env,
    `mutation Save($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`,
    { m: [{ ownerId: saved.shopId, namespace: SAVED_NS, key: SAVED_KEY, type: "json", value: JSON.stringify(names) }] },
  );
  if (res.metafieldsSet.userErrors.length) {
    throw new ShopifyError(`Couldn't save the supplier: ${res.metafieldsSet.userErrors.map((e) => e.message).join("; ")}`);
  }
  return mergeSuppliers(all, [clean]);
}

export interface SupplierInfo {
  name: string;
  /** Saved in this tool's own list (rather than only being a vendor on store products). */
  saved: boolean;
  /** Products in the store with this vendor. */
  products: number;
}

/** How many store products each vendor has, in one request per 40 vendors. */
async function vendorCounts(env: Env, vendors: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < vendors.length; i += 40) {
    const part = vendors.slice(i, i + 40);
    const vars = part.map((_, j) => `$q${j}: String`).join(", ");
    const fields = part.map((_, j) => `v${j}: productsCount(query: $q${j}) { count }`).join(" ");
    const variables = Object.fromEntries(part.map((v, j) => [`q${j}`, `vendor:"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`]));
    const data = await gql<Record<string, { count: number } | null>>(env, `query Counts(${vars}) { ${fields} }`, variables);
    part.forEach((v, j) => out.set(v.toLowerCase(), Number(data[`v${j}`]?.count ?? 0)));
  }
  return out;
}

/** Every supplier, with whether it's saved here and how many store products use it. */
export async function supplierDetails(env: Env): Promise<SupplierInfo[]> {
  const [vendors, saved] = await Promise.all([storeVendors(env), savedSuppliers(env)]);
  const counts = await vendorCounts(env, vendors);
  const savedKeys = new Set(saved.names.map((n) => cleanSupplierName(n).toLowerCase()));
  return mergeSuppliers(vendors, saved.names).map((name) => ({
    name,
    saved: savedKeys.has(name.toLowerCase()),
    products: counts.get(name.toLowerCase()) ?? 0,
  }));
}

/**
 * Remove a supplier from this tool's saved list. Refused while any product in the store has it as its
 * vendor (checked live, so it can't be stale): change those products in Shopify first.
 */
export async function removeSupplier(env: Env, name: string): Promise<string[]> {
  const clean = cleanSupplierName(name);
  const [vendors, saved] = await Promise.all([storeVendors(env), savedSuppliers(env)]);
  const inStore = vendors.find((v) => v.toLowerCase() === clean.toLowerCase());
  if (inStore) {
    const n = (await vendorCounts(env, [inStore])).get(inStore.toLowerCase()) ?? 0;
    throw new ShopifyError(
      `${inStore} is the vendor on ${n === 1 ? "1 product" : `${n} products`} in your store, so it can't be deleted. Change their vendor in Shopify first.`,
    );
  }
  const names = saved.names.filter((n) => cleanSupplierName(n).toLowerCase() !== clean.toLowerCase());
  if (names.length === saved.names.length) throw new ShopifyError(`${clean} isn't in the saved supplier list.`);
  type R = { metafieldsSet: { userErrors: { message: string }[] } };
  const res = await gql<R>(
    env,
    `mutation Save($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`,
    { m: [{ ownerId: saved.shopId, namespace: SAVED_NS, key: SAVED_KEY, type: "json", value: JSON.stringify(names) }] },
  );
  if (res.metafieldsSet.userErrors.length) {
    throw new ShopifyError(`Couldn't update the supplier list: ${res.metafieldsSet.userErrors.map((e) => e.message).join("; ")}`);
  }
  return mergeSuppliers(vendors, names);
}

/* ------------------------------------------------------------------ stock */

export interface StockLocation {
  id: string;
  name: string;
}

/** The store's active stock locations, for the Settings page. */
export async function listLocations(env: Env): Promise<StockLocation[]> {
  const data = await gql<{ locations: { nodes: StockLocation[] } }>(env, `query { locations(first: 50, includeInactive: false) { nodes { id name } } }`);
  return data.locations.nodes;
}

/** Say what to do when Shopify won't touch stock, instead of its terse "Access denied". */
export function stockError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/access denied|read_inventory|write_inventory|read_locations|not approved|scope/i.test(msg)) {
    return "The Shopify app can't change stock yet. Add the read_inventory, write_inventory and read_locations scopes to the app, release a new version and reinstall it (see the README).";
  }
  return msg;
}

export interface StockLine {
  productId: string;
  barcode: string | null;
  /** Whole units to add (negative to take back out). */
  qty: number;
}

export type StockResult = { ok: true; turnedOnTracking: boolean } | { ok: false; error: string };

type UE = { field: string[] | null; message: string }[];

/** Several mutations in one request: m0, m1, ... Returns each one's userErrors. */
async function manyMutations(env: Env, calls: string[]): Promise<UE[]> {
  if (!calls.length) return [];
  const body = calls.map((c, i) => `m${i}: ${c}`).join("\n");
  const data = await gql<Record<string, { userErrors: UE }>>(env, `mutation { ${body} }`);
  return calls.map((_, i) => data[`m${i}`]?.userErrors ?? []);
}

export type ActivateResult = { ok: true; activated: boolean; published: boolean } | { ok: false; error: string };

/**
 * Make products that are in the store as DRAFT active, and put them on Point of Sale, the same as a product
 * this tool creates. Only DRAFT products are touched: one that is already active, or was archived on purpose,
 * is left alone (activated: false). Price, tags, shipping and everything else stay as they are.
 * Subrequests: one to read the statuses, then one per 10 products to change them.
 */
export async function activateProducts(env: Env, ctx: ShopContext, productIds: string[]): Promise<ActivateResult[]> {
  const out: ActivateResult[] = productIds.map(() => ({ ok: false, error: "Not attempted." }));
  const ids = [...new Set(productIds)];
  const data = await gql<{ nodes: ({ id: string; status: string } | null)[] }>(env, `query Status($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id status } } }`, { ids });
  const status = new Map(data.nodes.filter((n): n is { id: string; status: string } => !!n?.id).map((n) => [n.id, n.status]));
  const done = new Map<string, ActivateResult>();
  const drafts: string[] = [];
  for (const id of ids) {
    const st = status.get(id);
    if (!st) done.set(id, { ok: false, error: "That product wasn't found in the store." });
    else if (st !== "DRAFT") done.set(id, { ok: true, activated: false, published: false });
    else drafts.push(id);
  }
  for (let i = 0; i < drafts.length; i += 10) {
    const group = drafts.slice(i, i + 10);
    const calls: string[] = [];
    for (const id of group) {
      calls.push(`productUpdate(product: {id: "${id}", status: ACTIVE}) { userErrors { field message } }`);
      if (ctx.posPublicationId) calls.push(`publishablePublish(id: "${id}", input: [{publicationId: "${ctx.posPublicationId}"}]) { userErrors { field message } }`);
    }
    try {
      const errors = await manyMutations(env, calls);
      const per = ctx.posPublicationId ? 2 : 1;
      group.forEach((id, k) => {
        const upd = errors[k * per] ?? [];
        const pub = per === 2 ? (errors[k * per + 1] ?? []) : null;
        if (upd.length) done.set(id, { ok: false, error: upd.map((e) => e.message).join("; ") });
        else done.set(id, { ok: true, activated: true, published: !!pub && pub.length === 0 });
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      for (const id of group) done.set(id, { ok: false, error });
    }
  }
  return productIds.map((id, i) => done.get(id) ?? out[i]!);
}

/**
 * Add (or take back) stock on products that are already in the store. Stock tracking is turned on first if it
 * was off, and the product is stocked at the location if it wasn't. Subrequests: one to read the products,
 * one to turn tracking on and stock the location, one to adjust (or one per line if that has to fall back).
 */
export async function adjustStock(env: Env, locationId: string, lines: StockLine[], reason: "received" | "correction" = "received"): Promise<StockResult[]> {
  type Var = { id: string; barcode: string | null; inventoryItem: { id: string; tracked: boolean; inventoryLevel: { id: string } | null } | null };
  type Node = { id: string; variants: { nodes: Var[] } } | null;
  const out: StockResult[] = lines.map(() => ({ ok: false, error: "Not attempted." }));
  const ids = [...new Set(lines.map((l) => l.productId))];
  const data = await gql<{ nodes: Node[] }>(
    env,
    `query Stock($ids: [ID!]!, $loc: ID!) {
       nodes(ids: $ids) { ... on Product { id variants(first: 50) { nodes { id barcode inventoryItem { id tracked inventoryLevel(locationId: $loc) { id } } } } } }
     }`,
    { ids, loc: locationId },
  );
  const byProduct = new Map(ids.map((id, i) => [id, data.nodes[i]]));

  const picked: { at: number; item: NonNullable<Var["inventoryItem"]> }[] = [];
  lines.forEach((l, at) => {
    const node = byProduct.get(l.productId);
    if (!node) return void (out[at] = { ok: false, error: "That product is no longer in Shopify." });
    const want = analyzeBarcode(l.barcode).key;
    const variants = node.variants.nodes;
    const v = (want && variants.find((x) => analyzeBarcode(x.barcode).key === want)) || (variants.length === 1 ? variants[0] : undefined);
    if (!v?.inventoryItem) return void (out[at] = { ok: false, error: "Couldn't tell which variant of this product to stock." });
    picked.push({ at, item: v.inventoryItem });
  });

  // Tracking on, and the location stocked, in one request.
  const prep: string[] = [];
  const prepFor: number[] = [];
  const turnedOn = new Set<number>();
  for (const { at, item } of picked) {
    if (!item.tracked && lines[at]!.qty > 0) {
      prep.push(`inventoryItemUpdate(id: ${JSON.stringify(item.id)}, input: { tracked: true }) { userErrors { field message } }`);
      prepFor.push(at);
      turnedOn.add(at);
    }
    if (!item.inventoryLevel) {
      prep.push(`inventoryActivate(inventoryItemId: ${JSON.stringify(item.id)}, locationId: ${JSON.stringify(locationId)}) { userErrors { field message } }`);
      prepFor.push(at);
    }
  }
  const prepErrors = new Map<number, string>();
  (await manyMutations(env, prep)).forEach((errs, k) => {
    if (errs.length) prepErrors.set(prepFor[k]!, errs.map((e) => e.message).join("; "));
  });
  const ready = picked.filter((p) => {
    const err = prepErrors.get(p.at);
    if (err) out[p.at] = { ok: false, error: err };
    return !err;
  });
  if (!ready.length) return out;

  type Adj = { inventoryAdjustQuantities: { userErrors: UE } };
  const adjust = (some: typeof ready) =>
    gql<Adj>(
      env,
      `mutation Adj($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) { userErrors { field message } } }`,
      { input: { reason, name: "available", changes: some.map((p) => ({ delta: lines[p.at]!.qty, inventoryItemId: p.item.id, locationId })) } },
    );
  const done = (p: (typeof ready)[number]) => (out[p.at] = { ok: true, turnedOnTracking: turnedOn.has(p.at) });
  const first = await adjust(ready);
  if (!first.inventoryAdjustQuantities.userErrors.length) {
    ready.forEach(done);
    return out;
  }
  // Something in the batch was refused and nothing was changed: go line by line, so one bad line can't hold up the rest.
  for (const p of ready) {
    const res = await adjust([p]);
    const errs = res.inventoryAdjustQuantities.userErrors;
    if (errs.length) out[p.at] = { ok: false, error: errs.map((e) => e.message).join("; ") };
    else done(p);
  }
  return out;
}

/* ------------------------------------------------------------------ undo an import */

export type UndoResult =
  | { id: string; status: "deleted" }
  | { id: string; status: "kept"; reason: "priced" | "not_this_import" | "gone" }
  | { id: string; status: "failed"; error: string };

/**
 * Delete products created by one import. Safety checks, per product:
 *  - its import_source must hold this import ID (so nothing else can be deleted by mistake), and
 *  - every variant must still be priced at $0.00 (once someone has priced it, it's real work: keep it).
 */
export async function undoImport(env: Env, importId: string, productIds: string[]): Promise<UndoResult[]> {
  const f = importSourceField(env);
  type Node = {
    id: string;
    metafield: { value: string } | null;
    variants: { nodes: { price: string }[] };
  } | null;
  const data = await gql<{ nodes: Node[] }>(
    env,
    `query Check($ids: [ID!]!, $ns: String!, $key: String!) {
       nodes(ids: $ids) {
         ... on Product { id metafield(namespace: $ns, key: $key) { value } variants(first: 20) { nodes { price } } }
       }
     }`,
    { ids: productIds, ns: f.namespace, key: f.key },
  );

  const results: UndoResult[] = [];
  for (let i = 0; i < productIds.length; i++) {
    const id = productIds[i]!;
    const node = data.nodes[i];
    if (!node) {
      results.push({ id, status: "kept", reason: "gone" });
      continue;
    }
    const value = node.metafield?.value ?? "";
    const matches = value === importId || (value.startsWith("[") && value.includes(JSON.stringify(importId)));
    if (!matches) {
      results.push({ id, status: "kept", reason: "not_this_import" });
      continue;
    }
    if (node.variants.nodes.some((v) => Number(v.price) !== 0)) {
      results.push({ id, status: "kept", reason: "priced" });
      continue;
    }
    try {
      type D = { productDelete: { deletedProductId: string | null; userErrors: { message: string }[] } };
      const d = await gql<D>(
        env,
        `mutation Del($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { message } } }`,
        { id },
      );
      if (d.productDelete.userErrors.length || !d.productDelete.deletedProductId) {
        results.push({ id, status: "failed", error: d.productDelete.userErrors.map((e) => e.message).join("; ") || "Shopify didn't delete it." });
      } else {
        results.push({ id, status: "deleted" });
      }
    } catch (e) {
      results.push({ id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
