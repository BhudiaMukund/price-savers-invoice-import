import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the browser
import { cleanSupplierName, detectSupplier, nameFromFile } from "../public/js/supplier-detect.js";

const list = ["Alpen", "Dats", "Goldstar", "IG-Design", "Price Savers", "Toplite", "Harbour Novelty Imports"];

describe("working out the supplier", () => {
  it("picks an existing supplier from the name read on the invoice, under any spelling", () => {
    expect(detectSupplier({ aiName: "ALPEN PTY. LTD.", suppliers: list })).toEqual({ match: "Alpen", from: "invoice" });
  });
  it("picks one from the spreadsheet's heading or the file name", () => {
    expect(detectSupplier({ topLines: ["HARBOUR NOVELTY IMPORTS", "Importers of party lines"], suppliers: list })).toEqual({ match: "Harbour Novelty Imports", from: "sheet" });
    expect(detectSupplier({ fileNames: ["toplite_catalogue_2026.xlsx"], suppliers: list })).toEqual({ match: "Toplite", from: "file" });
    expect(detectSupplier({ fileNames: ["IG Design Invoice 4471.pdf"], suppliers: list })).toEqual({ match: "IG-Design", from: "file" });
  });
  it("never takes the shop being billed as the supplier", () => {
    expect(detectSupplier({ aiName: "Price Savers SA", topLines: ["Customer: PRICE SAVERS SA (WEST LAKES)"], fileNames: ["price-savers-order.csv"], suppliers: list })).toEqual({});
  });
  it("suggests a new supplier when none matches", () => {
    expect(detectSupplier({ aiName: "SUNBURST PARTY SUPPLIES PTY LTD", suppliers: list })).toEqual({ suggestion: "Sunburst Party Supplies", from: "invoice" });
    expect(detectSupplier({ topLines: ["SUNBURST PARTY SUPPLIES - B2B PORTAL ORDER EXPORT"], suppliers: list })).toEqual({ suggestion: "Sunburst Party Supplies", from: "sheet" });
    expect(detectSupplier({ fileNames: ["portacraft_products.csv"], suppliers: list })).toEqual({ suggestion: "Portacraft", from: "file" });
  });
  it("suggests nothing from names that aren't businesses", () => {
    for (const f of ["scan0001.jpg", "Price list 2026.xlsx", "INV-45512.pdf", "Order Confirmation.pdf"]) expect(detectSupplier({ fileNames: [f], suppliers: list })).toEqual({});
    expect(detectSupplier({ topLines: ["Order Confirmation", "Tax Invoice 12345"], suppliers: list })).toEqual({});
  });
  it("tidies business names", () => {
    expect(cleanSupplierName("KOALA CRAFT PTY LTD")).toBe("Koala Craft");
    expect(cleanSupplierName("IG Design Group")).toBe("IG Design Group");
    expect(nameFromFile("3 - Harbour Novelty Imports - Order HN-5521.xlsx")).toBe("Harbour Novelty Imports");
    expect(nameFromFile("koala-photos.zip")).toBe("Koala");
  });
});
