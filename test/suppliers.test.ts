import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module served to the browser
import { findExisting, makeImportId, matchSupplier, supplierKey } from "../public/js/suppliers.js";
import { IMPORT_ID_RE } from "../src/limits";

const list = ["Alpen", "Dats", "Goldstar", "IG-Design", "Price Savers", "Toplite"];

describe("matching the supplier printed on an invoice", () => {
  it("ignores company suffixes, case and punctuation", () => {
    expect(supplierKey("Alpen Pty. Ltd.")).toBe("alpen");
    expect(matchSupplier("ALPEN PTY LTD", list)).toBe("Alpen");
    expect(matchSupplier("IG Design Group Australia", list)).toBe("IG-Design");
    expect(matchSupplier("Goldstar Wholesale Co", list)).toBe("Goldstar");
  });
  it("returns nothing when unsure", () => {
    expect(matchSupplier("Party Co", list)).toBeNull();
    expect(matchSupplier("", list)).toBeNull();
    expect(matchSupplier("Pty Ltd", list)).toBeNull();
  });
  it("finds an exact name regardless of case and spacing", () => {
    expect(findExisting("  goldstar ", list)).toBe("Goldstar");
    expect(findExisting("Gold star", list)).toBeNull();
  });
});

describe("import IDs", () => {
  it("are date, supplier and a code, and pass the server's check", () => {
    const id = makeImportId("IG-Design", "R42", new Date(2026, 9, 7), new Uint8Array([0, 1, 2, 3]));
    expect(id).toBe("20261007-R42-IGDESIGN-ABCD");
    expect(IMPORT_ID_RE.test(id)).toBe(true);
  });
  it("still work with no supplier", () => {
    expect(makeImportId("", "R7", new Date(2026, 0, 2), new Uint8Array([30, 30, 30, 30]))).toBe("20260102-R7-NOSUPPLIER-9999");
  });
  it("differ between imports", () => {
    const ids = new Set(Array.from({ length: 200 }, () => makeImportId("Alpen", "R1")));
    expect(ids.size).toBeGreaterThan(195);
  });
});
