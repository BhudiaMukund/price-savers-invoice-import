import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { resetTokenCache } from "../src/shopify";
import { checkTitles, echoMatches, readTitleRequest, titleProblem } from "../src/titles";
import { cleanInvoiceMap } from "../src/invoice-map";
import type { Env } from "../src/types";

describe("checking tidied titles", () => {
  it("accepts good tidies, abbreviations spelled out", () => {
    expect(titleProblem("BLN LTX 30CM GLD 25PK", "Gold Latex Balloons 30cm (Pack of 25)")).toBeNull();
    expect(titleProblem("HN-7701 SKULL CANDLE HOLDER BLK 12CM", "Black Skull Candle Holder 12cm")).toBeNull();
    expect(titleProblem("PLT PPR 23CM PSTL PNK 10PK", "Pastel Pink Paper Plates 23cm (Pack of 10)")).toBeNull();
    expect(titleProblem("TBLCVR RECT GLD 137X274", "Gold Rectangle Tablecover 137 x 274cm")).toBeNull();
    expect(titleProblem("NAPK LUNCH 33CM BLK 20PK", "Black Lunch Napkins 33cm (Pack of 20)")).toBeNull();
    expect(titleProblem("Banner Foil \"Happy 21st\" Gold 2.5m", "Gold Happy 21st Foil Banner 2.5m")).toBeNull();
    expect(titleProblem("CANDLE 1,000 HOURS", "Candle 1000 Hours")).toBeNull();
    expect(titleProblem("SOCKS NOVELTY PAIR", "Novelty Socks (Pack of 2)")).toBeNull();
    expect(titleProblem("EGGS PLASTIC DOZEN", "Plastic Eggs (Pack of 12)")).toBeNull();
    expect(titleProblem("NUMBER CANDLE THREE GOLD", "Gold Number 3 Candle")).toBeNull();
  });

  it("turns down a title that belongs to a neighbouring line", () => {
    // Sizes, numbers or pack counts that aren't in this line
    expect(titleProblem("FOIL BLN NO.1 SLV 86CM", "Silver Number 2 Foil Balloon 86cm")).toMatch(/number 2/);
    expect(titleProblem("BLN LTX 30CM GLD 25PK", "Gold Latex Balloons 30cm (Pack of 50)")).toMatch(/number 50/);
    // Nothing in common
    expect(titleProblem("AUSSIE FLAG HEADBAND", "Red Novelty Glasses")).toMatch(/no words in common/);
  });

  it("turns down empty titles, barcodes and runaway text", () => {
    expect(titleProblem("X", "")).toBe("empty");
    expect(titleProblem("GLOW STICKS 9399001100217", "Glow Sticks 9399001100217")).toMatch(/barcode/);
    expect(titleProblem("GLOW STICKS", "Glow Sticks ".repeat(20))).toBe("too long");
  });

  it("checks the copy of the description that comes back", () => {
    expect(echoMatches("BLN LTX 30CM GLD 25PK", "BLN LTX 30CM GLD 25PK")).toBe(true);
    expect(echoMatches("BLN LTX 30CM GLD 25PK", "BLN LTX 30CM GLD 25PK.")).toBe(true);
    expect(echoMatches("BLN LTX 30CM GLD 25PK", "BLN LTX 30CM SLV 25PK")).toBe(false);
  });

  it("matches answers to lines by id and copy, never by position", () => {
    const sent = [
      { id: "t0", text: "FOIL BLN NO.1 SLV 86CM" },
      { id: "t1", text: "FOIL BLN NO.2 SLV 86CM" },
      { id: "t2", text: "AUSSIE FLAG HEADBAND" },
      { id: "t3", text: "NOVELTY GLASSES RED" },
      { id: "t4", text: "PARTY HATS 8PK" },
    ];
    const raw = {
      items: [
        // out of order: fine
        { id: "t1", original: "FOIL BLN NO.2 SLV 86CM", title: "Silver Number 2 Foil Balloon 86cm" },
        { id: "t0", original: "FOIL BLN NO.1 SLV 86CM", title: "Silver Number 1 Foil Balloon 86cm" },
        // copy belongs to another line: rejected
        { id: "t2", original: "NOVELTY GLASSES RED", title: "Red Novelty Glasses" },
        // answered twice, differently: rejected
        { id: "t3", original: "NOVELTY GLASSES RED", title: "Red Novelty Glasses" },
        { id: "t3", original: "NOVELTY GLASSES RED", title: "Novelty Glasses" },
        // an id that wasn't sent: ignored; t4 missing
        { id: "t9", original: "PARTY HATS 8PK", title: "Party Hats (Pack of 8)" },
      ],
    };
    const { titles, rejected } = checkTitles(sent, raw);
    expect(titles).toEqual([
      { id: "t0", title: "Silver Number 1 Foil Balloon 86cm" },
      { id: "t1", title: "Silver Number 2 Foil Balloon 86cm" },
    ]);
    expect(Object.fromEntries(rejected.map((r) => [r.id, r.reason]))).toEqual({ t2: "mixed up with another line", t3: "answered twice", t4: "missing" });
  });

  it("copes with a broken answer", () => {
    const sent = [{ id: "t0", text: "PARTY HATS" }];
    expect(checkTitles(sent, null).rejected).toEqual([{ id: "t0", reason: "missing" }]);
    expect(checkTitles(sent, { items: "nope" }).rejected).toHaveLength(1);
  });

  it("checks requests", () => {
    expect(readTitleRequest({ items: [] })).toHaveProperty("error");
    expect(readTitleRequest({ items: [{ id: "t0", text: "A" }, { id: "t0", text: "B" }] })).toHaveProperty("error");
    expect(readTitleRequest({ items: [{ id: "bad id!", text: "A" }] })).toHaveProperty("error");
    expect(readTitleRequest({ items: [{ id: "t0", text: "x".repeat(401) }] })).toHaveProperty("error");
    expect(readTitleRequest({ items: Array.from({ length: 101 }, (_, i) => ({ id: `t${i}`, text: "A" })) })).toHaveProperty("error");
    expect(readTitleRequest({ items: [{ id: "t0", text: "  A   B " }], supplier: " Alpen " })).toEqual({ items: [{ id: "t0", text: "A B" }], supplier: "Alpen" });
  });
});

