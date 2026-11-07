import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module served to the browser
import { parsePrice, splitPasted } from "../public/js/pricing.js";

describe("typing a price", () => {
  it("reads dollars and cents", () => {
    expect(parsePrice("4.5")).toBe("4.50");
    expect(parsePrice(" $12 ")).toBe("12.00");
    expect(parsePrice("1,299.95")).toBe("1299.95");
  });
  it("refuses anything else, including zero", () => {
    for (const bad of ["", "0", "0.00", "-2", "4.999", "free", "1e3", null]) expect(parsePrice(bad)).toBeNull();
  });
});

describe("pasting a column from a spreadsheet", () => {
  it("splits on lines and tabs, keeping blanks as gaps", () => {
    expect(splitPasted("3.25\n\n7.9\n")).toEqual(["3.25", "", "7.9"]);
    expect(splitPasted("1\t2\r\n3")).toEqual(["1", "2", "3"]);
  });
  it("ignores trailing blanks", () => {
    expect(splitPasted("5\n\n\n")).toEqual(["5"]);
    expect(splitPasted("")).toEqual([]);
  });
});
