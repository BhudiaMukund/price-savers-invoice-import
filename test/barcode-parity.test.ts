import { describe, expect, it } from "vitest";
import { analyzeBarcode as server } from "../src/barcode";
// @ts-expect-error plain JS module served to the browser
import { analyzeBarcode as browser, encode } from "../public/js/barcode.js";

const samples = [
  "", null, "'9310720073156", "9310720073156", "4006381333932", "036000291452", "36000291452", "36000291453",
  "96385074", "12345", "9.31072E+12", " 931 0720-073156 ", "00036000291452", "123456789012345", "abc",
];

describe("browser and server barcode logic agree", () => {
  for (const s of samples) {
    it(JSON.stringify(s), () => {
      expect(browser(s)).toEqual(server(s));
    });
  }
});

describe("encode", () => {
  it("draws 95 modules for EAN-13 and UPC-A, 67 for EAN-8", () => {
    expect(encode("4006381333931").modules).toHaveLength(95);
    expect(encode("036000291452").modules).toHaveLength(95);
    expect(encode("96385074").modules).toHaveLength(67);
  });
  it("matches the known EAN-13 bit pattern for 4006381333931", () => {
    // Left half with parity LGLGLG... for leading 4 = LGLLGG
    expect(encode("4006381333931").modules.slice(0, 10)).toBe("1010001101");
  });
});
