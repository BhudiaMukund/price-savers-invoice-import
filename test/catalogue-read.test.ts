// @ts-nocheck -- Node-only test (reads fixture files); the project types are for Cloudflare Workers.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "@e965/xlsx";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
// @ts-ignore -- plain browser module
import { buildItems, buildSample, guessMap, readCatalogueFiles, xlsxPictures, cellRef, colLetter } from "../public/js/catalogue-read.js";

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
    const zip = zipSync({ "list.csv": strToU8(csv), "KC-118-2.jpg": jpg, "KC-118.jpg": jpg, "9399022205014.jpg": jpg, "SB-12.jpg": jpg, "ZZ-999.jpg": jpg });
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
