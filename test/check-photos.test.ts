import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { CatalogueStore } from "../src/catalogue";
import { resetSchemaCache } from "../src/store";
import type { Env } from "../src/types";
import { sqliteDb } from "./sqlite-db";

const env = {
  SHOPIFY_STORE_DOMAIN: "test.myshopify.com",
  SHOPIFY_API_VERSION: "2026-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "gemini-test",
  GEMINI_API_KEY: "k",
  DEV_AUTH_BYPASS: "true",
} as unknown as Env;

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

const id = (n: number) => `gid://shopify/MediaImage/${n}`;
let shopify: Record<string, any>;
let store: CatalogueStore;

beforeEach(async () => {
  resetSchemaCache();
  const db = sqliteDb();
  (env as any).DB = db;
  store = new CatalogueStore(db as any);
  shopify = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("nodes(")) return Response.json({ data: { nodes: body.variables.ids.map((i: string) => shopify[i] ?? null) } });
      return Response.json({ errors: [{ message: "unmocked" }] });
    }),
  );
  await json(call("POST", "/api/catalogues", { supplier: "Lylac", fileNames: ["l.csv"] }));
});
afterEach(() => vi.unstubAllGlobals());

describe("checking photos that say processing", () => {
  it("readies finished ones, fails the unknown ones, and leaves recent ones waiting", async () => {
    const up = await store.open("C1");
    for (const n of [1, 2, 3]) await store.addFile({ fileId: id(n), fingerprint: null, uploadId: up.id, status: "processing", url: null, source: `https://l/${n}.jpg` });
    shopify[id(1)] = { id: id(1), fileStatus: "READY", image: { url: "https://cdn/1.jpg" } };
    shopify[id(2)] = { id: id(2), fileStatus: "PROCESSING" }; // fresh: still waiting
    // id(3): Shopify has never heard of it
    const res = await json(call("POST", "/api/catalogues/C1/check-photos", {}));
    expect(res).toMatchObject({ checked: 3, ready: 1, waiting: 1, gone: 1, failed: 0, next: null });
    const after = await json(call("GET", "/api/catalogues/C1"));
    expect(after.upload.photos).toMatchObject({ ready: 1, processing: 1, failed: 1 });
    expect(after.upload.failed[0].error).toMatch(/no record/);
  });
});
