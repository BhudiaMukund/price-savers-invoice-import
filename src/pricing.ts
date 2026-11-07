/**
 * Prices for products this tool added. Only the variant price is ever read or written here: nothing in this
 * file touches stock, so saving prices can never add or change inventory.
 *
 * Subrequests per call (Workers free plan allows 50): one to read, then one per 10 products to save.
 */
import { gql } from "./shopify";
import type { Env } from "./types";

export const MAX_PRICE_BATCH = 40;

/** "4.5" → "4.50". Null when it isn't a price (zero, negative, more than cents, too big). Prices include GST. */
export function normalisePrice(v: unknown): string | null {
  const s = (typeof v === "number" ? String(v) : typeof v === "string" ? v : "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n.toFixed(2) : null;
}

export interface PriceRow {
  productId: string;
  title: string;
  status: string;
  sku: string;
  barcode: string;
  /** Current price, or null when the product has more than one variant (not handled here). */
  price: string | null;
  variants: number;
  /** Small photo for the list (about 200px). */
  image: string | null;
  /** Big photo for zooming in and for one-at-a-time pricing. */
  imageLarge: string | null;
}

/** Current prices for these products. Products that no longer exist in the store are left out. */
export async function fetchPrices(env: Env, productIds: string[]): Promise<PriceRow[]> {
  if (!productIds.length) return [];
  type N = {
    id: string;
    title: string;
    status: string;
    featuredMedia: { preview: { image: { small: string; large: string } | null } | null } | null;
    variants: { nodes: { id: string; price: string; sku: string | null; barcode: string | null }[] };
  } | null;
  const data = await gql<{ nodes: N[] }>(
    env,
    `query Prices($ids: [ID!]!) {
       nodes(ids: $ids) {
         ... on Product {
           id title status
           featuredMedia { preview { image { small: url(transform: {maxWidth: 240, maxHeight: 240}) large: url(transform: {maxWidth: 1200, maxHeight: 1200}) } } }
           variants(first: 3) { nodes { id price sku barcode } }
         }
       }
     }`,
    { ids: productIds },
  );
  const rows: PriceRow[] = [];
  for (const n of data.nodes) {
    if (!n?.id) continue;
    const vs = n.variants.nodes;
    rows.push({
      productId: n.id,
      title: n.title,
      status: n.status,
      sku: vs[0]?.sku ?? "",
      barcode: vs[0]?.barcode ?? "",
      price: vs.length === 1 ? Number(vs[0]!.price).toFixed(2) : null,
      variants: vs.length,
      image: n.featuredMedia?.preview?.image?.small ?? null,
      imageLarge: n.featuredMedia?.preview?.image?.large ?? null,
    });
  }
  return rows;
}

export type PriceResult = { productId: string; ok: true; price: string } | { productId: string; ok: false; error: string };

/** Set the price of single-variant products. Each product is checked first so a multi-variant one is never touched. */
export async function setPrices(env: Env, items: { productId: string; price: string }[]): Promise<PriceResult[]> {
  const current = await fetchVariantIds(env, items.map((i) => i.productId));
  const out = new Map<string, PriceResult>();
  const todo: { productId: string; variantId: string; price: string }[] = [];
  for (const it of items) {
    const v = current.get(it.productId);
    if (!v) out.set(it.productId, { productId: it.productId, ok: false, error: "That product wasn't found in the store." });
    else if (v.length !== 1) out.set(it.productId, { productId: it.productId, ok: false, error: "This product has several variants. Set its prices in Shopify." });
    else todo.push({ productId: it.productId, variantId: v[0]!, price: it.price });
  }
  for (let i = 0; i < todo.length; i += 10) {
    const group = todo.slice(i, i + 10);
    const body = group
      .map((t, k) => `m${k}: productVariantsBulkUpdate(productId: "${t.productId}", variants: [{id: "${t.variantId}", price: "${t.price}"}]) { userErrors { field message } }`)
      .join("\n");
    try {
      const data = await gql<Record<string, { userErrors: { message: string }[] }>>(env, `mutation { ${body} }`);
      group.forEach((t, k) => {
        const errs = data[`m${k}`]?.userErrors ?? [];
        out.set(t.productId, errs.length ? { productId: t.productId, ok: false, error: errs.map((e) => e.message).join("; ") } : { productId: t.productId, ok: true, price: t.price });
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      for (const t of group) out.set(t.productId, { productId: t.productId, ok: false, error });
    }
  }
  return items.map((i) => out.get(i.productId)!);
}

async function fetchVariantIds(env: Env, ids: string[]): Promise<Map<string, string[]>> {
  const data = await gql<{ nodes: ({ id: string; variants: { nodes: { id: string }[] } } | null)[] }>(
    env,
    `query V($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id variants(first: 3) { nodes { id } } } } }`,
    { ids },
  );
  return new Map(data.nodes.filter((n): n is NonNullable<typeof n> => !!n?.id).map((n) => [n.id, n.variants.nodes.map((v) => v.id)]));
}
