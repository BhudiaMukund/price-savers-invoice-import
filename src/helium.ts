/**
 * Helium bundles for foil balloons this tool adds, built the way the store's existing ones were:
 * a separate product "Helium INFLATED <name> Foil Balloon" (type Helium Inflated Balloons, every channel) made of
 * 1 × the flat balloon + 1 × the matching size of the Helium Inflation product. Supplier pack wording in a title
 * ("Pack of 5") is how the wholesaler sells them, not what one product holds, so it never changes the fill.
 * Shopify takes the bundle's stock from the balloon; its price is fixed, so this file keeps it at balloon +
 * inflation. A bundle is never posted (helium balloons are collected in store), so it is
 * not a shippable item; Update helium bundles also corrects any bundle in the store that is.
 *
 * A balloon added at $0 gets its bundle as a DRAFT at $0, and the balloon stays on Point of Sale only, so nothing
 * can be bought online for the helium price alone. Once the balloon has a price (on the Prices page here, or at
 * the till), syncBalloons puts the balloon on every channel and prices and activates the bundle.
 */
// @ts-expect-error plain JS module shared with the browser
import { bundlePrice, tierRange } from "../public/js/helium.js";
import { gql, manyMutations, type ShopContext } from "./shopify";
import type { BalloonRow, RunStore } from "./store";
import type { Env } from "./types";

export const BUNDLE_TYPE = "Helium Inflated Balloons";
export const BALLOON_TYPE = "Foil Balloons";
/** Foil balloons filled with air (staff unticked the bundle, or under 40cm): never offered inflated. */
export const AIR_TYPE = "Air Foil Balloon";

export interface InflationTier {
  variantId: string;
  title: string;
  price: string;
  min: number | null;
  max: number | null;
}
export interface Inflation {
  productId: string;
  title: string;
  tiers: InflationTier[];
}

type VariantNode = { id: string; title: string; price: string };
type ProductNode = { id: string; title: string; productType?: string | null; variants?: { nodes: VariantNode[] } };

const isDefault = (t: string) => !t || /^default title$/i.test(t.trim());

/** Every size from these inflation products. A product with one size per product ("Helium Inflation 40-50cm",
 *  variant "Default Title") is named and sized by its product title; a product with size variants by each variant. */
function tiersOf(products: ProductNode[]): InflationTier[] {
  const seen = new Set<string>();
  const out: InflationTier[] = [];
  for (const p of products) {
    for (const v of p.variants?.nodes ?? []) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      const label = isDefault(v.title) ? p.title : `${p.title}: ${v.title}`;
      const r = ((isDefault(v.title) ? null : tierRange(v.title)) ?? tierRange(p.title)) as [number, number] | null;
      out.push({ variantId: v.id, title: label, price: Number(v.price).toFixed(2), min: r?.[0] ?? null, max: r?.[1] ?? null });
    }
  }
  // Smallest first; sizes the tool couldn't read go last (staff can still pick them).
  return out.sort((a, b) => (a.min ?? 1e9) - (b.min ?? 1e9) || a.title.localeCompare(b.title));
}

const looksLikeInflation = (p: ProductNode) =>
  /inflat|helium/i.test(p.title) && !/\binflated\b/i.test(p.title) && !/balloon/i.test(p.productType ?? "") && !/\b(foil|latex)\b|\bballoons?\b/i.test(p.title);

/**
 * Find the helium inflation products: the non-balloon parts of the store's existing helium bundles, plus any
 * product named like "Helium Inflation ...". They may be one product with a variant per size, or one product per
 * size. Two requests. Null when the store has none.
 */
