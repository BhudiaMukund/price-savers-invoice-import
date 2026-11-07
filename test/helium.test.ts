import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { resetTokenCache } from "../src/shopify";
import type { Env } from "../src/types";
import { RunStore, resetSchemaCache } from "../src/store";
import { sqliteDb } from "./sqlite-db";
// @ts-expect-error plain JS module shared with the browser
import { balloonSize, bundlePrice, bundleTitle, heliumSuggestion, isFoilBalloon, pickTier, tierRange } from "../public/js/helium.js";

const T = (variantId: string, title: string, price: string) => {
  const r = tierRange(title);
  return { variantId, title, price, min: r?.[0] ?? null, max: r?.[1] ?? null };
};
const TIERS = [T("V40", "40-50cm", "6.00"), T("V50", "50-80cm", "8.00"), T("V80", "80-100cm", "12.00"), T("V100", "100-110cm", "15.00")];

describe("reading a balloon title", () => {
  it("finds the size in cm or inches", () => {
    expect(balloonSize("Gold Star Foil Balloon 45cm")).toBe(45);
    expect(balloonSize("Number 3 Foil Balloon 34in")).toBe(86);
    expect(balloonSize('Unicorn Foil Balloon 18"')).toBe(46);
    expect(balloonSize("Supershape 34-Inch Foil Balloon")).toBe(86);
    expect(balloonSize("Foil Balloon Luxe Gold Number #3")).toBeNull();
  });

  it("knows foil balloons from latex, air-fill, sticks and foil banners", () => {
    expect(isFoilBalloon("Gold Star Foil Balloon 45cm")).toBe(true);
    expect(isFoilBalloon("Rose Gold Supershape Balloon 86cm")).toBe(true);
    expect(isFoilBalloon("Latex Balloons 30cm Pack of 25")).toBe(false);
    expect(isFoilBalloon("Foil Balloon Air Fill 23cm")).toBe(false);
    expect(isFoilBalloon("Foil Balloon on Stick 23cm")).toBe(false);
    expect(isFoilBalloon("Happy Birthday Foil Banner 2.5m")).toBe(false);
  });

  it("spots foil balloons whose tidied title dropped the word foil", () => {
    expect(isFoilBalloon("Happy New Year Bottle Balloon 98cm", { code: "FB164" })).toBe(true);
    expect(isFoilBalloon("Bon Voyage Balloon", { invoiceTitle: 'FBAL.18" BON VOYAGE' })).toBe(true);
    expect(isFoilBalloon("Red Number 6 Balloon", { invoiceTitle: 'FB34" DECROTEX RED #6' })).toBe(true);
    expect(isFoilBalloon("Cocktail Glass Balloon 126cm")).toBe(true); // a big balloon that isn't latex
    expect(isFoilBalloon("Giant Latex Balloon 90cm", { code: "LB90" })).toBe(false);
    expect(isFoilBalloon("Pastel Balloons 30cm Pack of 20")).toBe(false); // small, nothing says foil
    expect(isFoilBalloon("Gold Foil Curtain 2m", { code: "FC2" })).toBe(false);
    expect(heliumSuggestion("Whisky Bottle Balloon 86cm", TIERS, { code: "FB423" })).toMatchObject({ foil: true, size: 86, tier: "V80", bundle: true });
    expect(heliumSuggestion("Star Balloon", TIERS, { code: "FB1", invoiceTitle: 'FBAL.18" STAR GOLD' })).toMatchObject({ size: 46, tier: "V40", bundle: true });
  });

  it("reads the size each inflation variant covers", () => {
    expect(tierRange("40-50cm")).toEqual([40, 50]);
    expect(tierRange("80 – 100 cm")).toEqual([80, 100]);
    expect(tierRange("115cm+")).toEqual([115, 999]);
    expect(tierRange("Standard 45cm / 18in")).toEqual([45, 45]);
    expect(tierRange("Default Title")).toBeNull();
    expect(tierRange("Helium Inflation 16-20in")).toEqual([41, 51]);
    expect(tierRange("Helium Inflation 34in")).toEqual([86, 86]);
  });

  it("picks the inflation that fits, the smaller one on a boundary", () => {
    expect(pickTier(45, TIERS).variantId).toBe("V40");
    expect(pickTier(50, TIERS).variantId).toBe("V40");
    expect(pickTier(86, TIERS).variantId).toBe("V80");
    expect(pickTier(23, TIERS)).toBeNull();
    expect(pickTier(140, TIERS)).toBeNull();
    expect(pickTier(47, [T("S", "Standard 45cm / 18in", "6.00")]).variantId).toBe("S"); // within 10% of a single size
  });

  it("suggests a bundle only for foil balloons of 40cm or more that fit a size", () => {
    expect(heliumSuggestion("Gold Star Foil Balloon 45cm", TIERS)).toEqual({ foil: true, size: 45, tier: "V40", bundle: true });
    expect(heliumSuggestion("Mini Heart Foil Balloon 23cm", TIERS)).toMatchObject({ foil: true, bundle: false });
    expect(heliumSuggestion("Foil Balloon Luxe Gold Number #3", TIERS)).toMatchObject({ foil: true, size: null, bundle: false });
    expect(heliumSuggestion("Paper Plates 23cm", TIERS)).toMatchObject({ foil: false, bundle: false });
  });

  it("names and prices the bundle like the store's own", () => {
    expect(bundleTitle("Foil Balloon Luxe Gold Number #3")).toBe("Helium INFLATED Luxe Gold Number #3 Foil Balloon");
    expect(bundleTitle("Gold Star Foil Balloon 45cm")).toBe("Helium INFLATED Gold Star 45cm Foil Balloon");
    expect(bundlePrice("8.00", "12.00")).toBe("20.00");
    expect(bundlePrice("0.1", "0.2")).toBe("0.30");
  });
});

