import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";
import { RunStore, resetSchemaCache } from "../src/store";
import { sqliteDb } from "./sqlite-db";

const IMPORT = "20261015-R1-ACME-AAAA";
const IMPORT2 = "20261016-R1-ACME-BBBB";
const LOC = "gid://shopify/Location/9";
const PRODUCT = "gid://shopify/Product/100";

const env = {
  SHOPIFY_STORE_DOMAIN: "test.myshopify.com",
  SHOPIFY_API_VERSION: "2026-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "gemini-test",
  GEMINI_API_KEY: "k",
  DEV_AUTH_BYPASS: "true",
} as unknown as Env;

/** A store with one product ("Balloon Pack", barcode 4006381333931) whose stock isn't tracked. */
const shop = { tracked: false, level: false, onHand: 0, calls: [] as string[], adjustFails: false, created: [] as any[], status: "ACTIVE", published: 0, updateError: "" };

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const q: string = body.query;
      shop.calls.push(q.replace(/\s+/g, " ").slice(0, 80));
      if (q.includes("Stock($ids")) {
        return Response.json({
          data: {
            nodes: [
              {
                id: PRODUCT,
                variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", barcode: "4006381333931", inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: shop.tracked, inventoryLevel: shop.level ? { id: "lvl" } : null } }] },
              },
            ],
          },
        });
      }
      if (q.includes("Status($ids")) return Response.json({ data: { nodes: body.variables.ids.map((id: string) => (id === PRODUCT ? { id, status: shop.status } : null)) } });
      if (q.startsWith("mutation { m0")) {
        const data: Record<string, unknown> = {};
        for (const m of q.matchAll(/m(\d+): productUpdate\(product: \{id: "([^"]+)", status: ACTIVE\}/g)) {
          if (!shop.updateError) shop.status = "ACTIVE";
          data[`m${m[1]}`] = { userErrors: shop.updateError ? [{ field: ["status"], message: shop.updateError }] : [] };
        }
        for (const m of q.matchAll(/m(\d+): publishablePublish\(id: "([^"]+)", input: \[\{publicationId: "([^"]+)"\}\]/g)) {
          shop.published++;
          data[`m${m[1]}`] = { userErrors: [] };
        }
        for (const m of q.matchAll(/m(\d+): (inventoryItemUpdate|inventoryActivate)\(/g)) {
          if (m[2] === "inventoryItemUpdate") shop.tracked = true;
          else shop.level = true;
          data[`m${m[1]}`] = { userErrors: [] };
        }
        return Response.json({ data });
      }
      if (q.includes("inventoryAdjustQuantities")) {
        if (shop.adjustFails) return Response.json({ data: { inventoryAdjustQuantities: { userErrors: [{ field: ["input"], message: "Nope" }] } } });
        for (const ch of body.variables.input.changes) shop.onHand += ch.delta;
        shop.calls.push(`adjust ${body.variables.input.reason} ${body.variables.input.changes.map((c: any) => c.delta).join(",")}`);
        return Response.json({ data: { inventoryAdjustQuantities: { userErrors: [] } } });
      }
      if (q.includes("productVariants")) {
        return Response.json({
          data: {
            productVariants: { nodes: [{ barcode: "4006381333931", sku: null, product: { id: PRODUCT, title: "Balloon Pack", handle: "balloon-pack", status: shop.status } }] },
          },
        });
      }
      if (q.includes("locations(")) {
        return Response.json({
          data: { locations: { nodes: [{ id: LOC, name: "West Lakes" }] }, publications: { nodes: [{ id: "gid://pub-pos", name: "Point of Sale" }] } },
        });
      }
      if (q.includes("productSet")) {
        shop.created.push(body.variables.input);
        return Response.json({ data: { productSet: { product: { id: `gid://shopify/Product/${200 + shop.created.length}` }, userErrors: [] } } });
      }
      if (q.includes("publishablePublish")) return Response.json({ data: { publishablePublish: { userErrors: [] } } });
      return Response.json({ errors: [{ message: "unmocked query" }] });
    }),
  );
}

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;
const line = (more: object = {}) => ({ id: "r1", title: "Balloon Pack", barcode: "4006381333931", qty: 24, invoiceId: "s1", importId: IMPORT, invoiceRef: "acme|INV-7", ...more });

