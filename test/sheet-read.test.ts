// @ts-nocheck -- Node-only test (reads fixture files); the project types are for Cloudflare Workers.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "@e965/xlsx";
// @ts-expect-error plain JS module shared with the browser
import * as S from "../public/js/sheet-read.js";

const FIX = path.join(__dirname, "fixtures", "invoices");
const harbour = () => S.sheetsFromWorkbook(XLSX, XLSX.read(fs.readFileSync(path.join(FIX, "harbour-order.xlsx")), { type: "buffer", cellDates: true }));
const sunburst = () => [{ name: "sunburst", grid: S.tidyGrid(S.parseDelimited(S.decodeText(fs.readFileSync(path.join(FIX, "sunburst-order.csv"))))) }];
const sheet = (grid: string[][], name = "Sheet1") => ({ name, grid: S.tidyGrid(grid) });
const titles = (r: any) => r.items.map((i: any) => i.invoiceTitle);

const HARBOUR_CODES = ["HN-7701", "HN-7705", "HN-7712", "HN-8001", "HN-8003", "HN-8010", "HN-9030", "HN-9031", "HN-6120", "HN-6135"];

describe("text files", () => {
  it("reads UTF-8 with a byte order mark", () => {
    expect(S.decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x2c, 0x42]))).toBe("A,B");
  });
  it("reads old Windows exports (curly quotes, pound sign)", () => {
    const bytes = new Uint8Array([0x93, 0x48, 0x69, 0x94, 0x2c, 0xa3, 0x35]);
    expect(S.decodeText(bytes)).toBe("“Hi”,£5");
  });
  it("reads Excel's Unicode text (UTF-16)", () => {
    const text = "Code\tDesc\r\nA1\tCafé";
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) bytes[2 + i * 2] = text.charCodeAt(i);
    expect(S.parseDelimited(S.decodeText(bytes))).toEqual([["Code", "Desc"], ["A1", "Café"]]);
  });
  it("handles quotes, doubled quotes, line breaks inside quotes and any line ending", () => {
    const csv = 'Code,Description,EAN\r\nSB-1,"Banner ""Happy 21st"", Gold",9399001221547\nSB-2,"Two\nlines",\rSB-3,Plain,';
    expect(S.parseDelimited(csv)).toEqual([
      ["Code", "Description", "EAN"],
      ["SB-1", 'Banner "Happy 21st", Gold', "9399001221547"],
      ["SB-2", "Two lines", ""],
      ["SB-3", "Plain", ""],
    ]);
  });
  it("works out semicolons, tabs and pipes, and Excel's sep= hint", () => {
    expect(S.parseDelimited("a;b;c\n1;2,5;3\n4;5;6")).toEqual([["a", "b", "c"], ["1", "2,5", "3"], ["4", "5", "6"]]);
    expect(S.parseDelimited("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(S.parseDelimited("a|b\n1|2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(S.parseDelimited("sep=;\na;b,c\n1;2")).toEqual([["a", "b,c"], ["1", "2"]]);
  });
});

describe("cells", () => {
  it("cleans barcode cells the way suppliers write them", () => {
    expect(S.cleanBarcodeCell("'9399001221547")).toBe("9399001221547");
    expect(S.cleanBarcodeCell("9310 7200 7315 6")).toBe("9310720073156");
    expect(S.cleanBarcodeCell("EAN: 9310720073156")).toBe("9310720073156");
    expect(S.cleanBarcodeCell("9310720073156.0")).toBe("9310720073156");
    expect(S.cleanBarcodeCell("9310720073157 / 9310720073156")).toBe("9310720073156"); // the valid one
    expect(S.cleanBarcodeCell("9.39911E+12")).toBe("9.39911E+12"); // kept, so it's flagged
    expect(S.cleanBarcodeCell("n/a")).toBe("");
    expect(S.cleanBarcodeCell("")).toBe("");
  });
  it("only keeps codes that look like codes", () => {
    expect(S.cleanCodeCell("HN-7701")).toBe("HN-7701");
    expect(S.cleanCodeCell("SB DSP1")).toBe("SB DSP1");
    expect(S.cleanCodeCell("Note: HN-8010 barcodes not yet assigned.")).toBe("");
    expect(S.cleanCodeCell("A".repeat(41))).toBe("");
  });
  it("keeps Excel barcodes exactly (no rounding, leading zeros kept)", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Code", "Description", "Barcode"], ["A1", "Thing", 9310720073156], ["A2", "Other", "0071234880010"]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Lines");
    const sheets = S.sheetsFromWorkbook(XLSX, XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer" }));
    const { items } = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(items.map((i: any) => i.barcode)).toEqual(["9310720073156", "0071234880010"]);
  });
});

