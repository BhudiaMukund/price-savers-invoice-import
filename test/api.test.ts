import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";
import { RunStore, resetSchemaCache } from "../src/store";
import { sqliteDb } from "./sqlite-db";

const IMPORT = "20261007-R1-TEST-AAAA";
/** Products must belong to a run and invoice; these tests all work inside run R1. */
const inRun = (items: object[]) => ({ runCode: "R1", items: items.map((i) => ({ invoiceId: "s1", importId: IMPORT, ...i })) });

const env = {
  SHOPIFY_STORE_DOMAIN: "test.myshopify.com",
  SHOPIFY_API_VERSION: "2025-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "gemini-test",
  GEMINI_API_KEY: "k",
  DEV_AUTH_BYPASS: "true",
} as unknown as Env;

const created: any[] = [];
const published: any[] = [];
const geminiBodies: string[] = [];
const shopifyQueries: string[] = [];

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const u = String(url);
      if (u.includes("generativelanguage.googleapis.com")) {
        geminiBodies.push(typeof init.body === "string" ? init.body : await new Response(init.body).text());
        return Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      items: [
                        { title: "  Balloon   Pack ", supplierCode: "BP1", barcode: "4006381333931" }, // exists in store
                        { title: "New Banner", supplierCode: null, barcode: "96385074" }, // new
                        { title: "No barcode thing", supplierCode: "NB2", barcode: null }, // new, flagged
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      const body = JSON.parse(init.body);
      const q: string = body.query;
      shopifyQueries.push(q + JSON.stringify(body.variables ?? {}));
      if (q.includes("productVariants")) {
        return Response.json({
          data: {
            productVariants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ barcode: "'4006381333931", sku: null, product: { id: "gid://p1", title: "Balloon Pack", handle: "balloon-pack" } }],
            },
          },
        });
      }
      if (q.includes("locations(")) {
        return Response.json({
          data: {
            locations: { nodes: [{ id: "gid://loc1", name: "Shop" }] },
            publications: { nodes: [{ id: "gid://pub-online", name: "Online Store" }, { id: "gid://pub-pos", name: "Point of Sale" }] },
          },
        });
      }
      if (q.includes("productSet")) {
        created.push(body.variables.input);
        return Response.json({ data: { productSet: { product: { id: `gid://new${created.length}` }, userErrors: [] } } });
      }
      if (q.includes("publishablePublish")) {
        published.push(body.variables);
        return Response.json({ data: { publishablePublish: { userErrors: [] } } });
      }
      return Response.json({ errors: [{ message: "unmocked query" }] });
    }),
  );
}

beforeEach(async () => {
  resetSchemaCache();
  (env as any).DB = sqliteDb();
  await new RunStore((env as any).DB).createRun("dev@local");
});

afterEach(() => {
  vi.unstubAllGlobals();
  created.length = 0;
  published.length = 0;
  geminiBodies.length = 0;
  shopifyQueries.length = 0;
});

