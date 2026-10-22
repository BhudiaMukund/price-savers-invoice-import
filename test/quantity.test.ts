// @ts-nocheck -- plain JS module shared with the browser
import { describe, expect, it } from "vitest";
import { resolveQuantity } from "../public/js/quantity.js";

describe("resolveQuantity", () => {
  it("counts single units as printed", () => {
    expect(resolveQuantity({ quantity: 12, unit: "EA" })).toEqual({ qty: 12, note: "", check: false });
    expect(resolveQuantity({ quantity: "24" })).toEqual({ qty: 24, note: "", check: false });
    expect(resolveQuantity({ quantity: 6, unit: "each", unitsPer: 1 })).toMatchObject({ qty: 6, check: false });
  });
  it("multiplies cartons by the pack size and shows the sum", () => {
    expect(resolveQuantity({ quantity: 3, unit: "CTN", unitsPer: 12 })).toEqual({ qty: 36, note: "3 × 12", check: false });
    expect(resolveQuantity({ quantity: 2, unit: "DOZ" })).toEqual({ qty: 24, note: "2 × 12", check: false });
  });
  it("asks for a look when the unit is a carton and the size isn't known", () => {
    const r = resolveQuantity({ quantity: 3, unit: "CTN" });
    expect(r).toMatchObject({ qty: 3, check: true });
    expect(r.note).toMatch(/how many single items/);
  });
  it("asks for a look when the AI couldn't tell", () => {
    expect(resolveQuantity({ quantity: 5, unclear: true })).toMatchObject({ check: true });
  });
  it("asks for a look when there's no usable number", () => {
    for (const quantity of [null, undefined, "", "abc", -2, 2.5]) expect(resolveQuantity({ quantity })).toMatchObject({ qty: null, check: true });
  });
  it("treats zero as a real answer (leave the stock alone)", () => {
    expect(resolveQuantity({ quantity: 0, unit: "EA" })).toMatchObject({ qty: 0, check: false });
  });
  it("refuses absurd totals", () => {
    expect(resolveQuantity({ quantity: 5000, unit: "CTN", unitsPer: 500 })).toMatchObject({ qty: null, check: true });
  });
});