describe("invoice column answers", () => {
  it("cleans the AI's answer", () => {
    const m = cleanInvoiceMap({
      supplierName: "  Harbour Novelty Imports ",
      invoiceNumber: "null",
      layout: "weird",
      sheet: "Order",
      headerRow: "6",
      columns: { title: "b", barcode: "B", supplierCode: "AAAA", titleExtras: ["C", "c", "B", "D", "E", "F"] },
    });
    expect(m).toEqual({
      supplierName: "Harbour Novelty Imports",
      invoiceNumber: null,
      layout: "table",
      sheet: "Order",
      headerRow: 6,
      columns: { title: "B", barcode: null, supplierCode: null, titleExtras: ["C", "D", "E"], quantity: null, unit: null, unitsPer: null },
    });
    expect(cleanInvoiceMap(null).columns.title).toBeNull();
    expect(cleanInvoiceMap({ columns: { title: "B", quantity: "f", unit: "g", unitsPer: "H" } }).columns).toMatchObject({ quantity: "F", unit: "G", unitsPer: "H" });
    // One column can't be both the title and the quantity.
    expect(cleanInvoiceMap({ columns: { title: "B", quantity: "B" } }).columns.quantity).toBeNull();
    expect(cleanInvoiceMap({ layout: "other" }).layout).toBe("other");
  });
});

/* ------------------------------------------------------------------ routes, with a fake AI */

let env: Env;
let aiBodies: any[];
let aiReply: (body: any) => Response;

const gemini = (obj: unknown, finishReason = "STOP") => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(obj) }] } }] });

