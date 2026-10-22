import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS modules shared with the browser
import { createReader } from "../public/js/invoice-reader.js";
// @ts-expect-error plain JS
import { ApiError, SessionExpired } from "../public/js/api.js";

const tooLong = () => new ApiError("too long", 422, { code: "too_long", retryable: false });
const busy = () => new ApiError("busy", 422, { retryable: true });
const fast = { waits: [0, 0, 0, 0, 0] };

function jobs(n: number) {
  return Array.from({ length: n }, (_, i) => ({ key: `k${i}`, text: `PRODUCT ${i} GOLD` }));
}

describe("tidying titles in batches", () => {
  it("sends 100 at a time and applies each title to its own line", async () => {
    const sizes: number[] = [];
    const api = {
      tidyTitles: async (items: any[]) => {
        sizes.push(items.length);
        return { titles: items.map((i) => ({ id: i.id, title: `Tidy ${i.text}` })), rejected: [] };
      },
    };
    const got = new Map();
    const r = await createReader({ api, ApiError, SessionExpired }).tidyTitles(jobs(250), "Alpen", { ...fast, onResult: (k: string, t: string) => got.set(k, t) });
    expect(sizes).toEqual([100, 100, 50]);
    expect(r).toEqual({ tidied: 250, failed: 0, stoppedBy: null });
    expect(got.get("k137")).toBe("Tidy PRODUCT 137 GOLD");
  });

  it("asks again for turned-down lines in small batches, then keeps the simple tidy", async () => {
    const calls: number[] = [];
    const api = {
      tidyTitles: async (items: any[]) => {
        calls.push(items.length);
        // k3 is always turned down; k5 only the first time
        const bad = items.filter((i) => i.text === "PRODUCT 3 GOLD" || (i.text === "PRODUCT 5 GOLD" && calls.length === 1));
        return { titles: items.filter((i) => !bad.includes(i)).map((i) => ({ id: i.id, title: `Tidy ${i.text}` })), rejected: bad.map((i) => ({ id: i.id, reason: "x" })) };
      },
    };
    const ok: string[] = [];
    const failed: string[] = [];
    const r = await createReader({ api, ApiError, SessionExpired }).tidyTitles(jobs(10), null, { ...fast, onResult: (k: string) => ok.push(k), onFail: (k: string) => failed.push(k) });
    expect(calls).toEqual([10, 2]);
    expect(failed).toEqual(["k3"]);
    expect(ok).toContain("k5");
    expect(r).toMatchObject({ tidied: 9, failed: 1 });
  });

  it("halves a batch whose answer didn't fit", async () => {
    const sizes: number[] = [];
    const api = {
      tidyTitles: async (items: any[]) => {
        sizes.push(items.length);
        if (items.length > 30) throw tooLong();
        return { titles: items.map((i) => ({ id: i.id, title: i.text })), rejected: [] };
      },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).tidyTitles(jobs(100), null, fast);
    expect(r.tidied).toBe(100);
    expect(sizes[0]).toBe(100);
    expect(sizes.filter((n) => n <= 30).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("waits and tries again when the AI is busy", async () => {
    let n = 0;
    const api = {
      tidyTitles: async (items: any[], _s: unknown, attempt: number) => {
        n++;
        if (attempt < 3) throw busy();
        return { titles: items.map((i) => ({ id: i.id, title: i.text })), rejected: [] };
      },
    };
    const waits: number[] = [];
    const r = await createReader({ api, ApiError, SessionExpired }).tidyTitles(jobs(3), null, { ...fast, onWait: (s: number) => waits.push(s) });
    expect(n).toBe(3);
    expect(waits).toHaveLength(2);
    expect(r.tidied).toBe(3);
  });

  it("keeps the simple tidy for everything left when the AI can't be used, without more calls", async () => {
    let n = 0;
    const api = {
      tidyTitles: async () => {
        n++;
        throw new ApiError("Google refused the request (403).", 422, { retryable: false });
      },
    };
    const failed: string[] = [];
    const r = await createReader({ api, ApiError, SessionExpired }).tidyTitles(jobs(250), null, { ...fast, onFail: (k: string) => failed.push(k) });
    expect(n).toBe(1);
    expect(failed).toHaveLength(250);
    expect(r.stoppedBy).toMatch(/403/);
  });

  it("stops if staff remove the invoice", async () => {
    let cancelled = false;
    let n = 0;
    const api = {
      tidyTitles: async (items: any[]) => {
        n++;
        cancelled = true;
        return { titles: items.map((i) => ({ id: i.id, title: i.text })), rejected: [] };
      },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).tidyTitles(jobs(300), null, { ...fast, isCancelled: () => cancelled });
    expect(n).toBe(1);
    expect(r.stoppedBy).toBe("cancelled");
  });

  it("passes a sign-in expiry up", async () => {
    const api = { tidyTitles: async () => Promise.reject(new SessionExpired()) };
    await expect(createReader({ api, ApiError, SessionExpired }).tidyTitles(jobs(2), null, fast)).rejects.toBeInstanceOf(SessionExpired);
  });
});

describe("long PDFs", () => {
  const line = (p: number, k: number) => ({ id: `row-${k}`, title: `Item p${p}-${k}`, invoiceTitle: `ITEM P${p}-${k}`, supplierCode: `C${p}${k}`, barcode: null, match: "new" });

  it("reads three pages at a time, using the page count from the first answer", async () => {
    const asked: string[] = [];
    const api = {
      extractFile: async (_n: string, _m: string, _b: string, _a: number, pages: { from: number; to: number }) => {
        asked.push(`${pages.from}-${pages.to}`);
        const rows = [];
        for (let p = pages.from; p <= Math.min(pages.to, 7); p++) rows.push(line(p, 0), line(p, 1));
        return { rows, invoice: { supplierName: "S", invoiceNumber: "9" }, store: { variants: 1 }, pageCount: 7 };
      },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).readPdfByPages("a.pdf", "application/pdf", "x", { waits: [0] });
    expect(asked).toEqual(["1-3", "4-6", "7-7", "8-10"]); // one look past the end, in case the count is low
    expect(r.rows).toHaveLength(14);
    expect(new Set(r.rows.map((x: any) => x.id)).size).toBe(14); // ids made unique across parts
    expect(r.invoice).toEqual({ supplierName: "S", invoiceNumber: "9" });
  });

  it("reads fewer pages when a part is still too long, and skips a page that can't be read at all", async () => {
    const asked: string[] = [];
    const api = {
      extractFile: async (_n: string, _m: string, _b: string, _a: number, pages: { from: number; to: number }) => {
        asked.push(`${pages.from}-${pages.to}`);
        if (pages.to - pages.from >= 1) throw tooLong(); // only single pages fit
        if (pages.from === 2) throw tooLong(); // page 2 is impossible
        return { rows: pages.from <= 3 ? [line(pages.from, 0)] : [], invoice: {}, store: null, pageCount: 3 };
      },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).readPdfByPages("a.pdf", "application/pdf", "x", { waits: [0] });
    expect(asked).toEqual(["1-3", "1-1", "2-2", "3-3", "4-4"]);
    expect(r.skippedPages).toEqual([2]);
    expect(r.rows.map((x: any) => x.invoiceTitle)).toEqual(["ITEM P1-0", "ITEM P3-0"]);
  });

  it("drops a line read twice across a page break", async () => {
    const api = {
      extractFile: async (_n: string, _m: string, _b: string, _a: number, pages: { from: number }) =>
        pages.from === 1
          ? { rows: [line(1, 0), line(3, 9)], invoice: {}, store: null, pageCount: 4 }
          : { rows: [line(3, 9), line(4, 0)], invoice: {}, store: null, pageCount: 4 },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).readPdfByPages("a.pdf", "application/pdf", "x", { waits: [0] });
    expect(r.rows.map((x: any) => x.invoiceTitle)).toEqual(["ITEM P1-0", "ITEM P3-9", "ITEM P4-0"]);
  });

  it("stops after two empty parts when the page count is unknown", async () => {
    let calls = 0;
    const api = {
      extractFile: async (_n: string, _m: string, _b: string, _a: number, pages: { from: number }) => {
        calls++;
        return { rows: pages.from === 1 ? [line(1, 0)] : [], invoice: {}, store: null, pageCount: null };
      },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).readPdfByPages("a.pdf", "application/pdf", "x", { waits: [0] });
    expect(calls).toBe(3);
    expect(r.rows).toHaveLength(1);
  });
});

describe("long PDFs whose page count is wrong, or whose page ranges the AI ignores", () => {
  const line = (p: number, k: number) => ({ id: `row-${k}`, title: `Item p${p}-${k}`, invoiceTitle: `ITEM P${p}-${k}`, supplierCode: `C${p}${k}`, barcode: null, match: "new" });
  it("keeps reading when the AI says fewer pages than there are", async () => {
    const asked: string[] = [];
    const api = {
      extractFile: async (_n: string, _m: string, _b: string, _a: number, pages: { from: number; to: number }) => {
        asked.push(`${pages.from}-${pages.to}`);
        const rows = [];
        for (let p = pages.from; p <= Math.min(pages.to, 8); p++) rows.push(line(p, 0));
        return { rows, invoice: {}, store: null, pageCount: 3 }; // really 8
      },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).readPdfByPages("a.pdf", "application/pdf", "x", { waits: [0] });
    expect(r.rows).toHaveLength(8);
  });
  it("trusts the page count read from the file over the AI's", async () => {
    const asked: string[] = [];
    const api = {
      extractFile: async (_n: string, _m: string, _b: string, _a: number, pages: { from: number; to: number }) => {
        asked.push(`${pages.from}-${pages.to}`);
        const rows = [];
        for (let p = pages.from; p <= Math.min(pages.to, 5); p++) rows.push(line(p, 0));
        return { rows, invoice: {}, store: null, pageCount: 1 };
      },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).readPdfByPages("a.pdf", "application/pdf", "x", { waits: [0], pageHint: 5 });
    expect(asked.slice(0, 2)).toEqual(["1-3", "4-5"]);
    expect(r.rows).toHaveLength(5);
  });
  it("doesn't keep a single line read again on the look past the end", async () => {
    const api = {
      extractFile: async (_n: string, _m: string, _b: string, _a: number, pages: { from: number }) =>
        pages.from === 1 ? { rows: [line(1, 0), line(2, 0)], invoice: {}, store: null, pageCount: 2 } : { rows: [line(2, 0)], invoice: {}, store: null, pageCount: 2 },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).readPdfByPages("a.pdf", "application/pdf", "x", { waits: [0] });
    expect(r.rows.map((x: any) => x.invoiceTitle)).toEqual(["ITEM P1-0", "ITEM P2-0"]);
  });
  it("drops lines read again when the AI returns the whole document for a page range", async () => {
    const all = [1, 2, 3, 4, 5, 6].map((p) => line(p, 0));
    const api = { extractFile: async () => ({ rows: all, invoice: {}, store: null, pageCount: 6 }) };
    const r = await createReader({ api, ApiError, SessionExpired }).readPdfByPages("a.pdf", "application/pdf", "x", { waits: [0] });
    expect(r.rows).toHaveLength(6);
  });
});

describe("spreadsheets the columns can't be worked out for", () => {
  it("are read by the AI in parts, halving a part that's too long", async () => {
    const grid = [["SUPPLIER"], ["Code", "Description", "Qty", "Price"]];
    for (let i = 0; i < 260; i++) grid.push([`C${i}`, `Thing ${i}`, "1", "2.50"]);
    const lens: number[] = [];
    const api = {
      extractText: async (_n: string, text: string) => {
        const body = text.split("--- this part starts here ---\n").pop()!.split("\n").filter((l) => /^C\d+,/.test(l));
        lens.push(body.length);
        if (body.length > 100) throw tooLong();
        return { rows: body.map((l, k) => ({ id: `row-${k}`, title: l.split(",")[1], match: "new" })), invoice: { supplierName: "SUPPLIER", invoiceNumber: null }, store: {} };
      },
    };
    const r = await createReader({ api, ApiError, SessionExpired }).readSheetsWithAi("a.csv", [{ name: "S", grid }], { waits: [0] });
    expect(r.rows).toHaveLength(260);
    expect(new Set(r.rows.map((x: any) => x.title)).size).toBe(260);
    expect(lens.filter((n) => n > 100).length).toBeGreaterThan(0);
  });
});

describe("working out the columns", () => {
  it("uses its own reading when the AI can't be reached", async () => {
    const api = { mapInvoice: async () => Promise.reject(new ApiError("down", 422, { retryable: false })) };
    const grid = [["Code", "Description", "Barcode"], ["A1", "Gold Banner", "9399001221547"]];
    const m = await createReader({ api, ApiError, SessionExpired }).mapSheets([{ name: "S", grid }], { waits: [0] });
    expect(m.trusted).toBe(true);
    expect(m.aiError).toBeTruthy();
    expect(m.map.columns.title).toBe("B");
  });
});