describe("the sample invoices", () => {
  it("reads the Harbour order by its columns, without the AI", () => {
    const sheets = harbour();
    const check = S.checkInvoiceMap(sheets, null);
    expect(check.trusted).toBe(true);
    expect(check.map).toMatchObject({ sheet: "Order Confirmation", headerRow: 6, columns: { title: "B", barcode: "E", supplierCode: "A" } });
    const r = S.readInvoiceRows(sheets, check.map);
    expect(r.items.map((i: any) => i.supplierCode)).toEqual(HARBOUR_CODES);
    expect(r.items[0]).toMatchObject({ invoiceTitle: "HN-7701 SKULL CANDLE HOLDER BLK 12CM", barcode: "9399111770133" });
    expect(r.items[2].barcode).toBe("9.39911E+12"); // scrambled by Excel: flagged later
    expect(r.items[3].barcode).toBe("71234880010"); // leading zero restored later
    expect(r.items[5].barcode).toBeNull();
    expect(S.findInvoiceNumber(sheets)).toBe("HN-5521");
  });

  it("reads the Sunburst export, skipping freight, totals and notes", () => {
    const sheets = sunburst();
    const check = S.checkInvoiceMap(sheets, null);
    expect(check.trusted).toBe(true);
    const r = S.readInvoiceRows(sheets, check.map);
    expect(r.items).toHaveLength(9);
    expect(titles(r)).not.toContain("Freight - Adelaide Metro");
    expect(r.items[3]).toMatchObject({ invoiceTitle: 'Banner Foil "Happy 21st" Gold 2.5m', barcode: "9399001221547" });
    expect(r.items[8]).toMatchObject({ invoiceTitle: "Counter Display Stand - Balloons (FOC)", supplierCode: "SB-DSP1", barcode: null });
    expect(S.findInvoiceNumber(sheets)).toBe("SO-48290");
  });

  it("uses a correct AI answer as it is", () => {
    const sheets = harbour();
    const ai = { layout: "table", sheet: "Order Confirmation", headerRow: 6, columns: { title: "B", barcode: "E", supplierCode: "A", titleExtras: [] } };
    const r = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, ai).map);
    expect(r.items.map((i: any) => i.supplierCode)).toEqual(HARBOUR_CODES);
  });

  it("corrects an AI answer that picked the wrong columns", () => {
    const sheets = harbour();
    // Inner quantity as the barcode, and barcode and code swapped
    for (const columns of [
      { title: "B", barcode: "D", supplierCode: "A", titleExtras: [] },
      { title: "B", barcode: "A", supplierCode: "E", titleExtras: [] },
      { title: "F", barcode: "E", supplierCode: "A", titleExtras: ["H"] }, // a price column as the title, qty as an extra
    ]) {
      const check = S.checkInvoiceMap(sheets, { layout: "table", sheet: "Order Confirmation", headerRow: 6, columns });
      expect(check.trusted).toBe(true);
      expect(check.map.columns).toMatchObject({ title: "B", barcode: "E", supplierCode: "A", titleExtras: [] });
    }
  });

  it("doesn't lose a product when the AI's headings row is really the first product", () => {
    const sheets = harbour();
    const check = S.checkInvoiceMap(sheets, { layout: "table", sheet: "Order Confirmation", headerRow: 8, columns: { title: "B", barcode: "E", supplierCode: "A", titleExtras: [] } });
    const r = S.readInvoiceRows(sheets, check.map);
    expect(r.items.map((i: any) => i.supplierCode)).toEqual(HARBOUR_CODES);
  });

  it("doesn't read the headings as a product when the AI's headings row is too early", () => {
    const sheets = harbour();
    const check = S.checkInvoiceMap(sheets, { layout: "table", sheet: "Order Confirmation", headerRow: 2, columns: { title: "B", barcode: "E", supplierCode: "A", titleExtras: [] } });
    const r = S.readInvoiceRows(sheets, check.map);
    expect(titles(r)).not.toContain("Description");
    expect(r.items.map((i: any) => i.supplierCode)).toEqual(HARBOUR_CODES);
  });

  it("hands layouts the AI calls 'other' to the AI", () => {
    expect(S.checkInvoiceMap(harbour(), { layout: "other", columns: {} }).trusted).toBe(false);
  });
});

