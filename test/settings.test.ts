import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { resetTokenCache } from "../src/shopify";
import { resetSchemaCache } from "../src/store";
import type { Env } from "../src/types";
import { sqliteDb } from "./sqlite-db";

let env: Env;
let saved: string[];
let vendors: Record<string, number>;
let productInputs: any[];

beforeEach(() => {
  resetTokenCache();
  resetSchemaCache();
  env = { SHOPIFY_STORE_DOMAIN: "t.myshopify.com", SHOPIFY_API_VERSION: "2026-07", SHOPIFY_ADMIN_TOKEN: "t", DEV_AUTH_BYPASS: "true", DB: sqliteDb() } as unknown as Env;
  saved = ["Party Co", "Old Supplier"];
  vendors = { Alpen: 739, Dats: 104 };
  productInputs = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: any) => {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("productsCount")) {
        const data: Record<string, unknown> = {};
        for (const [k, q] of Object.entries(variables as Record<string, string>)) data[k.replace("q", "v")] = { count: vendors[/vendor:"(.*)"/.exec(q)![1]!] ?? 0 };
        return Response.json({ data });
      }
      if (query.includes("productVendors")) return Response.json({ data: { productVendors: { edges: Object.keys(vendors).map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
      if (query.includes("shop {")) return Response.json({ data: { shop: { id: "gid://shopify/Shop/1", metafield: { value: JSON.stringify(saved) } } } });
      if (query.includes("metafieldsSet")) {
        saved = JSON.parse(variables.m[0].value);
        return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
      }
      if (query.includes("locations(")) return Response.json({ data: { locations: { nodes: [{ id: "L1", name: "Shop" }] }, publications: { nodes: [] }, metafieldDefinitions: { nodes: [] } } });
      if (query.includes("productVariants")) return Response.json({ data: { productVariants: { nodes: [] } } });
      if (query.includes("productSet")) {
        productInputs.push(variables.input);
        return Response.json({ data: { productSet: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } } });
      }
      return Response.json({ errors: [{ message: "unmocked" }] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const call = (method: string, p: string, body?: unknown, e: Env = env) =>
  app.fetch(new Request(`http://x${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), e);
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

describe("settings", () => {
  it("has sensible defaults and saves changes", async () => {
    expect((await json(call("GET", "/api/settings"))).settings).toEqual({ importTags: true, cataloguePhotos: true, catalogueDescriptions: true });
    const res = await json(call("PUT", "/api/settings", { importTags: false }));
    expect(res.settings.importTags).toBe(false);
    expect((await call("PUT", "/api/settings", { nonsense: true })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { importTags: "yes" })).status).toBe(400);
  });

  it("only lets the listed managers change settings or delete suppliers", async () => {
    const { canManage } = await import("../src/settings");
    const listed = { ADMIN_EMAILS: "Owner@PriceSavers.example, manager@pricesavers.example" } as Env;
    expect(canManage(listed, "owner@pricesavers.example")).toBe(true);
    expect(canManage(listed, "manager@pricesavers.example")).toBe(true);
    expect(canManage(listed, "staff@pricesavers.example")).toBe(false);
    expect(canManage({} as Env, "staff@pricesavers.example")).toBe(true); // no list: everyone
  });

  it("stops tagging new products when tags are turned off", async () => {
    const { RunStore } = await import("../src/store");
    await new RunStore(env.DB!).createRun("dev@local");
    await call("PUT", "/api/settings", { importTags: false });
    await call("POST", "/api/create", { runCode: "R1", items: [{ id: "a", invoiceId: "s1", title: "X", importId: "20261007-R1-PARTY-AAAA" }] });
    expect(productInputs[0].tags).toBeUndefined();
    expect(productInputs[0].metafields).toHaveLength(1); // the import ID is still saved
  });
});

describe("deleting suppliers", () => {
  it("lists every supplier with its product count", async () => {
    const res = await json(call("GET", "/api/suppliers/details"));
    expect(res.suppliers).toEqual([
      { name: "Alpen", saved: false, products: 739, catalogues: 0 },
      { name: "Dats", saved: false, products: 104, catalogues: 0 },
      { name: "Old Supplier", saved: true, products: 0, catalogues: 0 },
      { name: "Party Co", saved: true, products: 0, catalogues: 0 },
    ]);
  });

  it("deletes an unused supplier, but not one on store products or with a catalogue", async () => {
    expect((await json(call("DELETE", "/api/suppliers", { name: "old supplier" }))).suppliers).toEqual(["Alpen", "Dats", "Party Co"]);
    expect(saved).toEqual(["Party Co"]);

    const inUse = await call("DELETE", "/api/suppliers", { name: "Alpen" });
    expect(inUse.status).toBe(409);
    expect(((await inUse.json()) as any).error).toMatch(/vendor on 739 products/);

    // A product was given this vendor since the page loaded: the live check catches it.
    vendors["Party Co"] = 2;
    expect((await call("DELETE", "/api/suppliers", { name: "Party Co" })).status).toBe(409);
    delete vendors["Party Co"];

    const up = await json(call("POST", "/api/catalogues", { supplier: "Party Co", fileNames: [] }));
    await call("POST", `/api/catalogues/${up.upload.code}/finish`);
    const withCat = await call("DELETE", "/api/suppliers", { name: "PARTY CO" });
    expect(withCat.status).toBe(409);
    expect(((await withCat.json()) as any).error).toMatch(/catalogue/);
  });
});
