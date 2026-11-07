import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";
import { RunStore, resetSchemaCache } from "../src/store";
import { normalisePrice } from "../src/pricing";
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

const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";
const P3 = "gid://shopify/Product/3"; // not added by this tool
const P4 = "gid://shopify/Product/4"; // two variants
const prices: Record<string, string> = { [P1]: "0.00", [P2]: "3.50", [P3]: "0.00", [P4]: "0.00" };
let queries: string[] = [];

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const q: string = body.query;
      queries.push(q);
      if (q.includes("Prices($ids")) {
        return Response.json({
          data: {
            nodes: body.variables.ids.map((id: string) =>
              id === "gid://shopify/Product/9"
                ? null
                : { id, title: `Product ${id.split("/").pop()}`, status: "ACTIVE", featuredMedia: null, variants: { nodes: id === P4 ? [{ id: "v4a", price: "0.00", sku: "A", barcode: null }, { id: "v4b", price: "0.00", sku: "B", barcode: null }] : [{ id: `v${id.split("/").pop()}`, price: prices[id] ?? "0.00", sku: "S1", barcode: "9300000000019" }] } },
            ),
          },
        });
      }
      if (q.includes("V($ids")) {
        return Response.json({ data: { nodes: body.variables.ids.map((id: string) => ({ id, variants: { nodes: id === P4 ? [{ id: "v4a" }, { id: "v4b" }] : [{ id: `v${id.split("/").pop()}` }] } })) } });
      }
      if (q.startsWith("mutation { m0")) {
        const data: Record<string, unknown> = {};
        for (const m of q.matchAll(/m(\d+): productVariantsBulkUpdate\(productId: "([^"]+)", variants: \[\{id: "([^"]+)", price: "([^"]+)"\}\]/g)) {
          prices[m[2]!] = m[4]!;
          data[`m${m[1]}`] = { userErrors: [] };
        }
        return Response.json({ data });
      }
      return Response.json({ errors: [{ message: "unmocked query" }] });
    }),
  );
}

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

beforeEach(async () => {
  resetSchemaCache();
  const db = sqliteDb();
  (env as any).DB = db;
  const store = new RunStore(db);
  const r1 = await store.createRun("dev@local");
  const r2 = await store.createRun("dev@local");
  const rid = (await store.runId(r1.code))!;
  const rid2 = (await store.runId(r2.code))!;
  await store.recordProducts(
    [
      { productId: P1, runId: rid, invoiceId: "s1", importId: "i1", title: "One", barcode: null, vendor: "Acme" },
      { productId: P2, runId: rid, invoiceId: "s1", importId: "i1", title: "Two", barcode: null, vendor: "Acme" },
      { productId: P4, runId: rid2, invoiceId: "s2", importId: "i2", title: "Four", barcode: null, vendor: "Acme" },
    ],
    "dev@local",
  );
  Object.assign(prices, { [P1]: "0.00", [P2]: "3.50", [P3]: "0.00", [P4]: "0.00" });
  queries = [];
  mockFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("price values", () => {
  it("accepts dollars and cents, rejects the rest", () => {
    expect(normalisePrice("4.5")).toBe("4.50");
    expect(normalisePrice("$12")).toBe("12.00");
    expect(normalisePrice("1,299.95")).toBe("1299.95");
    for (const bad of ["", "0", "0.00", "-1", "4.999", "abc", "1e3", null, undefined]) expect(normalisePrice(bad)).toBeNull();
  });
});

describe("reading prices", () => {
  it("lists one run's products with their current prices", async () => {
    const res = await json(call("GET", "/api/pricing?run=R1"));
    expect(res.products.map((p: any) => [p.productId, p.price, p.run])).toEqual([[P1, "0.00", "R1"], [P2, "3.50", "R1"]]);
    expect(res.next).toBeNull();
  });
  it("lists every run when none is given", async () => {
    const res = await json(call("GET", "/api/pricing"));
    expect(res.products.map((p: any) => p.productId)).toEqual([P1, P2, P4]);
  });
  it("says a multi-variant product has no single price", async () => {
    const res = await json(call("GET", "/api/pricing?run=R2"));
    expect(res.products[0]).toMatchObject({ productId: P4, price: null, variants: 2 });
  });
  it("only ever reads prices", async () => {
    await call("GET", "/api/pricing");
    expect(queries.every((q) => q.trimStart().startsWith("query"))).toBe(true);
  });
});

describe("saving prices", () => {
  it("sets the price and sends nothing about stock", async () => {
    const res = await json(call("POST", "/api/prices", { items: [{ productId: P1, price: "4.95" }, { productId: P2, price: 5 }] }));
    expect(res.results.map((r: any) => [r.productId, r.ok, r.price])).toEqual([[P1, true, "4.95"], [P2, true, "5.00"]]);
    expect(prices[P1]).toBe("4.95");
    expect(prices[P2]).toBe("5.00");
    expect(queries.join("\n")).not.toMatch(/inventory|stock|productSet|productCreate|productDelete/i);
    expect(queries.filter((q) => q.includes("mutation")).length).toBe(1); // both in one request
  });
  it("won't price a product this tool didn't add", async () => {
    const res = await json(call("POST", "/api/prices", { items: [{ productId: P3, price: "9.99" }] }));
    expect(res.results[0]).toMatchObject({ productId: P3, ok: false });
    expect(prices[P3]).toBe("0.00");
  });
  it("won't price a product with several variants", async () => {
    const res = await json(call("POST", "/api/prices", { items: [{ productId: P4, price: "9.99" }] }));
    expect(res.results[0]).toMatchObject({ ok: false });
    expect(res.results[0].error).toMatch(/several variants/);
  });
  it("refuses a price that isn't a price, without calling Shopify", async () => {
    const res = await json(call("POST", "/api/prices", { items: [{ productId: P1, price: "0" }, { productId: P2, price: "free" }] }));
    expect(res.results.every((r: any) => !r.ok)).toBe(true);
    expect(queries.length).toBeLessThanOrEqual(1);
    expect(prices[P1]).toBe("0.00");
  });
  it("limits how many go at once", async () => {
    const items = Array.from({ length: 41 }, (_, i) => ({ productId: `gid://shopify/Product/${i + 10}`, price: "1.00" }));
    expect((await call("POST", "/api/prices", { items })).status).toBe(400);
  });
});
