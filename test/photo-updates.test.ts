import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { CatalogueStore } from "../src/catalogue";
import { resetSchemaCache } from "../src/store";
import { resetTokenCache } from "../src/shopify";
import type { Env } from "../src/types";
import { sqliteDb } from "./sqlite-db";
// @ts-expect-error plain JS module shared with the browser
import { decideKind } from "../public/js/photo-updates.js";

describe("deciding what a catalogue photo is", () => {
  const cur = { width: 400, height: 400, createdAt: "2026-09-01T00:00:00Z" };
  it("same picture, clearly bigger: sharper", () => {
    expect(decideKind(cur, { width: 1000, height: 1000, createdAt: "2026-08-01T00:00:00Z" }, true)).toBe("sharper");
  });
  it("same picture, about the same size: nothing", () => {
    expect(decideKind(cur, { width: 420, height: 420, createdAt: "2026-10-01T00:00:00Z" }, true)).toBe("none");
  });
  it("different picture from a newer catalogue: new", () => {
    expect(decideKind(cur, { width: 300, height: 300, createdAt: "2026-10-30T00:00:00Z" }, false)).toBe("new");
  });
  it("different picture from an older catalogue: nothing (the store's photo is the newer one)", () => {
    expect(decideKind(cur, { width: 2000, height: 2000, createdAt: "2026-08-01T00:00:00Z" }, false)).toBe("none");
  });
});

const env = {
  SHOPIFY_STORE_DOMAIN: "t.myshopify.com",
  SHOPIFY_API_VERSION: "2026-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "m",
  GEMINI_API_KEY: "k",
  DEV_AUTH_BYPASS: "true",
} as unknown as Env;

const PID = "gid://shopify/Product/500";
const OLD = "gid://shopify/MediaImage/600";
const CAT = "gid://shopify/MediaImage/700";
let added: string[];
let deleted: string[];
let moved: { id: string; pos: string }[];
let store: CatalogueStore;

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

beforeEach(async () => {
  resetTokenCache();
  resetSchemaCache();
  const db = sqliteDb();
  (env as any).DB = db;
  store = new CatalogueStore(db as any);
  added = [];
  deleted = [];
  moved = [];
  let n = 800;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: any) => {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("query PI(")) {
        return Response.json({ data: { nodes: [{ id: PID, title: "Gold Star Balloon", vendor: "Alpen", variants: { nodes: [{ barcode: "9300000000019", sku: "A1" }] }, featuredMedia: { id: OLD, createdAt: "2026-09-01T00:00:00Z", image: { url: "https://cdn.shopify.com/old.jpg", width: 300, height: 300 } } }] } });
      }
      if (query.includes("query FI(")) return Response.json({ data: { nodes: [{ id: CAT, createdAt: "2026-10-29T00:00:00Z", image: { url: "https://cdn.shopify.com/cat.jpg", width: 1200, height: 1200 } }] } });
      if (query.includes("query F(")) return Response.json({ data: { nodes: variables.ids.map((id: string) => ({ id, fileStatus: "READY", image: { url: "https://cdn.shopify.com/cat.jpg" } })) } });
      if (query.includes("productUpdate")) {
        added.push(variables.media[0].originalSource);
        return Response.json({ data: { productUpdate: { product: { id: PID, media: { nodes: [{ id: OLD }, { id: `gid://shopify/MediaImage/${++n}` }] } }, userErrors: [] } } });
      }
      if (query.includes("productReorderMedia")) {
        moved.push({ id: variables.moves[0].id, pos: variables.moves[0].newPosition });
        return Response.json({ data: { productReorderMedia: { job: { id: "j" }, userErrors: [] } } });
      }
      if (query.includes("fileDelete")) {
        deleted.push(...variables.ids);
        return Response.json({ data: { fileDelete: { deletedFileIds: variables.ids, userErrors: [] } } });
      }
      return Response.json({ errors: [{ message: `unmocked ${query.slice(0, 40)}` }] });
    }),
  );
  await json(call("POST", "/api/catalogues", { supplier: "Alpen", fileNames: ["a.csv"] }));
  const up = await store.open("C1");
  await store.addFile({ fileId: CAT, fingerprint: null, uploadId: up.id, status: "ready", url: "https://cdn.shopify.com/cat.jpg", source: "x" });
  await store.addItems("C1", [{ barcode: "9300000000019", code: "A1", title: "Gold Star", description: null, mixed: false, photos: [CAT] } as any]);
  await json(call("POST", "/api/catalogues/C1/finish", {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("better photos for products in the store", () => {
  it("lists a product whose catalogue photo it doesn't have yet, with both photos' sizes", async () => {
    const res = await json(call("POST", "/api/photo-updates/candidates", { mode: "products", productIds: [PID] }));
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({ productId: PID, current: { mediaId: OLD, width: 300 }, next: { fileId: CAT, width: 1200 } });
  });

  it("a sharper copy goes in first and the old copy comes off; the pair isn't offered again", async () => {
    const res = await json(call("POST", "/api/photo-updates/apply", { items: [{ productId: PID, title: "Gold Star Balloon", fileId: CAT, kind: "sharper", old: { mediaId: OLD, url: "https://cdn.shopify.com/old.jpg", width: 300, height: 300 } }] }));
    expect(res.results[0]).toMatchObject({ ok: true });
    expect(added).toEqual(["https://cdn.shopify.com/cat.jpg"]);
    expect(moved[0]).toMatchObject({ pos: "0" });
    expect(deleted).toEqual([OLD]);
    const again = await json(call("POST", "/api/photo-updates/candidates", { mode: "products", productIds: [PID] }));
    expect(again.candidates).toHaveLength(0);
  });

  it("a new picture goes in front and waits for review; Put back restores the old one", async () => {
    await json(call("POST", "/api/photo-updates/apply", { items: [{ productId: PID, title: "Gold Star Balloon", fileId: CAT, kind: "new", old: { mediaId: OLD, url: "https://cdn.shopify.com/old.jpg", width: 300, height: 300 } }] }));
    expect(deleted).toEqual([]); // the old photo stays, second
    const list = await json(call("GET", "/api/photo-updates?view=review"));
    expect(list.counts.review).toBe(1);
    const row = list.rows[0];
    const back = await json(call("POST", `/api/photo-updates/${row.id}/decide`, { action: "put-back" }));
    expect(back).toMatchObject({ ok: true, status: "undone" });
    expect(moved.at(-1)).toEqual({ id: OLD, pos: "0" });
    expect(deleted).toEqual([row.newMediaId]);
    expect((await json(call("GET", "/api/photo-updates?view=review"))).counts.review).toBe(0);
  });

  it("only fetches Shopify's own photos for comparing", async () => {
    const res = await call("GET", `/api/photo-updates/image?url=${encodeURIComponent("https://example.com/x.jpg")}`);
    expect(res.status).toBe(400);
  });
});
