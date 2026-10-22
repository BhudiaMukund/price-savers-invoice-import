import { afterEach, describe, expect, it, vi } from "vitest";
import { addPhotosToProduct } from "../src/files";
import type { Env } from "../src/types";

const env = { SHOPIFY_STORE_DOMAIN: "t.myshopify.com", SHOPIFY_API_VERSION: "2026-07", SHOPIFY_ADMIN_TOKEN: "t" } as unknown as Env;
afterEach(() => vi.unstubAllGlobals());

describe("adding photos to a product", () => {
  it("doesn't ask Shopify for media(last: n), which newer API versions refuse", async () => {
    let query = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: any) => {
        query = JSON.parse(init.body).query;
        return Response.json({ data: { productUpdate: { product: { id: "gid://shopify/Product/1", media: { nodes: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }] } }, userErrors: [] } } });
      }),
    );
    const res = await addPhotosToProduct(env, "gid://shopify/Product/1", [
      { url: "https://x.example/a.jpg", alt: "a" },
      { url: "https://x.example/b.jpg", alt: "b" },
    ]);
    expect(query).not.toMatch(/\blast\s*:/);
    expect(res).toEqual({ error: null, mediaIds: ["m4", "m5"] }); // the new copies are the last two of the product's media
  });
});
