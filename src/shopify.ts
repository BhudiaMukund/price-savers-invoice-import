import type { Env, StoreProduct } from "./types";
import { searchForms } from "./barcode";

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

async function gql<T>(env: Env, query: string, variables: Record<string, unknown> = {}, attempt = 0): Promise<T> {
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
        nodes { barcode sku product { id title handle } }
      }
    }`;
  type R = {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { barcode: string | null; sku: string | null; product: { id: string; title: string; handle: string } }[];
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
      nodes: { barcode: string | null; sku: string | null; product: { id: string; title: string; handle: string } }[];
    };
  };
  // Keep each search query short.
  for (let i = 0; i < terms.length; i += 40) {
    const data = await gql<R>(
      env,
      `query Find($q: String!) {
         productVariants(first: 250, query: $q) { nodes { barcode sku product { id title handle } } }
       }`,
      { q: terms.slice(i, i + 40).join(" OR ") },
    );
    for (const v of data.productVariants.nodes) {
      out.push({ productId: v.product.id, title: v.product.title, handle: v.product.handle, barcode: v.barcode ?? "", sku: v.sku ?? "" });
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
}

export type CreateResult =
  | { ok: true; productId: string; published: boolean }
  | { ok: false; error: string };

/**
 * Create one ACTIVE product: price 0.00, inventory NOT tracked and NOT a physical/shippable item,
 * then publish it to Point of Sale ONLY (never the Online Store), so a $0 item can't be bought online
 * or leak into the Google Shopping feed.
 */
export async function createProduct(env: Env, ctx: ShopContext, p: NewProduct): Promise<CreateResult> {
  const mutation = `
    mutation Create($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id }
        userErrors { field message code }
      }
    }`;
  const variant: Record<string, unknown> = {
    optionValues: [{ optionName: "Title", name: "Default Title" }],
    price: "0.00",
    // In-store only: no stock counting, and not shippable (so it can never be sent in an online order).
    inventoryItem: { tracked: false, requiresShipping: false },
  };
  if (p.barcode) variant.barcode = p.barcode;
  if (p.sku) variant.sku = p.sku;

  type R = { productSet: { product: { id: string } | null; userErrors: { field: string[]; message: string }[] } };
  try {
    const input: Record<string, unknown> = {
      title: p.title,
      status: "ACTIVE",
      productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
      variants: [variant],
    };
    if (p.vendor) input.vendor = p.vendor;
    if (p.importId) {
      const f = ctx.importSource;
      input.metafields = [{ namespace: f.namespace, key: f.key, type: f.type, value: importSourceValue(f.type, p.importId) }];
      if (env.IMPORT_TAGS !== "false") input.tags = [importTag(p.importId), ...(p.runCode ? [`run-${p.runCode}`] : [])];
    }
    const data = await gql<R>(env, mutation, { input });
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
    return { ok: true, productId: product.id, published };
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