export async function findInflation(env: Env): Promise<Inflation | null> {
  type Light = { id: string; title: string; productType?: string | null };
  const first = await gql<{
    bundles: { nodes: { variants: { nodes: { productVariantComponents: { nodes: { productVariant: { product: Light } | null }[] } }[] } }[] };
    named: { nodes: Light[] };
  }>(
    env,
    `query Helium($bundles: String!, $named: String!) {
       bundles: products(first: 40, query: $bundles) {
         nodes { variants(first: 1) { nodes { productVariantComponents(first: 3) { nodes { productVariant { product { id title productType } } } } } } }
       }
       named: products(first: 50, query: $named) { nodes { id title productType } }
     }`,
    { bundles: `product_type:"${BUNDLE_TYPE}"`, named: "title:*inflation* OR title:helium*" },
  );
  const found = new Map<string, Light>();
  for (const b of first.bundles?.nodes ?? []) {
    for (const v of b.variants.nodes) {
      for (const c of v.productVariantComponents?.nodes ?? []) {
        const p = c.productVariant?.product;
        if (p && looksLikeInflation(p)) found.set(p.id, p);
      }
    }
  }
  for (const p of first.named?.nodes ?? []) if (looksLikeInflation(p)) found.set(p.id, p);
  if (!found.size) return null;
  const ids = [...found.keys()].slice(0, 50);
  const full = await gql<{ nodes: (ProductNode | null)[] }>(
    env,
    `query HeliumSizes($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title productType variants(first: 20) { nodes { id title price } } } } }`,
    { ids },
  );
  const products = full.nodes.filter((n): n is ProductNode => !!n?.id);
  const tiers = tiersOf(products);
  if (!tiers.length) return null;
  return { productId: products[0]!.id, title: products.length === 1 ? products[0]!.title : "Helium Inflation", tiers };
}

/** Which of these titles are already used by a product (so a balloon whose bundle already exists gets no second one). */
export async function titlesInStore(env: Env, titles: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const wanted = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
  if (!wanted.length) return out;
  const q = wanted.map((t) => `title:"${t.replace(/\\/g, "").replace(/"/g, '\\"')}"`).join(" OR ");
  const data = await gql<{ products: { nodes: { title: string }[] } }>(env, `query Titles($q: String!) { products(first: 50, query: $q) { nodes { title } } }`, { q });
  const have = new Set((data.products?.nodes ?? []).map((p) => p.title.trim().toLowerCase()));
  for (const t of wanted) if (have.has(t.toLowerCase())) out.add(t);
  return out;
}