describe("layouts", () => {
  it("reads a sheet with no headings by what the columns hold", () => {
    const sheets = [sheet([
      ["A100", "Gold Foil Banner 2.5m", "9399001221547", "6"],
      ["A101", "Silver Foil Banner 2.5m", "9399001221554", "6"],
      ["A102", "Pink Party Plates", "9310720073156", "12"],
    ])];
    const check = S.checkInvoiceMap(sheets, null);
    expect(check.trusted).toBe(true);
    expect(S.readInvoiceRows(sheets, check.map).items.map((i: any) => i.barcode)).toEqual(["9399001221547", "9399001221554", "9310720073156"]);
  });

  it("skips the headings repeated on each printed page", () => {
    const head = ["Code", "Description", "Barcode", "Qty"];
    const sheets = [sheet([head, ["A1", "Gold Banner", "9399001221547", "2"], [], ["Page 2"], head, ["A2", "Silver Banner", "9399001221554", "1"]])];
    const r = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(titles(r)).toEqual(["Gold Banner", "Silver Banner"]);
  });

  it("reads every sheet with the same headings (an invoice split over sheets)", () => {
    const head = ["Code", "Description", "Barcode"];
    const sheets = [
      sheet([["Order 55"], head, ["A1", "Gold Banner", "9399001221547"]], "Page 1"),
      sheet([head, ["A2", "Silver Banner", "9399001221554"]], "Page 2"),
      sheet([["Terms"], ["Pay in 30 days"]], "Terms"),
    ];
    const r = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(titles(r)).toEqual(["Gold Banner", "Silver Banner"]);
    expect(r.sheets).toEqual(["Page 1", "Page 2"]);
  });

  it("adds a separate colour or size column to the name, never number columns", () => {
    const sheets = [sheet([["Code", "Description", "Colour", "Barcode", "Qty"], ["A1", "Latex Balloons 30cm", "Gold", "9399001221547", "12"], ["A2", "Latex Balloons 30cm", "", "9399001221554", "12"]])];
    const check = S.checkInvoiceMap(sheets, { layout: "table", sheet: "Sheet1", headerRow: 1, columns: { title: "B", barcode: "D", supplierCode: "A", titleExtras: ["C", "E"] } });
    expect(check.map.columns.titleExtras).toEqual(["C"]);
    expect(titles(S.readInvoiceRows(sheets, check.map))).toEqual(["Latex Balloons 30cm Gold", "Latex Balloons 30cm"]);
  });

  it("tells products from totals, freight and notes", () => {
    const sheets = [sheet([
      ["Code", "Description", "Barcode", "Qty"],
      ["HN-9050", "Delivery Truck Foil Balloon", "", "3"], // a product, not freight
      ["FRT", "Freight", "", "1"],
      ["", "Delivery charge", "", "1"],
      ["", "Total Wipeout Toy", "9399001221547", "1"], // has a valid barcode: a product
      ["", "Subtotal", "", "120.00"],
      ["", "GST", "", "12.00"],
      ["--- CHRISTMAS ---"],
      ["", "", "", "Total 132.00"],
      ["", "", "9399001221554", "2"], // barcode, no description: a product needing a title
    ])];
    const r = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(titles(r)).toEqual(["Delivery Truck Foil Balloon", "Total Wipeout Toy", ""]);
    expect(r.items[2].barcode).toBe("9399001221554");
  });

  it("isn't fooled into a table by a letter-style sheet", () => {
    const sheets = [sheet([["Dear customer,"], ["Please find attached your order."], ["Regards"]])];
    expect(S.checkInvoiceMap(sheets, null).trusted).toBe(false);
  });

  it("reads 5,000 lines quickly", () => {
    const grid = [["Code", "Description", "Barcode", "Qty"]];
    for (let i = 0; i < 5000; i++) grid.push([`C${i}`, `Product number ${i} Gold`, i % 2 ? "9399001221547" : "", "1"]);
    const sheets = [sheet(grid)];
    const t = performance.now();
    const r = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(r.items).toHaveLength(5000);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe("text for the AI", () => {
  it("cuts a long sheet into parts that repeat the top rows, losing no row", () => {
    const grid = [["SUPPLIER CO"], ["Invoice", "INV-9"], ["Code", "Description", "Qty", "Price"]];
    for (let i = 0; i < 300; i++) grid.push([`C${i}`, `Thing ${i}`, "2", "1.50"]);
    const pieces = S.textParts([sheet(grid)], 120);
    expect(pieces).toHaveLength(3);
    const texts = pieces.map((p: any, k: number) => S.partText(p, k, pieces.length));
    expect(texts[0].text).toContain("SUPPLIER CO");
    expect(texts[1].text).toContain("Code,Description,Qty,Price");
    expect(texts[1].text).toContain("--- this part starts here ---");
    expect(texts[1].part).toMatch(/don't return products from them/);
    const body = pieces.flatMap((p: any) => p.body);
    expect(body).toHaveLength(300);
    const halves = S.splitPiece(pieces[1]);
    expect(halves[0].body.length + halves[1].body.length).toBe(pieces[1].body.length);
    expect(halves[1].first).toBe(false);
  });

  it("builds a sample of the first rows with column letters", () => {
    const s = S.buildInvoiceSample(harbour());
    expect(s).toContain("## Sheet: Order Confirmation");
    expect(s).toContain("Row 6: A=Item No | B=Description");
    expect(s.length).toBeLessThan(80_000);
  });
});

describe("products that look like totals or freight", () => {
  it("keeps real products whose names start like a total, a note or freight", () => {
    const rows = [
      ["TY01", "Thank You Cards 8pk", "", "2"],
      ["", "Balance Bike Red", "", "1"],
      ["", "Total Wipeout Game", "", "1"],
      ["TI5", "Tax Invoice Book", "", "3"],
      ["", "Payment Card Holder", "", "1"],
      ["", "Bank Note Money Prop", "", "5"],
      ["", "Discount Voucher Pack", "", "1"],
      ["DB1", "Deposit Box", "", "1"],
      ["B12", "Postage Stamp Stickers", "", "4"],
      ["", "Delivery Truck Foil Balloon", "", "3"],
    ];
    const sheets = [sheet([["Code", "Description", "Barcode", "Qty"], ...rows, ["", "Total", "", "99.00"], ["", "GST", "", "9.00"], ["", "Subtotal:", "", ""], ["", "Freight", "", "12.00"], ["FRT", "Freight - Adelaide Metro", "", "1"], ["", "Delivery charge", "", "1"], ["", "Thank you for your order", "", ""], ["", "Terms: 30 days", "", ""]])];
    const r = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(titles(r)).toEqual(rows.map((x) => x[1]));
  });

  it("doesn't take the supplier's details above a list with no headings as products", () => {
    const sheets = [sheet([
      ["Party Co Pty Ltd"],
      ["Invoice Date", "12/10/2026"],
      ["Deliver Instructions", "Leave at door"],
      ["A100", "Gold Foil Banner 2.5m", "9399001221547", "6"],
      ["A101", "Silver Foil Banner 2.5m", "9399001221554", "6"],
      ["A102", "Pink Party Plates", "9310720073156", "12"],
    ])];
    const r = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(titles(r)).toEqual(["Gold Foil Banner 2.5m", "Silver Foil Banner 2.5m", "Pink Party Plates"]);
  });

  it("reads semicolon files with decimal commas", () => {
    expect(S.parseDelimited("Balloon;2,50;5,00\nHat;1,20;2,40")).toEqual([["Balloon", "2,50", "5,00"], ["Hat", "1,20", "2,40"]]);
    expect(S.parseDelimited("Code,Desc,Price\nA1,Hat; red,2.50\nA2,Cap,1.00")).toEqual([["Code", "Desc", "Price"], ["A1", "Hat; red", "2.50"], ["A2", "Cap", "1.00"]]);
  });
  it("skips the usual ways of writing totals and charges", () => {
    const labels = ["Invoice Total", "Total Amount Due", "GST 10%", "Discount 5%", "Total (AUD)", "Freight & Handling", "Less: Credit", "Total Qty", "Total inc GST 233.53"];
    const sheets = [sheet([["Code", "Description", "Barcode", "Qty"], ["A1", "Gold Banner", "", "1"], ...labels.map((t) => ["", t, "", "1"])])];
    expect(titles(S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map))).toEqual(["Gold Banner"]);
  });

  it("keeps the first products of a list with no headings, even without barcodes", () => {
    const sheets = [sheet([["Balloon Red 30cm", "", "2", "1.00"], ["Party Hat", "", "1", "2.00"], ["Cups Pink", "9399001221547", "3", "1.00"], ["Plates", "9399001221554", "4", "1.00"]])];
    expect(titles(S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map))).toEqual(["Balloon Red 30cm", "Party Hat", "Cups Pink", "Plates"]);
  });
});

describe("quantities", () => {
  const qtyOf = (grid: string[][]) => {
    const sheets = [sheet(grid)];
    const check = S.checkInvoiceMap(sheets, null);
    return { check, items: S.readInvoiceRows(sheets, check.map).items };
  };
  it("reads the Harbour order's Qty and Unit, and ignores its Inner column", () => {
    const sheets = harbour();
    const { items } = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(items[0]).toMatchObject({ quantity: 12, unit: "EA", unitsPer: null });
    expect(items[1]).toMatchObject({ quantity: 24, unit: "EA" });
  });
  it("reads a plain Qty column", () => {
    const sheets = sunburst();
    const { items } = S.readInvoiceRows(sheets, S.checkInvoiceMap(sheets, null).map);
    expect(items.slice(0, 2).map((i: any) => i.quantity)).toEqual([12, 12]);
    expect(items[3].quantity).toBe(6);
  });
  it("uses the supplied quantity, never the ordered or back-ordered one", () => {
    const { check, items } = qtyOf([
      ["Code", "Description", "Barcode", "Qty Ordered", "Qty Shipped", "B/O"],
      ["A1", "Gold Balloon Pack", "9310720073156", "24", "20", "4"],
      ["A2", "Silver Balloon Pack", "9399001100217", "12", "12", "0"],
    ]);
    expect(check.map.columns.quantity).toBe("E");
    expect(items.map((i: any) => i.quantity)).toEqual([20, 12]);
  });
  it("won't use an ordered-only column", () => {
    const { check } = qtyOf([
      ["Code", "Description", "Barcode", "Qty Ordered"],
      ["A1", "Gold Balloon Pack", "9310720073156", "24"],
      ["A2", "Silver Balloon Pack", "9399001100217", "12"],
    ]);
    expect(check.map.columns.quantity).toBeNull();
  });
  it("passes carton units and pack sizes on, for the page to multiply", () => {
    const { items } = qtyOf([
      ["Code", "Description", "Barcode", "Qty", "UOM", "Carton Qty"],
      ["A1", "Gold Balloon Pack", "9310720073156", "3", "CTN", "12"],
      ["A2", "Silver Balloon Pack", "9399001100217", "5", "EA", "12"],
      ["A3", "Red Balloon Pack", "9400000000008", "2 DOZ", "", ""],
    ]);
    expect(items[0]).toMatchObject({ quantity: 3, unit: "CTN", unitsPer: 12 });
    expect(items[1]).toMatchObject({ quantity: 5, unit: "EA", unitsPer: null });
    expect(items[2]).toMatchObject({ quantity: 2, unit: "DOZ" });
  });
  it("takes the unit from a column heading like Cartons", () => {
    const { items } = qtyOf([
      ["Code", "Description", "Barcode", "Cartons"],
      ["A1", "Gold Balloon Pack", "9310720073156", "3"],
      ["A2", "Silver Balloon Pack", "9399001100217", "5"],
    ]);
    expect(items[0]).toMatchObject({ quantity: 3, unit: "Cartons" });
  });
  it("parses quantity cells", () => {
    expect(S.parseQuantityCell("1,200")).toEqual({ quantity: 1200, unit: "" });
    expect(S.parseQuantityCell("12 EA")).toEqual({ quantity: 12, unit: "EA" });
    expect(S.parseQuantityCell("12.5")).toEqual({ quantity: 12.5, unit: "" });
    expect(S.parseQuantityCell("n/a")).toBeNull();
    expect(S.parseQuantityCell("")).toBeNull();
  });
});