/* ------------------------------------------------------------------ the whole flow against a pretend Shopify */

const env = {
  SHOPIFY_STORE_DOMAIN: "t.myshopify.com",
  SHOPIFY_API_VERSION: "2026-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "m",
  GEMINI_API_KEY: "k",
  DEV_AUTH_BYPASS: "true",
} as unknown as Env;

type P = { id: string; input: any; variantId: string; price: string; status: string; channels: string[]; metafield: string };
let shop: Map<string, P>;
let links: any[];
let deleted: string[];
let existingTitles: string[];
const inflation = {
  id: "gid://shopify/Product/900",
  title: "Helium Inflation",
  productType: "Service",
  variants: { nodes: [{ id: "gid://shopify/ProductVariant/940", title: "40-50cm", price: "6.00" }, { id: "gid://shopify/ProductVariant/980", title: "80-100cm", price: "12.00" }] },
};
const IMPORT = "20261029-R1-ALPEN-K3F9";

beforeEach(async () => {
  resetTokenCache();
  resetSchemaCache();
  (env as any).DB = sqliteDb();
  await new RunStore((env as any).DB).createRun("dev@local"); // R1
  shop = new Map();
  links = [];
  deleted = [];
  existingTitles = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("locations(")) {
        return Response.json({
          data: {
            locations: { nodes: [{ id: "L1", name: "Shop" }] },
            publications: { nodes: [{ id: "P1", name: "Online Store" }, { id: "P2", name: "Point of Sale" }, { id: "P3", name: "Shop" }] },
            metafieldDefinitions: { nodes: [{ type: { name: "single_line_text_field" } }] },
          },
        });
      }
      if (query.includes("query HeliumSizes")) return Response.json({ data: { nodes: variables.ids.map((id: string) => (id === inflation.id ? inflation : null)) } });
      if (query.includes("query Helium")) {
        return Response.json({ data: { bundles: { nodes: [{ variants: { nodes: [{ productVariantComponents: { nodes: [{ productVariant: { product: { id: "gid://shopify/Product/1", title: "Foil Balloon X", productType: "Foil Balloons" } } }, { productVariant: { product: inflation } }] } }] } }] }, named: { nodes: [] } } });
      }
      if (query.includes("query Titles")) return Response.json({ data: { products: { nodes: existingTitles.map((title) => ({ title })) } } });
      if (query.includes("productVariantRelationshipBulkUpdate")) {
        links.push(variables.input[0]);
        return Response.json({ data: { productVariantRelationshipBulkUpdate: { parentProductVariants: [{ id: variables.input[0].parentProductVariantId }], userErrors: [] } } });
      }
      if (query.startsWith("mutation {")) {
        // aliased changes from syncing and pricing
        const data: Record<string, unknown> = {};
        for (const m of query.matchAll(/(m\d+): productVariantsBulkUpdate\(productId: "([^"]+)", variants: \[\{id: "[^"]+", price: "([^"]+)"\}\]\)/g)) {
          shop.get(m[2])!.price = m[3];
          data[m[1]] = { userErrors: [] };
        }
        for (const m of query.matchAll(/(m\d+): productUpdate\(product: \{id: "([^"]+)", status: ACTIVE\}\)/g)) {
          shop.get(m[2])!.status = "ACTIVE";
          data[m[1]] = { userErrors: [] };
        }
        for (const m of query.matchAll(/(m\d+): publishablePublish\(id: "([^"]+)", input: \[([^\]]*)\]\)/g)) {
          shop.get(m[2])!.channels = [...m[3].matchAll(/"(P\d)"/g)].map((x) => x[1]);
          data[m[1]] = { userErrors: [] };
        }
        return Response.json({ data });
      }
      if (query.includes("productVariants")) return Response.json({ data: { productVariants: { nodes: [] } } });
      if (query.includes("productSet")) {
        n++;
        const id = `gid://shopify/Product/${n}`;
        const v = variables.input.variants[0];
        shop.set(id, { id, input: variables.input, variantId: `gid://shopify/ProductVariant/${n}`, price: v.price, status: variables.input.status, channels: [], metafield: variables.input.metafields?.[0]?.value ?? "" });
        return Response.json({ data: { productSet: { product: { id, media: { nodes: [] }, variants: { nodes: [{ id: `gid://shopify/ProductVariant/${n}` }] } }, userErrors: [] } } });
      }
      if (query.includes("publishablePublish")) {
        shop.get(variables.id)!.channels = variables.input.map((p: any) => p.publicationId);
        return Response.json({ data: { publishablePublish: { userErrors: [] } } });
      }
      if (query.includes("query Balloons")) {
        return Response.json({
          data: {
            nodes: variables.ids.map((id: string) => {
              const p = shop.get(id);
              if (p) return { __typename: "Product", id, status: p.status, variants: { nodes: [{ id: p.variantId, price: p.price }] } };
              const v = inflation.variants.nodes.find((x) => x.id === id);
              return v ? { __typename: "ProductVariant", id, price: v.price } : null;
            }),
          },
        });
      }
      if (query.includes("query V(")) {
        return Response.json({ data: { nodes: variables.ids.map((id: string) => (shop.has(id) ? { id, variants: { nodes: [{ id: shop.get(id)!.variantId }] } } : null)) } });
      }
      if (query.includes("query Check")) {
        return Response.json({ data: { nodes: variables.ids.map((id: string) => (shop.has(id) ? { id, metafield: { value: shop.get(id)!.metafield }, variants: { nodes: [{ price: shop.get(id)!.price }] } } : null)) } });
      }
      if (query.includes("productDelete")) {
        deleted.push(variables.id);
        shop.delete(variables.id);
        return Response.json({ data: { productDelete: { deletedProductId: variables.id, userErrors: [] } } });
      }
      return Response.json({ errors: [{ message: `unmocked: ${query.slice(0, 60)}` }] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const post = async (path: string, body: unknown) =>
  (await app.fetch(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env)).json() as Promise<any>;
const balloon = (extra: Record<string, unknown> = {}) => ({
  id: "a",
  invoiceId: "s1",
  title: "Gold Star Foil Balloon 45cm",
  supplierCode: "FB45",
  barcode: null,
  vendor: "Alpen",
  importId: IMPORT,
  foil: true,
  helium: "gid://shopify/ProductVariant/940",
  ...extra,
});

describe("helium bundles for new foil balloons", () => {
  it("adds an unpriced balloon to POS only, with its bundle waiting as a $0 draft", async () => {
    const res = await post("/api/create", { runCode: "R1", items: [balloon()] });
    expect(res.results[0]).toMatchObject({ status: "created", bundle: { status: "created" } });
    const [base, bundle] = [...shop.values()];
    expect(base!.input).toMatchObject({ productType: "Foil Balloons", status: "ACTIVE" });
    expect(base!.input.variants[0].inventoryItem.requiresShipping).toBe(true);
    expect(base!.channels).toEqual(["P2"]); // not online at $0
    expect(bundle!.input).toMatchObject({ title: "Helium INFLATED Gold Star 45cm Foil Balloon", productType: "Helium Inflated Balloons", status: "DRAFT" });
    expect(bundle!.input.variants[0]).toMatchObject({ price: "0.00", requiresComponents: true });
    expect(bundle!.channels).toEqual(["P1", "P2", "P3"]);
    expect(bundle!.metafield).toBe(IMPORT); // so Undo can remove it
    expect(links[0]).toEqual({
      parentProductVariantId: bundle!.variantId,
      productVariantRelationshipsToCreate: [
        { id: base!.variantId, quantity: 1 },
        { id: "gid://shopify/ProductVariant/940", quantity: 1 },
      ],
    });
  });

  it("prices a balloon added with a price: bundle live at balloon + inflation, balloon on every channel", async () => {
    await post("/api/create", { runCode: "R1", items: [balloon({ price: "8" })] });
    const [base, bundle] = [...shop.values()];
    expect(base!.channels).toEqual(["P1", "P2", "P3"]);
    expect(bundle!.input.status).toBe("ACTIVE");
    expect(bundle!.input.variants[0].price).toBe("14.00");
  });

  it("makes no bundle when one with that name is already in the store, or when staff untick it", async () => {
    existingTitles = ["Helium INFLATED Gold Star 45cm Foil Balloon"];
    const res = await post("/api/create", { runCode: "R1", items: [balloon(), balloon({ id: "b", title: "Silver Moon Foil Balloon 45cm", helium: null })] });
    expect(res.results[0].bundle).toMatchObject({ status: "skipped" });
    expect(res.results[1].bundle).toBeUndefined();
    expect(shop.size).toBe(2); // the two balloons only
    expect(links).toHaveLength(0);
  });

  it("pricing the balloon later prices and opens its bundle, and puts the balloon online", async () => {
    await post("/api/create", { runCode: "R1", items: [balloon()] });
    const [base, bundle] = [...shop.values()];
    const res = await post("/api/prices", { items: [{ productId: base!.id, price: "8.00" }] });
    expect(res.results[0]).toMatchObject({ ok: true });
    expect(res.balloons).toMatchObject({ online: 1, repriced: 1 });
    expect(bundle!.price).toBe("14.00");
    expect(bundle!.status).toBe("ACTIVE");
    expect(base!.channels).toEqual(["P1", "P2", "P3"]);
  });

  it("Update helium bundles picks up a price set at the till, and a new inflation price", async () => {
    await post("/api/create", { runCode: "R1", items: [balloon()] });
    const [base, bundle] = [...shop.values()];
    base!.price = "9.00"; // priced at the till
    let res = await post("/api/balloons/sync", {});
    expect(res).toMatchObject({ checked: 1, online: 1, repriced: 1, next: null });
    expect(bundle!.price).toBe("15.00");
    inflation.variants.nodes[0]!.price = "7.00";
    res = await post("/api/balloons/sync", {});
    expect(res).toMatchObject({ online: 0, repriced: 1 });
    expect(bundle!.price).toBe("16.00");
    inflation.variants.nodes[0]!.price = "6.00";
  });

  it("Undo removes the bundle before its balloon", async () => {
    await post("/api/create", { runCode: "R1", items: [balloon()] });
    const [base, bundle] = [...shop.values()];
    const res = await post("/api/undo", { importId: IMPORT, productIds: [base!.id] });
    expect(res.results).toEqual([{ id: base!.id, status: "deleted" }]);
    expect(deleted).toEqual([bundle!.id, base!.id]);
  });

  it("refuses a batch with too many bundles for one request", async () => {
    const items = Array.from({ length: 13 }, (_, i) => balloon({ id: `r${i}`, title: `Star ${i} Foil Balloon 45cm` }));
    const res = await app.fetch(new Request("http://x/api/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runCode: "R1", items }) }), env);
    expect(res.status).toBe(400);
  });
});

describe("finding the inflation sizes", () => {
  it("reads one product per size (Default Title variants) and sorts them by size", async () => {
    const products: Record<string, any> = {
      "gid://shopify/Product/71": { id: "gid://shopify/Product/71", title: "Helium Inflation 80-100cm", productType: "Service", variants: { nodes: [{ id: "gid://shopify/ProductVariant/711", title: "Default Title", price: "12" }] } },
      "gid://shopify/Product/72": { id: "gid://shopify/Product/72", title: "Helium Inflation 40-50cm", productType: "Service", variants: { nodes: [{ id: "gid://shopify/ProductVariant/721", title: "Default Title", price: "6" }] } },
      "gid://shopify/Product/73": { id: "gid://shopify/Product/73", title: "Helium Inflation 50-80cm", productType: "Service", variants: { nodes: [{ id: "gid://shopify/ProductVariant/731", title: "Default Title", price: "8" }] } },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: any) => {
        const { query, variables } = JSON.parse(init.body);
        if (query.includes("query HeliumSizes")) return Response.json({ data: { nodes: variables.ids.map((id: string) => products[id] ?? null) } });
        if (query.includes("query Helium")) {
          const light = (p: any) => ({ id: p.id, title: p.title, productType: p.productType });
          return Response.json({
            data: {
              bundles: { nodes: [{ variants: { nodes: [{ productVariantComponents: { nodes: [{ productVariant: { product: { id: "gid://shopify/Product/5", title: "Foil Balloon Gold #3", productType: "Foil Balloons" } } }, { productVariant: { product: light(products["gid://shopify/Product/71"]) } }] } }] } }] },
              named: { nodes: [light(products["gid://shopify/Product/72"]), light(products["gid://shopify/Product/73"]), { id: "gid://shopify/Product/9", title: "Helium INFLATED Star Foil Balloon", productType: "Helium Inflated Balloons" }] },
            },
          });
        }
        return Response.json({ errors: [{ message: "unmocked" }] });
      }),
    );
    const { findInflation } = await import("../src/helium");
    const inf = await findInflation(env);
    expect(inf!.tiers.map((t) => [t.title, t.price, t.min, t.max])).toEqual([
      ["Helium Inflation 40-50cm", "6.00", 40, 50],
      ["Helium Inflation 50-80cm", "8.00", 50, 80],
      ["Helium Inflation 80-100cm", "12.00", 80, 100],
    ]);
  });
});

describe("repricing every helium bundle in the store", () => {
  it("sets each bundle to the sum of its parts, and leaves ones with a $0 balloon or no parts alone", async () => {
    const updates: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: any) => {
        const { query, variables } = JSON.parse(init.body);
        if (query.includes("query Bundles")) {
          expect(variables.q).toBe('product_type:"Helium Inflated Balloons"');
          const v = (id: string, price: string, parts: [string, number][]) => ({ id, price, productVariantComponents: { nodes: parts.map(([p, q]) => ({ quantity: q, productVariant: { price: p } })) } });
          return Response.json({
            data: {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: "gid://shopify/Product/1", variants: { nodes: [v("gid://shopify/ProductVariant/1", "20.00", [["8.00", 1], ["15.00", 1]])] } }, // inflation went 12 -> 15
                  { id: "gid://shopify/Product/2", variants: { nodes: [v("gid://shopify/ProductVariant/2", "14.00", [["8.00", 1], ["6.00", 1]])] } }, // already right
                  { id: "gid://shopify/Product/3", variants: { nodes: [v("gid://shopify/ProductVariant/3", "0.00", [["0.00", 1], ["6.00", 1]])] } }, // balloon unpriced
                  { id: "gid://shopify/Product/4", variants: { nodes: [v("gid://shopify/ProductVariant/4", "20.00", [])] } }, // not a real bundle
                ],
              },
            },
          });
        }
        if (query.startsWith("mutation {")) {
          for (const m of query.matchAll(/productVariantsBulkUpdate\(productId: "([^"]+)", variants: \[\{id: "[^"]+", price: "([^"]+)"\}\]\)/g)) updates.push(`${m[1]}=${m[2]}`);
          return Response.json({ data: { m0: { userErrors: [] } } });
        }
        return Response.json({ errors: [{ message: "unmocked" }] });
      }),
    );
    const res = await post("/api/bundles/reprice", {});
    expect(res).toMatchObject({ checked: 4, repriced: 1, waiting: 1, noParts: 1, next: null });
    expect(updates).toEqual(["gid://shopify/Product/1=23.00"]);
  });
});
