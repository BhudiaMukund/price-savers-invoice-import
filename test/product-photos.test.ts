import { afterEach, describe, expect, it, vi } from "vitest";
import { createProduct, resetTokenCache } from "../src/shopify";
import { namedPhotos } from "../src/photo-names";
import type { Env } from "../src/types";

const env = { SHOPIFY_STORE_DOMAIN: "shop.myshopify.com", SHOPIFY_API_VERSION: "2026-07", SHOPIFY_ADMIN_TOKEN: "shpat_x" } as unknown as Env;
const ctx = { posPublicationId: null, importSource: { namespace: "custom", key: "import_source", type: "single_line_text_field" } } as any;
afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenCache();
});

function stubShopify(rejectNames: boolean) {
  const inputs: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const { variables } = JSON.parse(init.body);
      inputs.push(structuredClone(variables.input));
      const files = variables.input.files ?? [];
      if (rejectNames && files.some((f: any) => f.filename)) {
        return Response.json({ data: { productSet: { product: null, userErrors: [{ field: ["input", "files", "0", "filename"], message: "Filename is invalid" }] } } });
      }
      return Response.json({ data: { productSet: { product: { id: "gid://shopify/Product/1", media: { nodes: files.map((_: unknown, k: number) => ({ id: `gid://shopify/MediaImage/${k}` })) } }, userErrors: [] } } });
    }),
  );
  return inputs;
}

const product = {
  title: "Black Skull Candle Holder 12cm",
  barcode: null,
  sku: null,
  vendor: null,
  importId: null,
  runCode: null,
  photos: namedPhotos("Black Skull Candle Holder 12cm", ["https://cdn.shopify.com/a/skull-hn-7701.jpg", "https://cdn.shopify.com/a/skull-hn-7701-2.png"]),
};

describe("photo copies on new products", () => {
  it("are named and described from the product title", async () => {
    const inputs = stubShopify(false);
    const r = await createProduct(env, ctx, product);
    expect(r.ok && r.photos).toBe(2);
    expect(inputs[0].files).toEqual([
      { originalSource: "https://cdn.shopify.com/a/skull-hn-7701.jpg", contentType: "IMAGE", alt: "Black Skull Candle Holder 12cm", filename: "black-skull-candle-holder-12cm.jpg" },
      { originalSource: "https://cdn.shopify.com/a/skull-hn-7701-2.png", contentType: "IMAGE", alt: "Black Skull Candle Holder 12cm, photo 2 of 2", filename: "black-skull-candle-holder-12cm-2.png" },
    ]);
  });

  it("keep the photos if Shopify won't take the names", async () => {
    const inputs = stubShopify(true);
    const r = await createProduct(env, ctx, product);
    expect(r.ok && r.photos).toBe(2);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].files.every((f: any) => !("filename" in f) && f.alt)).toBe(true);
  });
});