describe("extract -> create flow", () => {
  it("extracts, skips what the store already has, and flags missing barcodes", async () => {
    mockFetch();
    const res = await app.fetch(
      new Request("http://x/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "inv.csv", mimeType: "text/csv", text: "a,b\n1,2" }),
      }),
      env,
    );
    const json: any = await res.json();
    expect(res.status).toBe(200);
    expect(json.rows.map((r: any) => r.match)).toEqual(["exists", "new", "new"]);
    expect(json.rows[0].title).toBe("Balloon Pack");
    expect(json.rows[2].barcodeStatus).toBe("missing");
  });

  it("creates active, untracked, non-shipping $0 products and publishes to POS only", async () => {
    mockFetch();
    const res = await app.fetch(
      new Request("http://x/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(inRun([
            { title: "New Banner", supplierCode: "NB1", barcode: "96385074" },
            { title: "Balloon Pack", supplierCode: null, barcode: "4006381333931" }, // already exists -> skipped
          ]),
        ),
      }),
      env,
    );
    const json: any = await res.json();
    expect(json.results.map((r: any) => r.status)).toEqual(["created", "skipped"]);
    expect(created).toHaveLength(1);
    const input = created[0];
    expect(input.status).toBe("ACTIVE");
    const v = input.variants[0];
    expect(v.price).toBe("0.00");
    expect(v.barcode).toBe("96385074");
    expect(v.sku).toBe("NB1");
    expect(v.inventoryItem).toEqual({ tracked: false, requiresShipping: false });
    expect(v.inventoryQuantities).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(published[0].input).toEqual([{ publicationId: "gid://pub-pos" }]);
  });

  it("streams PDFs/photos to the AI as valid JSON without re-encoding", async () => {
    mockFetch();
    const b64 = btoa("%PDF-1.4 fake invoice bytes");
    const res = await app.fetch(
      new Request("http://x/api/extract-file", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": String(b64.length),
          "x-file-name": encodeURIComponent("Supplier inv #12.pdf"),
          "x-file-type": "application/pdf",
        },
        body: b64,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const sent = JSON.parse(geminiBodies[0]!);
    const part = sent.contents[0].parts[1];
    expect(part.inline_data).toEqual({ mime_type: "application/pdf", data: b64 });
    expect(sent.generationConfig.responseMimeType).toBe("application/json");
  });

  it("refuses unsupported file types before calling the AI", async () => {
    mockFetch();
    const res = await app.fetch(
      new Request("http://x/api/extract-file", {
        method: "POST",
        headers: { "content-length": "4", "x-file-name": "a.zip", "x-file-type": "application/zip" },
        body: "abcd",
      }),
      env,
    );
    expect(res.status).toBe(415);
    expect(geminiBodies).toHaveLength(0);
  });

  it("only looks up the batch's barcodes when creating, not the whole store", async () => {
    mockFetch();
    await app.fetch(
      new Request("http://x/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(inRun([{ id: "r1", title: "New Banner", supplierCode: null, barcode: "96385074" }])),
      }),
      env,
    );
    const lookups = shopifyQueries.filter((q) => q.includes("productVariants"));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain("barcode:96385074");
    expect(lookups[0]).not.toContain("pageInfo");
  });

  it("echoes client row ids so results line up with rows", async () => {
    mockFetch();
    const res = await app.fetch(
      new Request("http://x/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(inRun([{ id: "abc-1", title: "X", supplierCode: null, barcode: null, evil: "<script>" }])),
      }),
      env,
    );
    const json: any = await res.json();
    expect(json.results[0].id).toBe("abc-1");
    expect(JSON.stringify(created[0])).not.toContain("evil");
  });

  it("refuses to add products that don't belong to a run", async () => {
    mockFetch();
    const post = (body: object) =>
      app.fetch(new Request("http://x/api/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env);
    expect((await post({ items: [{ title: "X", supplierCode: null, barcode: null }] })).status).toBe(400);
    expect((await post({ runCode: "R99", items: [{ title: "X", invoiceId: "s1", importId: "20261007-R99-X-AAAA" }] })).status).toBe(400);
    // import ID from another run
    expect((await post({ runCode: "R1", items: [{ title: "X", invoiceId: "s1", importId: "20261007-R7-X-AAAA" }] })).status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it("records what it created in the ledger, with the run tag", async () => {
    mockFetch();
    await app.fetch(
      new Request("http://x/api/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inRun([{ title: "New Banner", supplierCode: null, barcode: "96385074" }])) }),
      env,
    );
    const run = await new RunStore((env as any).DB).getRun("R1");
    expect(run!.liveByInvoice).toEqual({ s1: 1 });
    expect(created[0].tags).toEqual([`import-${IMPORT}`, "run-R1"]);
  });

  it("rejects oversized batches", async () => {
    mockFetch();
    const items = Array.from({ length: 16 }, (_, i) => ({ title: `t${i}`, supplierCode: null, barcode: null }));
    const res = await app.fetch(
      new Request("http://x/api/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) }),
      env,
    );
    expect(res.status).toBe(400);
  });
});
