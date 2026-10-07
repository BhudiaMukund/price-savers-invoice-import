import { describe, expect, it } from "vitest";
import { buildStoreIndex, classifyItems } from "../src/match";
import type { StoreProduct } from "../src/types";

const store: StoreProduct[] = [
  { productId: "gid://1", title: "Balloon Pack", handle: "balloon-pack", barcode: "'4006381333931", sku: "" },
  { productId: "gid://2", title: "UPC item", handle: "upc-item", barcode: "036000291452", sku: "" },
  { productId: "gid://3", title: "Internal code", handle: "internal", barcode: "123456", sku: "" },
];
const index = buildStoreIndex(store);

describe("classifyItems", () => {
  it("skips items whose barcode already exists, even in a different GTIN form", () => {
    const [a, b] = classifyItems(
      [
        { title: "x", supplierCode: null, barcode: "4006381333931" },
        { title: "y", supplierCode: null, barcode: "0036000291452" }, // EAN-13 form of the UPC-A
      ],
      index,
    );
    expect(a?.match).toBe("exists");
    expect(b?.match).toBe("exists");
    expect(b?.existing?.productId).toBe("gid://2");
  });

  it("marks repeats inside one invoice", () => {
    const rows = classifyItems(
      [
        { title: "a", supplierCode: null, barcode: "96385074" },
        { title: "b", supplierCode: null, barcode: "96385074" },
      ],
      index,
    );
    expect(rows.map((r) => r.match)).toEqual(["new", "duplicate_in_invoice"]);
  });

  it("keeps items with missing or invalid barcodes as new but flagged", () => {
    const rows = classifyItems(
      [
        { title: "a", supplierCode: "A1", barcode: null },
        { title: "b", supplierCode: null, barcode: "4006381333932" },
      ],
      index,
    );
    expect(rows.map((r) => r.match)).toEqual(["new", "new"]);
    expect(rows.map((r) => r.barcodeStatus)).toEqual(["missing", "invalid_check_digit"]);
  });
});
