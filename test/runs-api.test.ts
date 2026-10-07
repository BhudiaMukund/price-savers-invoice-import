import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { RunStore, resetSchemaCache } from "../src/store";
import type { Env } from "../src/types";
import { sqliteDb } from "./sqlite-db";

let env: Env;
beforeEach(() => {
  resetSchemaCache();
  env = { SHOPIFY_STORE_DOMAIN: "t.myshopify.com", DEV_AUTH_BYPASS: "true", DB: sqliteDb() } as unknown as Env;
});

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );

describe("runs API", () => {
  it("creates a run for the signed-in person and opens it", async () => {
    const created: any = await (await call("POST", "/api/runs")).json();
    expect(created.run).toMatchObject({ code: "R1", createdBy: "dev@local", version: 1 });
    const got: any = await (await call("GET", "/api/runs/R1")).json();
    expect(got.run.data).toEqual({ sources: [], rows: [] });
  });

  it("saves, lists and searches", async () => {
    await call("POST", "/api/runs");
    const save = await call("PUT", "/api/runs/R1", { version: 1, data: { sources: [{ id: "s1", name: "alpen.pdf", supplier: "Alpen" }], rows: [{ title: "Gold Banner", sourceId: "s1" }] } });
    expect(((await save.json()) as any).version).toBe(2);
    const list: any = await (await call("GET", "/api/runs?q=gold")).json();
    expect(list.runs.map((r: any) => r.code)).toEqual(["R1"]);
    const mine: any = await (await call("GET", "/api/runs?mine=1")).json();
    expect(mine.runs).toHaveLength(1);
  });

  it("refuses to drop an invoice that still has products in Shopify", async () => {
    await call("POST", "/api/runs");
    await call("PUT", "/api/runs/R1", { version: 1, data: { sources: [{ id: "s1", name: "a.pdf" }], rows: [] } });
    const store = new RunStore(env.DB!);
    await store.recordProducts([{ productId: "p1", runId: 1, invoiceId: "s1", importId: "20261007-R1-A-AAAA", title: "X", barcode: null, vendor: null }], "dev@local");
    const res = await call("PUT", "/api/runs/R1", { version: 2, data: { sources: [], rows: [] } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe("invoice_has_products");
    expect((await call("DELETE", "/api/runs/R1")).status).toBe(409);
  });

  it("reports a conflicting save and unknown runs", async () => {
    await call("POST", "/api/runs");
    await call("PUT", "/api/runs/R1", { version: 1, data: { sources: [], rows: [] } });
    expect((await call("PUT", "/api/runs/R1", { version: 1, data: { sources: [], rows: [] } })).status).toBe(409);
    expect((await call("GET", "/api/runs/R404")).status).toBe(404);
    expect((await call("GET", "/api/runs/nonsense")).status).toBe(404);
  });

  it("explains how to set up the database when it's missing", async () => {
    delete (env as any).DB;
    const res = await call("POST", "/api/runs");
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toMatch(/wrangler d1 create/);
  });
});
