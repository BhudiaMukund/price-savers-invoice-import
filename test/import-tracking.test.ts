import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { mergeSuppliers, resetTokenCache } from "../src/shopify";
import type { Env } from "../src/types";
import { RunStore, resetSchemaCache } from "../src/store";
import { sqliteDb } from "./sqlite-db";

const env = {
  SHOPIFY_STORE_DOMAIN: "t.myshopify.com",
  SHOPIFY_API_VERSION: "2025-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "m",
  GEMINI_API_KEY: "k",
  DEV_AUTH_BYPASS: "true",
} as unknown as Env;

let defType: string | null = "single_line_text_field";
let created: any[] = [];
let deleted: string[] = [];
let savedSuppliers: string | null = null;
const products: Record<string, { metafield: string | null; prices: string[] }> = {};

let runs: RunStore;
beforeEach(async () => {
  resetTokenCache();
  resetSchemaCache();
  (env as any).DB = sqliteDb();
  runs = new RunStore((env as any).DB);
  await runs.createRun("dev@local"); // R1
  defType = "single_line_text_field";
  created = [];
  deleted = [];
  savedSuppliers = null;
  for (const k of Object.keys(products)) delete products[k];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("locations(")) {
        return Response.json({
          data: {
            locations: { nodes: [{ id: "L1", name: "Shop" }] },
            publications: { nodes: [{ id: "P2", name: "Point of Sale" }] },
            metafieldDefinitions: { nodes: defType ? [{ type: { name: defType } }] : [] },
          },
        });
      }
      if (query.includes("productVariants")) return Response.json({ data: { productVariants: { nodes: [] } } });
      if (query.includes("productSet")) {
        created.push(variables.input);
        return Response.json({ data: { productSet: { product: { id: `gid://shopify/Product/${created.length}` }, userErrors: [] } } });
      }
      if (query.includes("publishablePublish")) return Response.json({ data: { publishablePublish: { userErrors: [] } } });
      if (query.includes("productVendors")) {
        return Response.json({ data: { productVendors: { edges: [{ node: "Alpen" }, { node: "Goldstar" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (query.includes("shop {")) {
        return Response.json({ data: { shop: { id: "gid://shopify/Shop/1", metafield: savedSuppliers ? { value: savedSuppliers } : null } } });
      }
      if (query.includes("metafieldsSet")) {
        savedSuppliers = variables.m[0].value;
        expect(variables.m[0].namespace).toBe("$app");
        return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
      }
      if (query.includes("nodes(ids")) {
        return Response.json({
          data: {
            nodes: variables.ids.map((id: string) =>
              products[id] ? { id, metafield: products[id]!.metafield === null ? null : { value: products[id]!.metafield }, variants: { nodes: products[id]!.prices.map((price) => ({ price })) } } : null,
            ),
          },
        });
      }
      if (query.includes("productDelete")) {
        deleted.push(variables.id);
        return Response.json({ data: { productDelete: { deletedProductId: variables.id, userErrors: [] } } });
      }
      return Response.json({ errors: [{ message: `unmocked: ${query.slice(0, 40)}` }] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const post = (path: string, body: unknown) =>
  app.fetch(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env);

describe("creating products records supplier and import", () => {
  it("sets vendor, the import_source metafield and an import tag", async () => {
    await post("/api/create", { runCode: "R1", items: [{ id: "a", invoiceId: "s1", title: "Gold Banner", supplierCode: null, barcode: null, vendor: "Alpen", importId: "20261007-R1-ALPEN-K3F9" }] });
    const input = created[0];
    expect(input.vendor).toBe("Alpen");
    expect(input.metafields).toEqual([{ namespace: "custom", key: "import_source", type: "single_line_text_field", value: "20261007-R1-ALPEN-K3F9" }]);
    expect(input.tags).toEqual(["import-20261007-R1-ALPEN-K3F9", "run-R1"]);
  });

  it("matches the store's existing field type (a list field gets a JSON list)", async () => {
    defType = "list.single_line_text_field";
    await post("/api/create", { runCode: "R1", items: [{ id: "a", invoiceId: "s1", title: "X", supplierCode: null, barcode: null, vendor: "Alpen", importId: "20261007-R1-ALPEN-K3F9" }] });
    expect(created[0].metafields[0]).toMatchObject({ type: "list.single_line_text_field", value: '["20261007-R1-ALPEN-K3F9"]' });
  });

  it("refuses an import ID with unexpected characters", async () => {
    const res = await post("/api/create", { runCode: "R1", items: [{ id: "a", invoiceId: "s1", title: "X", supplierCode: null, barcode: null, vendor: "Alpen", importId: "bad id; drop" }] });
    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it("can turn the tag off", async () => {
    const res = await app.fetch(
      new Request("http://x/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runCode: "R1", items: [{ id: "a", invoiceId: "s1", title: "X", supplierCode: null, barcode: null, vendor: null, importId: "20261007-R1-ALPEN-K3F9" }] }),
      }),
      { ...env, IMPORT_TAGS: "false" } as Env,
    );
    expect(res.status).toBe(200);
    expect(created[0].tags).toBeUndefined();
    expect(created[0].metafields).toHaveLength(1);
  });
});

describe("undo import", () => {
  const ID = "20261007-R1-ALPEN-K3F9";
  it("deletes only unpriced products from this import", async () => {
    products["gid://shopify/Product/1"] = { metafield: ID, prices: ["0.00"] }; // delete
    products["gid://shopify/Product/2"] = { metafield: ID, prices: ["4.95"] }; // priced: keep
    products["gid://shopify/Product/3"] = { metafield: "20261001-GOLDSTAR-AB12", prices: ["0.00"] }; // other import: keep
    products["gid://shopify/Product/4"] = { metafield: null, prices: ["0.00"] }; // no import: keep
    // What the ledger knows: 1 and 2 came from this import, 3 from another one; 4 and 99 were never added by this tool.
    const runId = (await runs.runId("R1"))!;
    await runs.recordProducts(
      [
        { productId: "gid://shopify/Product/1", runId, invoiceId: "s1", importId: ID, title: "A", barcode: null, vendor: null },
        { productId: "gid://shopify/Product/2", runId, invoiceId: "s1", importId: ID, title: "B", barcode: null, vendor: null },
        { productId: "gid://shopify/Product/3", runId, invoiceId: "s2", importId: "20261001-R1-GOLDSTAR-AB12", title: "C", barcode: null, vendor: null },
      ],
      "dev@local",
    );
    const res = await post("/api/undo", { importId: ID, productIds: Object.keys(products).concat("gid://shopify/Product/99") });
    const json: any = await res.json();
    expect(deleted).toEqual(["gid://shopify/Product/1"]);
    expect(json.results.map((r: any) => r.status + (r.reason ? `:${r.reason}` : ""))).toEqual([
      "deleted",
      "kept:priced",
      "kept:not_this_import",
      "kept:not_this_import",
      "kept:not_this_import",
    ]);
    // The ledger now shows only the priced product as still live for this invoice
    expect((await runs.getRun("R1"))!.liveByInvoice).toEqual({ s1: 1, s2: 1 });
  });

  it("refuses bad input", async () => {
    expect((await post("/api/undo", { importId: "x", productIds: ["gid://shopify/Product/1"] })).status).toBe(400);
    expect((await post("/api/undo", { importId: ID, productIds: ["not-a-gid"] })).status).toBe(400);
  });
});

describe("suppliers", () => {
  it("lists store vendors plus saved ones, without duplicates", async () => {
    savedSuppliers = JSON.stringify(["Party Co", "alpen"]);
    const json: any = await (await app.fetch(new Request("http://x/api/suppliers"), env)).json();
    expect(json.suppliers).toEqual(["Alpen", "Goldstar", "Party Co"]);
  });

  it("saves a new supplier, and doesn't re-save an existing one", async () => {
    let json: any = await (await post("/api/suppliers", { name: "  Party   Co " })).json();
    expect(json.suppliers).toContain("Party Co");
    expect(JSON.parse(savedSuppliers!)).toEqual(["Party Co"]);
    savedSuppliers = null;
    json = await (await post("/api/suppliers", { name: "GOLDSTAR" })).json();
    expect(savedSuppliers).toBeNull(); // already a vendor in the store
    expect(json.suppliers).toEqual(["Alpen", "Goldstar"]);
  });

  it("merges ignoring case and spacing", () => {
    expect(mergeSuppliers(["Alpen", "IG-Design"], ["alpen ", "Dats"])).toEqual(["Alpen", "Dats", "IG-Design"]);
  });
});
