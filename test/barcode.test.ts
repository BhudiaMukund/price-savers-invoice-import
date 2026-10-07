import { describe, expect, it } from "vitest";
import { analyzeBarcode, cleanBarcode, hasValidCheckDigit, storeMatchKeys } from "../src/barcode";

describe("cleanBarcode", () => {
  it("strips CSV leading apostrophes, spaces and hyphens", () => {
    expect(cleanBarcode("'9310720073156")).toBe("9310720073156");
    expect(cleanBarcode(" 931 0720-073156 ")).toBe("9310720073156");
    expect(cleanBarcode(null)).toBe("");
  });
});

describe("hasValidCheckDigit", () => {
  it("accepts known good codes", () => {
    expect(hasValidCheckDigit("4006381333931")).toBe(true); // EAN-13
    expect(hasValidCheckDigit("036000291452")).toBe(true); // UPC-A
    expect(hasValidCheckDigit("96385074")).toBe(true); // EAN-8
  });
  it("rejects a single wrong digit", () => {
    expect(hasValidCheckDigit("4006381333932")).toBe(false);
    expect(hasValidCheckDigit("036000291453")).toBe(false);
  });
});

describe("analyzeBarcode", () => {
  it("UPC-A and its EAN-13 zero-padded form share a matching key", () => {
    const a = analyzeBarcode("036000291452");
    const b = analyzeBarcode("0036000291452");
    expect(a.status).toBe("valid");
    expect(a.key).toBe(b.key);
  });
  it("reports missing, bad format and bad check digit separately", () => {
    expect(analyzeBarcode("").status).toBe("missing");
    expect(analyzeBarcode("12345").status).toBe("invalid_format");
    expect(analyzeBarcode("4006381333932").status).toBe("invalid_check_digit");
  });
});

describe("storeMatchKeys", () => {
  it("includes padded and raw forms so odd store codes still match", () => {
    expect(storeMatchKeys("'4006381333931")).toContain("04006381333931");
    expect(storeMatchKeys("123456")).toContain("123456");
    expect(storeMatchKeys("")).toEqual([]);
  });
});

describe("leading-zero repair", () => {
  it("restores a UPC-A that a spreadsheet stored as a number", () => {
    const r = analyzeBarcode("36000291452"); // 036000291452 minus its leading zero
    expect(r.status).toBe("valid");
    expect(r.repaired).toBe(true);
    expect(r.digits).toBe("036000291452");
  });
  it("does not 'repair' a short number whose check digit fails", () => {
    expect(analyzeBarcode("36000291453").status).toBe("invalid_format");
  });
});
