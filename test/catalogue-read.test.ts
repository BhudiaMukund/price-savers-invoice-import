// @ts-nocheck -- Node-only test (reads fixture files); the project types are for Cloudflare Workers.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "@e965/xlsx";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
// @ts-ignore -- plain browser module
import { buildItems, buildSample, guessMap, readCatalogueFiles, withLinkColumns, xlsxPictures, cellRef, colLetter } from "../public/js/catalogue-read.js";

const FIX = path.join(__dirname, "fixtures");
const file = (name: string, bytes?: Uint8Array) => {
  const data = bytes ?? new Uint8Array(fs.readFileSync(path.join(FIX, name)));
  return { name, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
};
const deps = { XLSX, unzip: (b: Uint8Array) => unzipSync(b), zip: (f: any, o: any) => zipSync(f, o) };
const photoNames = (it: any) => it.photos.map((p: any) => p.name);

describe("catalogue: Excel with pictures over the cells", () => {
  it("finds the columns from the headings and puts each picture on its product", async () => {
    const read = await readCatalogueFiles([file("harbour-catalogue.xlsx")], deps);
    const map = guessMap(read);
    expect(map).toMatchObject({ sheet: "Range 2026", headerRow: 4, columns: { supplierCode: "A", barcode: "B", title: "C" } });
    const { items, stats } = buildItems(read, map);
    expect(items).toHaveLength(10);
    const by = Object.fromEntries(items.map((i: any) => [i.code, i]));
    expect(by["HN-7701"].photos).toHaveLength(2);
    expect(by["HN-7701"].barcode).toBe("9399111770133");
    // Stored as a number in Excel, so it lost its leading zero: restored.
    expect(by["HN-8001"].barcode).toBe("071234880010");
    // This picture starts at the bottom of the row above but mostly covers HN-8001's row.
    expect(by["HN-8001"].photos).toHaveLength(1);
    expect(by["HN-7712"].photos).toHaveLength(1);
    expect(by["HN-8003"]).toMatchObject({ mixed: true });
    expect(by["HN-8003"].photos).toHaveLength(3);
    expect(by["HN-8010"].barcode).toBeNull(); // no barcode: matched by code
    expect(by["HN-9105"].photos).toHaveLength(0);
    expect(stats).toMatchObject({ photos: 14, unplaced: 1 }); // the logo in the heading isn't a product
    // Every picture is a real JPEG
    const p = by["HN-6135"].photos[0];
    expect(p.type).toBe("image/jpeg");
    expect([...p.bytes.slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("works with the xdr: prefixes Excel itself writes", async () => {
    const zip = unzipSync(new Uint8Array(fs.readFileSync(path.join(FIX, "harbour-catalogue.xlsx"))));
    const xml = strFromU8(zip["xl/drawings/drawing1.xml"]!)
      .replace(/<(\/?)(wsDr|twoCellAnchor|oneCellAnchor|from|to|col|colOff|row|rowOff|ext|pic|nvPicPr|cNvPr|cNvPicPr|blipFill|spPr|clientData)\b/g, "<$1xdr:$2")
      .replace('<xdr:wsDr xmlns="', '<xdr:wsDr xmlns:xdr="');
    zip["xl/drawings/drawing1.xml"] = strToU8(xml);
    const pics = xlsxPictures(zip);
    expect(pics.bySheet["Range 2026"]).toHaveLength(14);
  });

  it("builds a short sample for the AI, with column letters", async () => {
    const read = await readCatalogueFiles([file("harbour-catalogue.xlsx")], deps);
    const s = buildSample(read);
    expect(s).toContain("## Sheet: Range 2026 (14 pictures placed on rows)");
    expect(s).toContain("Row 4: A=Item No | B=Barcode | C=Description");
    expect(s).toContain("Row 5: A=HN-7701 | B=9399111770133");
  });
});

describe("catalogue: pictures placed in cells (Excel 365)", () => {
  it("follows the rich value links to the right picture", async () => {
    const read = await readCatalogueFiles([file("koala-incell.xlsx")], deps);
    const { items } = buildItems(read, guessMap(read));
    expect(items.map((i: any) => [i.code, photoNames(i)])).toEqual([
      ["KC-118", ["image1.png"]],
      ["KC-512", ["image2.png"]],
    ]);
  });
});

describe("catalogue: CSV with photo links", () => {
  it("collects the links in column order", async () => {
    const read = await readCatalogueFiles([file("sunburst-links.csv")], deps);
    const map = guessMap(read);
    expect(map.columns).toMatchObject({ supplierCode: "A", barcode: "B", title: "C", photoLinks: ["D", "E"] });
    const { items, stats } = buildItems(read, map);
    expect(items).toHaveLength(8);
    expect(items[0].links).toEqual(["https://images.sunburst.example/SB-1021.jpg", "https://images.sunburst.example/SB-1021-b.jpg"]);
    expect(items.find((i: any) => i.code === "SB-5120").barcode).toBeNull();
    expect(stats.links).toBe(8);
  });
});

describe("catalogue: ZIP of photos named by code or barcode", () => {
  it("groups numbered photos and skips junk", async () => {
    const read = await readCatalogueFiles([file("koala-photos.zip")], deps);
    expect(read.sheets).toHaveLength(0);
    expect(read.unsupported).toBe(1); // logo.emf
    const { items } = buildItems(read, null);
    const got = Object.fromEntries(items.map((i: any) => [i.code ?? i.barcode, photoNames(i)]));
    expect(got).toEqual({
      "KC-118": ["KC-118.jpg", "KC-118_2.jpg"],
      "9399022205014": ["9399022205014.jpg"],
      "KC-310": ["KC-310-1.jpg", "KC-310-2.jpg"], // numbered photos of one product
      "KC-402": ["KC-402 front.jpg"],
      "KC-520": ["KC-520.png"],
    });
  });

  it("joins photo files to a spreadsheet's products by code or barcode", async () => {
    const csv = "Code,EAN,Name\nKC-118,9399022118062,Glitter Glue Pens\nKC-205,9399022205014,Crepe Paper Red\nSB-12,,Short code item\n";
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const jpg2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]); // a different picture: identical files on one product are kept once
    const zip = zipSync({ "list.csv": strToU8(csv), "KC-118-2.jpg": jpg2, "KC-118.jpg": jpg, "9399022205014.jpg": jpg, "SB-12.jpg": jpg, "ZZ-999.jpg": jpg });
    const read = await readCatalogueFiles([file("mixed.zip", zip)], deps);
    const { items, stats } = buildItems(read, guessMap(read));
    expect(items.map((i: any) => [i.code, photoNames(i)])).toEqual([
      ["KC-118", ["KC-118.jpg", "KC-118-2.jpg"]],
      ["KC-205", ["9399022205014.jpg"]],
      ["SB-12", ["SB-12.jpg"]], // a code ending in "-12" isn't mistaken for photo 12 of "SB"
    ]);
    expect(stats.unplaced).toBe(1); // ZZ-999 isn't in the list
  });
});

describe("cell references", () => {
  it("round-trips", () => {
    expect(cellRef("A1")).toEqual({ row: 0, col: 0 });
    expect(cellRef("AB12")).toEqual({ row: 11, col: 27 });
    expect(colLetter(27)).toBe("AB");
    expect(colLetter(0)).toBe("A");
  });
});

describe("catalogue: several spreadsheets at once (a portal export split into files)", () => {
  const book = (rows: any[][], sheet = "Sheet1", type: "xlsx" | "biff8" | "csv" = "xlsx") => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
    return new Uint8Array(XLSX.write(wb, { type: "array", bookType: type }));
  };
  const head = ["Code", "Barcode", "Description", "RRP"];

  it("reads every file with the same headings and merges repeats", async () => {
    const files = [
      file("export (2026-09-18 1).xls", book([["Portal export"], head, ["PC-1", "9300000000013", "Gift Bag Small", "2.99"], ["PC-2", "9300000000020", "Gift Bag Large", "3.99"]], "Sheet1", "biff8")),
      file("export (2026-09-18 2).xls", book([["Portal export"], [], head, ["PC-3", "9300000000037", "Ribbon Red", "1.49"], ["PC-2", "9300000000020", "Gift Bag Large", "3.99"]], "Sheet1", "biff8")),
      file("export (2026-09-18 3).xlsx", book([head, ["PC-4", "", "Card Birthday", "4.50"]])),
    ];
    const read = await readCatalogueFiles(files, deps);
    expect(read.problems).toEqual([]);
    expect(read.sheetFiles).toBe(3);
    expect(read.sheets.map((s: any) => s.name)).toEqual([
      "export (2026-09-18 1).xls › Sheet1",
      "export (2026-09-18 2).xls › Sheet1",
      "export (2026-09-18 3).xlsx › Sheet1",
    ]);
    const map = guessMap(read);
    expect(map).toMatchObject({ sheet: "export (2026-09-18 1).xls › Sheet1", headerRow: 2, columns: { supplierCode: "A", barcode: "B", title: "C" } });
    const { items, stats } = buildItems(read, map);
    expect(items.map((i: any) => i.code)).toEqual(["PC-1", "PC-2", "PC-3", "PC-4"]);
    expect(stats).toMatchObject({ sheets: 3, files: 3, rows: 5, skipped: 0 });
    expect(items.find((i: any) => i.code === "PC-2").rows).toEqual([4, 5]); // once from each file
    // Choosing another file's sheet reads the same set.
    expect(buildItems(read, { ...map, sheet: read.sheets[2].name, headerRow: 1 }).items).toHaveLength(4);
    // The AI gets one sample of the layout, not three.
    expect(buildSample(read).match(/## Sheet/g)).toHaveLength(1);
  });

  it("leaves out a file with different headings, and says which files can't be opened", async () => {
    const files = [
      file("range.xlsx", book([head, ["PC-1", "9300000000013", "Gift Bag Small", "2.99"]])),
      file("prices.xlsx", book([["SKU", "Price"], ["PC-1", "2.50"]])),
      file("broken.xlsx", new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])),
    ];
    const read = await readCatalogueFiles(files, deps);
    expect(read.problems).toEqual(["broken.xlsx couldn't be opened. Save it again from Excel and retry."]);
    const { items, stats } = buildItems(read, guessMap(read));
    expect(items).toHaveLength(1);
    expect(stats).toMatchObject({ sheets: 1, files: 1 });
  });

  it("places pictures from each file on that file's rows", async () => {
    const one = new Uint8Array(fs.readFileSync(path.join(FIX, "harbour-catalogue.xlsx")));
    const read = await readCatalogueFiles([file("harbour-a.xlsx", one), file("harbour-b.xlsx", one.slice())], deps);
    expect(Object.keys(read.pictures)).toEqual(["harbour-a.xlsx › Range 2026", "harbour-b.xlsx › Range 2026"]);
    const { items, stats } = buildItems(read, guessMap(read));
    expect(items).toHaveLength(10); // the same ten products in both files
    expect(stats).toMatchObject({ sheets: 2, photos: 28, unplaced: 2 });
    const hn = items.find((i: any) => i.code === "HN-7701");
    expect(hn.photos).toHaveLength(2); // the second file repeats the same two pictures: kept once
  });

  it("reads headerless files the same way as the first", async () => {
    const read = await readCatalogueFiles([file("a.csv", book([["9300000000019", "Gift Bag Small"]], "S", "csv")), file("b.csv", book([["9300000000033", "Ribbon Red"]], "S", "csv"))], deps);
    const map = guessMap(read);
    expect(map.headerRow).toBeNull();
    const { items, stats } = buildItems(read, map);
    expect(items.map((i: any) => i.title)).toEqual(["Gift Bag Small", "Ribbon Red"]);
    expect(stats.files).toBe(2);
  });
});

describe("catalogue: old .xls files (Goldstar-style exports)", () => {
  it("reads the pictures inside a binary .xls and puts them on their product rows", async () => {
    const read = await readCatalogueFiles([file("harbour-catalogue.xls")], deps);
    expect(read.problems).toEqual([]);
    expect(Object.values(read.pictures).flat()).toHaveLength(14); // the same 14 as in the .xlsx
    const { items, stats } = buildItems(read, guessMap(read));
    expect(items).toHaveLength(10);
    const by = Object.fromEntries(items.map((i: any) => [i.code, i]));
    expect(by["HN-7701"].photos).toHaveLength(2);
    expect(by["HN-8003"].photos).toHaveLength(3);
    expect(by["HN-9105"].photos).toHaveLength(0);
    expect(stats.unplaced).toBe(1); // the logo
    expect([...by["HN-6135"].photos[0].bytes.slice(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("finds a photo-link column that has no heading, even when the link's text is 'Click to preview'", async () => {
    const rows: any[][] = [[], [], [], ["Stockcode", "Description", "Unit Price", "Barcode", "Inner Qty", "Order Qty"]];
    for (let i = 1; i <= 6; i++) rows.push([`UMB000${i}`, `UMBRELLA ${i} ASST`, "3.93", i === 3 ? "" : `93283380110${80 + i}`, "12", ""]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    for (let i = 1; i <= 6; i++) ws[`J${4 + i}`] = { t: "s", v: "Click to preview", l: { Target: `https://ec.example.com.au/Images/UMB000${i}.JPG` } };
    ws["!ref"] = "A1:J10";
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
    const read = await readCatalogueFiles([file("export.xlsx", bytes)], deps);
    const guessed = guessMap(read);
    expect(guessed.columns.photoLinks).toEqual([]);
    const map = withLinkColumns(read, guessed);
    expect(map.columns.photoLinks).toEqual(["J"]);
    const { items } = buildItems(read, map);
    expect(items).toHaveLength(6);
    expect(items[0].links).toEqual(["https://ec.example.com.au/Images/UMB0001.JPG"]);
    // The AI sample shows the address behind the words, so it can tell this is a photo column.
    expect(buildSample(read)).toContain("J=Click to preview <https://ec.example.com.au/Images/UMB0001.JPG>");
  });

  it("uses a product's link rather than the small picture beside it, keeping the picture as a spare", async () => {
    const one = new Uint8Array(fs.readFileSync(path.join(FIX, "harbour-catalogue.xlsx")));
    const read = await readCatalogueFiles([file("harbour.xlsx", one)], deps);
    const map = guessMap(read);
    // The same sheet, but with a link to each product's photo in a column of its own.
    const sheet = read.sheets.find((s: any) => s.name === map.sheet);
    sheet.grid.forEach((row: string[], r: number) => {
      if (r >= map.headerRow && row.some(Boolean)) {
        row[9] = "Click to preview";
        sheet.links.set(`${r}:9`, `https://cdn.example.com/Images/${r}.JPG`);
      }
    });
    const built = buildItems(read, { ...map, columns: { ...map.columns, photoLinks: ["J"] } });
    const hn = built.items.find((i: any) => i.code === "HN-7705"); // one picture, one link
    expect(hn.links).toHaveLength(1);
    expect(hn.photos).toHaveLength(0); // the sheet's own picture is set aside...
    expect(hn.backup).toHaveLength(1); // ...and kept in case the link can't be used
    const solo = built.items.find((i: any) => i.code === "HN-9105"); // had no picture
    expect(solo.backup).toBeUndefined();
  });

  it("keeps both when there are more pictures than links", async () => {
    const one = new Uint8Array(fs.readFileSync(path.join(FIX, "harbour-catalogue.xlsx")));
    const read = await readCatalogueFiles([file("harbour.xlsx", one)], deps);
    const map = guessMap(read);
    const sheet = read.sheets.find((s: any) => s.name === map.sheet);
    sheet.grid.forEach((row: string[], r: number) => {
      if (r >= map.headerRow && row.some(Boolean)) {
        row[9] = "x";
        sheet.links.set(`${r}:9`, `https://cdn.example.com/Images/${r}.JPG`);
      }
    });
    const hn8003 = buildItems(read, { ...map, columns: { ...map.columns, photoLinks: ["J"] } }).items.find((i: any) => i.code === "HN-8003");
    expect(hn8003.photos).toHaveLength(3); // three pictures, one link: not the same set
    expect(hn8003.backup).toBeUndefined();
  });

  it("doesn't take a column of the same web page, or of non-picture links, for photos", async () => {
    const rows: any[][] = [["Code", "Barcode", "Name", "Site", "Page"]];
    for (let i = 1; i <= 5; i++) rows.push([`C${i}`, `93283380110${80 + i}`, `Thing ${i}`, "x", "y"]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    for (let i = 1; i <= 5; i++) {
      ws[`D${1 + i}`] = { t: "s", v: "Visit", l: { Target: "https://supplier.example.com/" } };
      ws[`E${1 + i}`] = { t: "s", v: "Details", l: { Target: `https://supplier.example.com/product?id=${i}` } };
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const read = await readCatalogueFiles([file("a.xlsx", new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })))], deps);
    expect(withLinkColumns(read, guessMap(read)).columns.photoLinks).toEqual([]);
  });

  it("keeps one copy of identical pictures and of the same link written two ways", async () => {
    const rows: any[][] = [["Code", "Barcode", "Name", "Photo", "Photo 2"], ["A1", "9328338011088", "Thing", "", ""], ["A1", "9328338011088", "Thing", "", ""]];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws.D2 = { t: "s", v: "Click", l: { Target: "https://Cdn.example.com/Images/A1.JPG" } };
    ws.E2 = { t: "s", v: "Click", l: { Target: "http://cdn.example.com/images/a1.jpg" } };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const read = await readCatalogueFiles([file("a.xlsx", new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })))], deps);
    const { items } = buildItems(read, { sheet: "S", headerRow: 1, columns: { supplierCode: "A", barcode: "B", title: "C", description: null, photoLinks: ["D", "E"] } });
    expect(items).toHaveLength(1);
    expect(items[0].links).toHaveLength(1);
  });
});