beforeEach(async () => {
  resetSchemaCache();
  (env as any).DB = sqliteDb();
  await new RunStore((env as any).DB).createRun("dev@local");
  Object.assign(shop, { tracked: false, level: false, onHand: 0, calls: [], adjustFails: false, created: [], status: "ACTIVE", published: 0, updateError: "" });
  mockFetch();
});
afterEach(() => vi.unstubAllGlobals());

// Stock is chosen per run: the page sends stock: true with /api/create. /api/stock is only called when it is on.
const turnOn = async () => {};

describe("stock location setting", () => {
  it("has no on/off setting any more, and saves a location", async () => {
    const settings = (await json(call("GET", "/api/settings"))).settings;
    expect(settings).toMatchObject({ stockLocationId: "" });
    expect(settings).not.toHaveProperty("stockFromInvoices");
    expect((await call("PUT", "/api/settings", { stockFromInvoices: true })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { stockLocationId: LOC })).status).toBe(200);
    expect((await call("PUT", "/api/settings", { stockLocationId: "somewhere" })).status).toBe(400);
  });
});

describe("new products", () => {
  it("start with counted stock at the chosen location when it's on", async () => {
    await turnOn();
    await call("PUT", "/api/settings", { stockLocationId: LOC });
    const res = await json(call("POST", "/api/create", { runCode: "R1", stock: true, items: [line({ title: "New Banner", barcode: "96385074", qty: 30 })] }));
    expect(res.results[0]).toMatchObject({ status: "created", stock: 30 });
    const v = shop.created[0].variants[0];
    expect(v.inventoryItem).toEqual({ tracked: true, requiresShipping: false });
    expect(v.inventoryQuantities).toEqual([{ locationId: LOC, name: "available", quantity: 30 }]);
  });
  it("stay untracked with no stock when the run has it off, or the line has no quantity", async () => {
    const off = await json(call("POST", "/api/create", { runCode: "R1", items: [line({ title: "New Banner", barcode: "96385074" })] }));
    expect(off.results[0].stock).toBe(0);
    expect(shop.created[0].variants[0].inventoryItem.tracked).toBe(false);
    expect(shop.created[0].variants[0].inventoryQuantities).toBeUndefined();
    await turnOn();
    await call("POST", "/api/create", { runCode: "R1", stock: true, items: [line({ id: "r2", title: "Other", barcode: "96385074", qty: null })] });
    expect(shop.created[1].variants[0].inventoryItem.tracked).toBe(false);
  });
});

describe("products already in the store", () => {
  it("turns tracking on, stocks the location and adds the quantity", async () => {
    await turnOn();
    const res = await json(call("POST", "/api/stock", { runCode: "R1", items: [{ ...line(), productId: PRODUCT }] }));
    expect(res.results).toEqual([{ id: "r1", status: "added", qty: 24 }]);
    expect(shop.tracked).toBe(true);
    expect(shop.level).toBe(true);
    expect(shop.onHand).toBe(24);
  });
  it("doesn't count the same invoice twice, but a different invoice adds again", async () => {
    await turnOn();
    const send = (extra: object = {}) => json(call("POST", "/api/stock", { runCode: "R1", items: [{ ...line(extra), productId: PRODUCT }] }));
    await send();
    expect((await send()).results[0]).toMatchObject({ status: "skipped", reason: "already_added" });
    expect(shop.onHand).toBe(24);
    expect((await send({ importId: IMPORT2, invoiceRef: "acme|INV-8" })).results[0].status).toBe("added");
    expect(shop.onHand).toBe(48);
  });
  it("lets the invoice try again when Shopify refuses", async () => {
    await turnOn();
    shop.adjustFails = true;
    const first = await json(call("POST", "/api/stock", { runCode: "R1", items: [{ ...line(), productId: PRODUCT }] }));
    expect(first.results[0]).toMatchObject({ status: "failed", error: "Nope" });
    shop.adjustFails = false;
    const again = await json(call("POST", "/api/stock", { runCode: "R1", items: [{ ...line(), productId: PRODUCT }] }));
    expect(again.results[0].status).toBe("added");
    expect(shop.onHand).toBe(24);
  });
  it("skips lines with no quantity", async () => {
    await turnOn();
    const res = await json(call("POST", "/api/stock", { runCode: "R1", items: [{ ...line({ qty: 0 }), productId: PRODUCT }] }));
    expect(res.results[0]).toMatchObject({ status: "skipped", reason: "no_quantity" });
  });
  it("takes the stock back when the import is undone, and the invoice can add it again afterwards", async () => {
    await turnOn();
    await call("POST", "/api/stock", { runCode: "R1", items: [{ ...line(), productId: PRODUCT }] });
    const undo = await json(call("POST", "/api/stock/undo", { importId: IMPORT, productIds: [PRODUCT] }));
    expect(undo.results[0]).toEqual({ id: PRODUCT, status: "removed", qty: 24 });
    expect(shop.onHand).toBe(0);
    expect(shop.calls).toContain("adjust correction -24");
    const twice = await json(call("POST", "/api/stock/undo", { importId: IMPORT, productIds: [PRODUCT] }));
    expect(twice.results[0].status).toBe("kept");
    expect(shop.onHand).toBe(0);
    expect((await json(call("POST", "/api/stock", { runCode: "R1", items: [{ ...line(), productId: PRODUCT }] }))).results[0].status).toBe("added");
  });
});