beforeEach(() => {
  resetTokenCache();
  env = { SHOPIFY_STORE_DOMAIN: "t.myshopify.com", SHOPIFY_API_VERSION: "2026-07", SHOPIFY_ADMIN_TOKEN: "t", AI_PROVIDER: "gemini", AI_MODEL: "main", AI_FALLBACK_MODEL: "backup", GEMINI_API_KEY: "k", DEV_AUTH_BYPASS: "true" } as unknown as Env;
  aiBodies = [];
  aiReply = () => gemini({ items: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (String(url).includes("generativelanguage")) {
        const body = typeof init.body === "string" ? init.body : await new Response(init.body).text();
        const parsed = JSON.parse(body);
        aiBodies.push({ url: String(url), body: parsed });
        return aiReply(parsed);
      }
      // Shopify: an empty store
      return Response.json({ data: { productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);

describe("/api/titles", () => {
  it("returns only titles that pass the checks", async () => {
    aiReply = (b) => {
      const lines = b.contents[0].parts[1].text.split("\n").filter((l: string) => /^t\d+: /.test(l));
      return gemini({ items: lines.map((l: string) => ({ id: l.split(": ")[0], original: l.slice(l.indexOf(": ") + 2), title: l.includes("HATS") ? "Party Hats (Pack of 9)" : "Gold Latex Balloons 30cm (Pack of 25)" })) });
    };
    const res = await post("/api/titles", { items: [{ id: "t0", text: "BLN LTX 30CM GLD 25PK" }, { id: "t1", text: "PARTY HATS 8PK" }], supplier: "Alpen" });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.titles).toEqual([{ id: "t0", title: "Gold Latex Balloons 30cm (Pack of 25)" }]);
    expect(body.rejected).toEqual([{ id: "t1", reason: "the number 9 isn't in the description" }]);
    expect(aiBodies[0].body.contents[0].parts[1].text).toContain("Supplier: Alpen");
  });

  it("says when the answer didn't fit, so the page sends fewer", async () => {
    aiReply = () => gemini({ items: [] }, "MAX_TOKENS");
    const res = await post("/api/titles", { items: [{ id: "t0", text: "A B" }] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "too_long", retryable: false });
  });

  it("uses the backup model from the second try", async () => {
    aiReply = () => gemini({ items: [] });
    await post("/api/titles", { items: [{ id: "t0", text: "A B" }] }, { "X-AI-Attempt": "2" });
    expect(aiBodies[0].url).toContain("models/backup:");
  });

  it("refuses bad requests", async () => {
    expect((await post("/api/titles", { items: [{ id: "", text: "A" }] })).status).toBe(400);
  });
});

describe("/api/invoice/map", () => {
  it("returns the cleaned column answer", async () => {
    aiReply = () => gemini({ supplierName: "Harbour", invoiceNumber: "HN-1", layout: "table", sheet: "S", headerRow: 6, columns: { title: "B", barcode: "E", supplierCode: "A", titleExtras: [] } });
    const res = await post("/api/invoice/map", { sample: "## Sheet: S\nRow 6: A=Item No | B=Description" });
    expect(await res.json()).toMatchObject({ map: { supplierName: "Harbour", headerRow: 6, columns: { title: "B" } } });
  });
  it("refuses a whole file", async () => {
    expect((await post("/api/invoice/map", { sample: "x".repeat(80_001) })).status).toBe(413);
  });
});

describe("reading long PDFs a few pages at a time", () => {
  const file = (headers: Record<string, string>) =>
    app.fetch(
      new Request("http://x/api/extract-file", {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-File-Name": "big.pdf", "X-File-Type": "application/pdf", "Content-Length": "8", ...headers },
        body: "QUJDREVGRw==".slice(0, 8),
      }),
      env,
    );

  it("asks only for the pages wanted, and returns the page count", async () => {
    aiReply = () => gemini({ supplierName: "S", invoiceNumber: "1", pageCount: 9, items: [{ invoiceTitle: "A", title: "A", supplierCode: null, barcode: null }] });
    const res = await file({ "X-Pages": "4-6" });
    const body: any = await res.json();
    expect(body.pageCount).toBe(9);
    expect(aiBodies[0].body.contents[0].parts[0].text).toContain("Only return product lines printed on pages 4 to 6");
  });

  it("says too_long when the answer doesn't fit", async () => {
    aiReply = () => gemini({}, "MAX_TOKENS");
    const res = await file({});
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "too_long" });
  });

  it("refuses odd page ranges", async () => {
    for (const p of ["0-2", "5-3", "abc", "1-60"]) expect((await file({ "X-Pages": p })).status).toBe(400);
  });

  it("tells the AI which part of a long spreadsheet it's reading", async () => {
    aiReply = () => gemini({ supplierName: null, invoiceNumber: null, pageCount: 1, items: [] });
    await post("/api/extract", { filename: "a.csv", text: "a,b", part: "This is part 2 of 3." });
    expect(aiBodies[0].body.contents[0].parts[0].text).toContain("This is part 2 of 3.");
  });
});

describe("near-identical lines", () => {
  const sent = [
    { id: "t0", text: "LATEX BALLOON 30CM PASTEL ASSORTED COLOURS PK25 RED" },
    { id: "t1", text: "LATEX BALLOON 30CM PASTEL ASSORTED COLOURS PK25 BLUE" },
  ];
  const tidy = (c: string) => `${c} Latex Balloons 30cm (Pack of 25)`;
  it("accepts each line's own title", () => {
    const r = checkTitles(sent, { items: [{ id: "t0", original: sent[0]!.text, title: tidy("Red") }, { id: "t1", original: sent[1]!.text, title: tidy("Blue") }] });
    expect(r.rejected).toEqual([]);
  });
  it("turns down swapped answers", () => {
    const r = checkTitles(sent, { items: [{ id: "t0", original: sent[1]!.text, title: tidy("Blue") }, { id: "t1", original: sent[0]!.text, title: tidy("Red") }] });
    expect(r.titles).toEqual([]);
  });
  it("turns down a title with the other line's colour, even with the right copy", () => {
    const r = checkTitles(sent, { items: [{ id: "t0", original: sent[0]!.text, title: tidy("Blue") }, { id: "t1", original: sent[1]!.text, title: tidy("Blue") }] });
    expect(r.rejected.map((x) => x.id)).toEqual(["t0"]);
  });
  it("still accepts abbreviations spelled out", () => {
    const s2 = [{ id: "t0", text: "BLN LTX 30CM BLK 25PK" }, { id: "t1", text: "BLN LTX 30CM WHT 25PK" }];
    const r = checkTitles(s2, { items: [{ id: "t0", original: s2[0]!.text, title: "Black Latex Balloons 30cm (Pack of 25)" }, { id: "t1", original: s2[1]!.text, title: "White Latex Balloons 30cm (Pack of 25)" }] });
    expect(r.rejected).toEqual([]);
  });
  it("doesn't turn down good titles because other lines share their words", () => {
    const s3 = [
      { id: "t0", text: "BLN 30CM ASST PK25" },
      { id: "t1", text: "LATEX BALLOON 30CM GOLD" },
      { id: "t2", text: "HBD BANNER" },
      { id: "t3", text: "HAPPY BIRTHDAY CANDLES 24PK" },
      { id: "t4", text: "NAPK LUNCH GOLD PK16" },
      { id: "t5", text: "PAPER PLATES 23CM" },
    ];
    const titles = ["Assorted Latex Balloons 30cm (Pack of 25)", "Gold Latex Balloon 30cm", "Happy Birthday Banner", "Happy Birthday Candles (Pack of 24)", "Gold Paper Lunch Napkins (Pack of 16)", "Paper Plates 23cm"];
    const r = checkTitles(s3, { items: s3.map((x, i) => ({ id: x.id, original: x.text, title: titles[i] })) });
    expect(r.rejected).toEqual([]);
  });
  it("turns down swapped titles on lines that differ in several words", () => {
    const s4 = [
      { id: "t0", text: "18IN FOIL RND DINOSAUR BDAY HOLO" },
      { id: "t1", text: "18IN FOIL RND MONSTER TRUCK HOLO" },
    ];
    const r = checkTitles(s4, {
      items: [
        { id: "t0", original: s4[0]!.text, title: "18in Round Monster Truck Holographic Foil Balloon" },
        { id: "t1", original: s4[1]!.text, title: "18in Round Dinosaur Birthday Holographic Foil Balloon" },
      ],
    });
    expect(r.titles).toEqual([]);
    const ok = checkTitles(s4, {
      items: [
        { id: "t0", original: s4[0]!.text, title: "18in Round Dinosaur Birthday Holographic Foil Balloon" },
        { id: "t1", original: s4[1]!.text, title: "18in Round Monster Truck Holographic Foil Balloon" },
      ],
    });
    expect(ok.rejected).toEqual([]);
  });
});
