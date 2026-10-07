import { beforeEach, describe, expect, it } from "vitest";
import { RunStore, StoreError, resetSchemaCache, summarise } from "../src/store";
import { sqliteDb } from "./sqlite-db";

let store: RunStore;
beforeEach(() => {
  resetSchemaCache();
  store = new RunStore(sqliteDb());
});

const data = (sources: object[], rows: object[] = []) => JSON.stringify({ sources, rows });

describe("runs", () => {
  it("numbers runs R1, R2 and records who started them", async () => {
    const a = await store.createRun("amy@shop.com");
    const b = await store.createRun("ben@shop.com");
    expect([a.code, b.code]).toEqual(["R1", "R2"]);
    expect(b.createdBy).toBe("ben@shop.com");
    expect(a.version).toBe(1);
  });

  it("saves the working state and refuses a stale save", async () => {
    const run = await store.createRun("amy@shop.com");
    const saved = await store.saveRun(run.code, 1, data([{ id: "s1", name: "inv.pdf", supplier: "Alpen" }]), "amy@shop.com");
    expect(saved.version).toBe(2);
    await expect(store.saveRun(run.code, 1, data([]), "ben@shop.com")).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    const again = await store.getRun(run.code);
    expect((again!.data as any).sources[0].name).toBe("inv.pdf");
    expect(again!.updatedBy).toBe("amy@shop.com");
  });

  it("won't let an invoice with products still in Shopify be removed, until they're deleted", async () => {
    const run = await store.createRun("amy@shop.com");
    await store.saveRun(run.code, 1, data([{ id: "s1", name: "a.pdf" }, { id: "s2", name: "b.pdf" }]), "amy");
    const runId = (await store.runId(run.code))!;
    await store.recordProducts(
      [{ productId: "gid://shopify/Product/1", runId, invoiceId: "s1", importId: "20261007-R1-ALPEN-AAAA", title: "X", barcode: null, vendor: "Alpen" }],
      "amy",
    );
    // Removing s2 (nothing in Shopify) is fine
    await store.saveRun(run.code, 2, data([{ id: "s1", name: "a.pdf" }]), "amy");
    // Removing s1 is refused
    await expect(store.saveRun(run.code, 3, data([]), "amy")).rejects.toMatchObject({ status: 409, code: "invoice_has_products" });
    expect((await store.getRun(run.code))!.liveByInvoice).toEqual({ s1: 1 });
    // After the products are deleted, it can go
    await store.markDeleted(["gid://shopify/Product/1"], "amy");
    await store.saveRun(run.code, 3, data([]), "amy");
    expect((await store.getRun(run.code))!.liveByInvoice).toEqual({});
  });

  it("lists runs newest first, hides empty runs, searches and filters by person", async () => {
    const r1 = await store.createRun("amy@shop.com");
    await store.saveRun(r1.code, 1, data([{ id: "a", name: "alpen-oct.pdf", supplier: "Alpen", importId: "20261007-R1-ALPEN-AAAA" }], [{ title: "Gold Banner", barcode: "9311192614151" }]), "amy@shop.com");
    const r2 = await store.createRun("ben@shop.com");
    await store.saveRun(r2.code, 1, data([{ id: "b", name: "goldstar.xlsx", supplier: "Goldstar" }], [{ title: "Party Hats" }]), "ben@shop.com");
    await store.createRun("ben@shop.com"); // empty: not listed

    expect((await store.listRuns({})).runs.map((r) => r.code)).toEqual(["R2", "R1"]);
    expect((await store.listRuns({ q: "banner" })).runs.map((r) => r.code)).toEqual(["R1"]);
    expect((await store.listRuns({ q: "9311192614151" })).runs.map((r) => r.code)).toEqual(["R1"]);
    expect((await store.listRuns({ q: "R1-ALPEN" })).runs.map((r) => r.code)).toEqual(["R1"]);
    expect((await store.listRuns({ q: "goldstar hats" })).runs.map((r) => r.code)).toEqual(["R2"]);
    expect((await store.listRuns({ createdBy: "amy@shop.com" })).runs.map((r) => r.code)).toEqual(["R1"]);
    expect((await store.listRuns({ q: "100%_" })).runs).toEqual([]);
    const [top] = (await store.listRuns({})).runs;
    expect(top).toMatchObject({ invoiceCount: 1, productCount: 1, invoiceNames: ["goldstar.xlsx"], suppliers: ["Goldstar"] });
  });

  it("pages through runs", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await store.createRun("amy");
      await store.saveRun(r.code, 1, data([{ id: "x", name: `inv${i}` }]), "amy");
    }
    const p1 = await store.listRuns({ limit: 2 });
    expect(p1.runs.map((r) => r.code)).toEqual(["R5", "R4"]);
    const p2 = await store.listRuns({ limit: 2, before: p1.next! });
    expect(p2.runs.map((r) => r.code)).toEqual(["R3", "R2"]);
  });

  it("only deletes a run with nothing left in Shopify", async () => {
    const run = await store.createRun("amy");
    const runId = (await store.runId(run.code))!;
    await store.recordProducts([{ productId: "p1", runId, invoiceId: "s1", importId: "x-R1-A", title: "X", barcode: null, vendor: null }], "amy");
    await expect(store.deleteRun(run.code)).rejects.toBeInstanceOf(StoreError);
    await store.markDeleted(["p1"], "amy");
    await store.deleteRun(run.code);
    expect(await store.getRun(run.code)).toBeNull();
  });

  it("checks the ledger before undo", async () => {
    const run = await store.createRun("amy");
    const runId = (await store.runId(run.code))!;
    await store.recordProducts(
      [
        { productId: "p1", runId, invoiceId: "s1", importId: "IMP-A", title: "A", barcode: null, vendor: null },
        { productId: "p2", runId, invoiceId: "s1", importId: "IMP-B", title: "B", barcode: null, vendor: null },
      ],
      "amy",
    );
    expect([...(await store.liveInImport("IMP-A", ["p1", "p2", "p3"]))]).toEqual(["p1"]);
  });

  it("ignores unknown run codes", async () => {
    expect(await store.getRun("DROP TABLE")).toBeNull();
    expect(await store.getRun("R999")).toBeNull();
  });
});

describe("summarise", () => {
  it("builds lower-case search text from invoices and products", () => {
    const s = summarise({ sources: [{ id: "a", name: "Inv.pdf", supplier: "Alpen", invoiceNumber: "45512" }], rows: [{ title: "Gold Banner" }] }, "R7", "Amy@Shop.com");
    expect(s.search).toContain("r7");
    expect(s.search).toContain("gold banner");
    expect(s.search).toContain("45512");
    expect(s.invoiceIds).toEqual(["a"]);
  });
});