describe("draft products already in the store", () => {
  it("are reported with their status when matched by barcode", async () => {
    shop.status = "DRAFT";
    const res = await json(call("POST", "/api/lookup", { items: [line()] }));
    expect(res.rows[0]).toMatchObject({ match: "exists", existing: { productId: PRODUCT, status: "DRAFT" } });
  });
  it("are made active and put on Point of Sale, leaving price and the rest alone", async () => {
    shop.status = "DRAFT";
    const res = await json(call("POST", "/api/activate", { items: [{ id: "r1", productId: PRODUCT }] }));
    expect(res.results).toEqual([{ id: "r1", status: "activated", published: true }]);
    expect(shop.status).toBe("ACTIVE");
    expect(shop.published).toBe(1);
    expect(shop.calls.some((c) => /productSet|price/i.test(c))).toBe(false);
  });
  it("leave an active (or archived) product alone", async () => {
    for (const status of ["ACTIVE", "ARCHIVED"]) {
      shop.status = status;
      shop.calls = [];
      const res = await json(call("POST", "/api/activate", { items: [{ id: "r1", productId: PRODUCT }] }));
      expect(res.results).toEqual([{ id: "r1", status: "skipped" }]);
      expect(shop.status).toBe(status);
      expect(shop.calls.some((c) => c.startsWith("mutation"))).toBe(false);
    }
  });
  it("report Shopify's reason when it won't activate one, and refuse bad ids", async () => {
    shop.status = "DRAFT";
    shop.updateError = "Needs a title";
    const res = await json(call("POST", "/api/activate", { items: [{ id: "r1", productId: PRODUCT }, { id: "r2", productId: "nope" }, { id: "r3", productId: "gid://shopify/Product/999" }] }));
    const by = Object.fromEntries(res.results.map((r: any) => [r.id, r]));
    expect(by.r1).toMatchObject({ status: "failed", error: "Needs a title" });
    expect(by.r2.status).toBe("failed");
    expect(by.r3).toMatchObject({ status: "failed", error: "That product wasn't found in the store." });
    expect(shop.status).toBe("DRAFT");
    expect((await call("POST", "/api/activate", { items: [] })).status).toBe(400);
  });
  it("still get their stock added afterwards, like any other product", async () => {
    shop.status = "DRAFT";
    await call("POST", "/api/activate", { items: [{ id: "r1", productId: PRODUCT }] });
    const res = await json(call("POST", "/api/stock", { runCode: "R1", items: [{ ...line(), productId: PRODUCT }] }));
    expect(res.results[0]).toMatchObject({ status: "added", qty: 24 });
    expect(shop.status).toBe("ACTIVE");
    expect(shop.onHand).toBe(24);
  });
});