/** Make a bundle variant out of the balloon variant and an inflation variant (`fills` of it; 1 unless a caller says). */
export async function linkBundle(env: Env, bundleVariantId: string, balloonVariantId: string, tierVariantId: string, fills = 1): Promise<string | null> {
  type R = { productVariantRelationshipBulkUpdate: { userErrors: { message: string }[] } };
  try {
    const res = await gql<R>(
      env,
      `mutation Link($input: [ProductVariantRelationshipUpdateInput!]!) {
         productVariantRelationshipBulkUpdate(input: $input) { parentProductVariants { id } userErrors { code field message } }
       }`,
      {
        input: [
          {
            parentProductVariantId: bundleVariantId,
            productVariantRelationshipsToCreate: [
              { id: balloonVariantId, quantity: 1 },
              { id: tierVariantId, quantity: Math.max(1, Math.floor(fills)) },
            ],
          },
        ],
      },
    );
    const errs = res.productVariantRelationshipBulkUpdate.userErrors;
    return errs.length ? errs.map((e) => e.message).join("; ") : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Delete a bundle this request has just made (its parts couldn't be linked). */
export async function dropBundle(env: Env, productId: string): Promise<void> {
  await gql(env, `mutation Drop($id: ID!) { productDelete(input: { id: $id }) { deletedProductId userErrors { message } } }`, { id: productId });
}

export interface SyncResult {
  checked: number;
  /** Balloons put on every channel now they have a price. */
  online: number;
  /** Bundles given a new price (and made active). */
  repriced: number;
  /** Balloons still at $0: their bundles wait as drafts. */
  waiting: number;
  /** Balloons or bundles deleted in Shopify by hand. */
  gone: number;
  errors: string[];
}

/**
 * Bring balloons and their bundles up to date: a priced balloon goes on every channel, and its bundle gets
 * balloon + inflation and becomes active. A balloon at $0 is left alone. Also picks up new inflation prices.
 * Subrequests: one to read everything, then one per 10 changes. Keep `rows` to 40 or fewer.
 */
export async function syncBalloons(env: Env, ctx: ShopContext, store: RunStore, rows: BalloonRow[]): Promise<SyncResult> {
  const out: SyncResult = { checked: rows.length, online: 0, repriced: 0, waiting: 0, gone: 0, errors: [] };
  if (!rows.length) return out;
  const ids = [...new Set(rows.flatMap((r) => [r.productId, ...(r.bundleId ? [r.bundleId] : []), ...(r.tierVariantId ? [r.tierVariantId] : [])]))];
  type N =
    | {
        __typename: "Product";
        id: string;
        status: string;
        variants: { nodes: { id: string; price: string; productVariantComponents?: { nodes: { quantity: number; productVariant: { id: string } | null }[] } }[] };
      }
    | { __typename: "ProductVariant"; id: string; price: string }
    | null;
  const data = await gql<{ nodes: N[] }>(
    env,
    `query Balloons($ids: [ID!]!) {
       nodes(ids: $ids) {
         __typename
         ... on Product { id status variants(first: 2) { nodes { id price productVariantComponents(first: 5) { nodes { quantity productVariant { id } } } } } }
         ... on ProductVariant { id price }
       }
     }`,
    { ids },
  );
  const byId = new Map(data.nodes.filter((n): n is NonNullable<N> => !!n?.id).map((n) => [n.id, n]));
  const calls: string[] = [];
  const after: (() => void)[] = [];
  const goneBalloons: string[] = [];
  const goneBundles: string[] = [];
  for (const r of rows) {
    const base = byId.get(r.productId);
    if (!base) {
      goneBalloons.push(r.productId);
      out.gone++;
      continue;
    }
    if (base.__typename !== "Product") continue;
    const price = Number(base.variants.nodes[0]?.price ?? 0);
    if (!(price > 0)) {
      out.waiting++;
      continue;
    }
    if (!r.online && ctx.publicationIds.length) {
      calls.push(`publishablePublish(id: ${JSON.stringify(r.productId)}, input: [${ctx.publicationIds.map((p) => `{publicationId: ${JSON.stringify(p)}}`).join(", ")}]) { userErrors { field message } }`);
      after.push(() => out.online++);
    }
    if (r.bundleId && r.bundleVariantId && r.tierVariantId) {
      const bundle = byId.get(r.bundleId);
      const tier = byId.get(r.tierVariantId);
      if (!bundle) {
        goneBundles.push(r.bundleId);
        out.gone++;
        continue;
      }
      if (bundle.__typename !== "Product") continue;
      if (!tier || tier.__typename !== "ProductVariant") {
        out.errors.push("A helium size used by a bundle was removed from the Helium Inflation product.");
        continue;
      }
      // How many times the bundle is filled (1 for bundles this tool makes), read from the bundle itself.
      const fills = bundle.variants.nodes[0]?.productVariantComponents?.nodes.find((c) => c.productVariant?.id === r.tierVariantId)?.quantity ?? 1;
      const want = bundlePrice(price, tier.price, fills);
      const have = Number(bundle.variants.nodes[0]?.price ?? 0).toFixed(2);
      if (have !== want) {
        calls.push(
          `productVariantsBulkUpdate(productId: ${JSON.stringify(r.bundleId)}, variants: [{id: ${JSON.stringify(r.bundleVariantId)}, price: "${want}"}]) { userErrors { field message } }`,
        );
        after.push(() => out.repriced++);
      }
      if (bundle.status === "DRAFT") {
        calls.push(`productUpdate(product: {id: ${JSON.stringify(r.bundleId)}, status: ACTIVE}) { userErrors { field message } }`);
        after.push(() => (have === want ? out.repriced++ : undefined));
      }
    }
  }
  const onlineNow: string[] = [];
  for (let i = 0; i < calls.length; i += 10) {
    const group = calls.slice(i, i + 10);
    try {
      const errs = await manyMutations(env, group);
      errs.forEach((e, k) => {
        if (e.length) out.errors.push(e.map((x) => x.message).join("; "));
        else {
          after[i + k]!();
          const m = /^publishablePublish\(id: "([^"]+)"/.exec(group[k]!);
          if (m) onlineNow.push(m[1]!);
        }
      });
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  await store.markBalloonsOnline(onlineNow);
  await store.markBalloonsDeleted(goneBalloons);
  await store.clearBundles(goneBundles);
  return out;
}

export interface RepriceResult {
  checked: number;
  repriced: number;
  /** A part is still at $0.00 (usually the balloon): left alone so a bundle never sells for the helium alone. */
  waiting: number;
  /** Not set up as a bundle (no parts), so there's nothing to add up. */
  noParts: number;
  /** Bundles that were set up as posted items, now set to collect in store only. */
  unshippable: number;
  errors: string[];
  next: string | null;
}

/**
 * Every helium bundle in the store, whoever made it (this tool, or the one-off script before it): set its price to
 * the sum of its parts (balloon + inflation, times their quantities). 50 bundles per call; send `after` (a Shopify
 * cursor) until `next` is null. A bundle set up as a posted item is set to collect in store only. Status, title
 * and everything else stay as they are.
 */
export async function repriceStoreBundles(env: Env, after = ""): Promise<RepriceResult> {
  type Part = { quantity: number; productVariant: { id?: string; price: string; product?: { title: string; productType?: string | null } | null } | null };
  type V = {
    id: string;
    price: string;
    inventoryItem?: { requiresShipping: boolean } | null;
    productVariantComponents?: { nodes: Part[] };
  };
  type R = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; title?: string; variants: { nodes: V[] } }[] } };
  const data = await gql<R>(
    env,
    `query Bundles($q: String!, $after: String) {
       products(first: 50, after: $after, query: $q) {
         pageInfo { hasNextPage endCursor }
         nodes { id title variants(first: 5) { nodes { id price inventoryItem { requiresShipping } productVariantComponents(first: 10) { nodes { quantity productVariant { id price product { title productType } } } } } } }
       }
     }`,
    { q: `product_type:"${BUNDLE_TYPE}"`, after: after || null },
  );
  const out: RepriceResult = { checked: 0, repriced: 0, waiting: 0, noParts: 0, unshippable: 0, errors: [], next: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null };
  const calls: string[] = [];
  const shipping: string[] = [];
  for (const p of data.products.nodes) {
    for (const v of p.variants.nodes) {
      const parts = v.productVariantComponents?.nodes ?? [];
      out.checked++;
      // Helium balloons are collected from the shop: a bundle set up as a posted item could be sent in an online order.
      if (v.inventoryItem?.requiresShipping) {
        shipping.push(`productVariantsBulkUpdate(productId: ${JSON.stringify(p.id)}, variants: [{id: ${JSON.stringify(v.id)}, inventoryItem: {requiresShipping: false}}]) { userErrors { field message } }`);
      }
      if (!parts.length) {
        out.noParts++;
        continue;
      }
      if (parts.some((c) => !c.productVariant || !(Number(c.productVariant.price) > 0))) {
        out.waiting++;
        continue;
      }
      const cents = parts.reduce((n, c) => n + Math.round(Number(c.productVariant!.price) * 100) * Math.max(1, c.quantity || 1), 0);
      const want = (cents / 100).toFixed(2);
      if (Number(v.price).toFixed(2) === want) continue;
      calls.push(`productVariantsBulkUpdate(productId: ${JSON.stringify(p.id)}, variants: [{id: ${JSON.stringify(v.id)}, price: "${want}"}]) { userErrors { field message } }`);
    }
  }
  for (let i = 0; i < calls.length; i += 10) {
    try {
      const errs = await manyMutations(env, calls.slice(i, i + 10));
      for (const e of errs) {
        if (e.length) out.errors.push(e.map((x) => x.message).join("; "));
        else out.repriced++;
      }
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  for (let i = 0; i < shipping.length; i += 10) {
    try {
      const errs = await manyMutations(env, shipping.slice(i, i + 10));
      for (const e of errs) {
        if (e.length) out.errors.push(e.map((x) => x.message).join("; "));
        else out.unshippable++;
      }
    } catch (e) {
      out.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}
