import { describe, expect, it } from "vitest";
import { PROMPT, TITLE_STYLE, sanitize, sanitizeQuantity } from "../src/extract";

describe("title cleaning", () => {
  it("keeps the invoice wording next to the cleaned title", () => {
    const [r] = sanitize([{ invoiceTitle: "BLN LTX 30CM ASST 25PK", title: "Assorted Latex Balloons 30cm (Pack of 25)", supplierCode: "B1", barcode: null }]);
    expect(r).toMatchObject({ title: "Assorted Latex Balloons 30cm (Pack of 25)", invoiceTitle: "BLN LTX 30CM ASST 25PK", supplierCode: "B1", barcode: null });
  });

  it("falls back to the invoice wording if the AI gives no cleaned title", () => {
    const [r] = sanitize([{ invoiceTitle: "Party Hats Rainbow 8pk", title: "  ", supplierCode: null, barcode: null }]);
    expect(r?.title).toBe("Party Hats Rainbow 8pk");
    expect(r?.invoiceTitle).toBeUndefined();
  });

  it("doesn't repeat the invoice wording when nothing changed", () => {
    const [r] = sanitize([{ invoiceTitle: "Clear Visor", title: "Clear Visor", supplierCode: null, barcode: null }]);
    expect(r?.invoiceTitle).toBeUndefined();
  });

  it("still accepts the older shape with only a title", () => {
    const [r] = sanitize([{ title: "Kangaroo Keyring", supplierCode: null, barcode: null }]);
    expect(r?.title).toBe("Kangaroo Keyring");
  });

  it("sends the house style with every invoice", () => {
    expect(PROMPT).toContain(TITLE_STYLE);
    expect(TITLE_STYLE).toMatch(/Never add facts/);
  });
});

describe("quantities from the AI", () => {
  it("keeps the printed quantity, unit and pack size as numbers", () => {
    const [r] = sanitize([{ invoiceTitle: "Gold Foil Banner", title: "Gold Foil Banner", supplierCode: "G1", barcode: null, quantity: "6", unit: " CTN ", unitsPer: 12, unclear: false }]);
    expect(r).toMatchObject({ quantity: 6, unit: "CTN", unitsPer: 12, qtyUnclear: false });
  });
  it("drops nonsense instead of guessing", () => {
    expect(sanitizeQuantity({ quantity: -3, unit: "null", unitsPer: 2.5, unclear: "yes" })).toEqual({ quantity: null, unit: null, unitsPer: null, qtyUnclear: false });
    expect(sanitizeQuantity({ quantity: "1,200", unitsPer: 1 })).toMatchObject({ quantity: 1200, unitsPer: 1 });
    expect(sanitizeQuantity({})).toMatchObject({ quantity: null });
  });
  it("asks the AI for supplied quantities, not ordered ones", () => {
    expect(PROMPT).toMatch(/never the quantity ordered/);
  });
});
