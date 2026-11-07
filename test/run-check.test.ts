import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";
import { RunStore, resetSchemaCache } from "../src/store";
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

const A = "gid://shopify/Product/1";
const B = "gid://shopify/Product/2";
const C = "gid://shopify/Product/3";
let inStore = new Set<string>();
let queries: string[] = [];
let store: RunStore;
let runId: number;

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

beforeEach(async () => {
  resetSchemaCache();
  (env as any).DB = sqliteDb();
  store = new RunStore((env as any).DB);
  const run = await store.createRun("dev@local");
  runId = (await store.runId(run.code))!;
  await store.recordProducts(
    [
      { productId: A, runId, invoiceId: "s1", importId: "i1", title: "A", barcode: null, vendor: "V" },
      { productId: B, runId, invoiceId: "s1", importId: "i1", title: "B", barcode: null, vendor: "V" },
      { productId: C, runId, invoiceId: "s2", importId: "i2", title: "C", barcode: null, vendor: "V" },
    ],
    "dev@local",
  );
  inStore = new Set([A, B, C]);
  queries = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      queries.push(body.query);
      if (body.query.includes("Present($ids")) return Response.json({ data: { nodes: body.variables.ids.map((id: string) => (inStore.has(id) ? { id } : null)) } });
      return Response.json({ errors: [{ message: "unmocked" }] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("checking a run against Shopify", () => {
  it("lets go of products that were deleted by hand", async () => {
    inStore.delete(A);
    inStore.delete(B);
    const res = await json(call("POST", "/api/runs/R1/check", {}));
    expect(res.removedIds.sort()).toEqual([A, B]);
    expect(res.liveByInvoice).toEqual({ s2: 1 });
    // the run no longer counts invoice s1, so it can be removed
    expect((await store.getRun("R1"))!.liveByInvoice).toEqual({ s2: 1 });
  });
  it("keeps products that are still there", async () => {
    const res = await json(call("POST", "/api/runs/R1/check", {}));
    expect(res.removedIds).toEqual([]);
    expect(res.liveByInvoice).toEqual({ s1: 2, s2: 1 });
  });
  it("reports existing products that stock was added to and are gone", async () => {
    const X = "gid://shopify/Product/9";
    const res = await json(call("POST", "/api/runs/R1/check", { productIds: [X, A] }));
    expect(res.missingIds).toEqual([X]);
  });
  it("only reads from Shopify", async () => {
    inStore.delete(A);
    await call("POST", "/api/runs/R1/check", {});
    expect(queries.every((q) => q.trimStart().startsWith("query"))).toBe(true);
  });
  it("lets the run be deleted once everything is gone", async () => {
    inStore.clear();
    await call("POST", "/api/runs/R1/check", {});
    expect((await call("DELETE", "/api/runs/R1")).status).toBe(200);
  });
});

describe("letting an invoice go while its products stay", () => {
  it("stops tracking just that invoice, without touching Shopify", async () => {
    const res = await json(call("POST", "/api/runs/R1/release", { invoiceId: "s1" }));
    expect(res.released).toBe(2);
    expect((await store.getRun("R1"))!.liveByInvoice).toEqual({ s2: 1 });
    expect(queries.length).toBe(0);
  });
  it("refuses a bad invoice id", async () => {
    expect((await call("POST", "/api/runs/R1/release", { invoiceId: "a b" })).status).toBe(400);
  });
});
