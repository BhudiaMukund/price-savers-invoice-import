/**
 * Barcode helpers. The key idea: compare barcodes as GTIN-14 (left-padded with zeros),
 * so UPC-A (12), EAN-13 (13), EAN-8 (8) and GTIN-14 forms of the same code all match.
 *
 * Keep public/js/barcode.js in step with this file (test/barcode-parity.test.ts checks they agree).
 */

export type BarcodeStatus = "valid" | "missing" | "invalid_check_digit" | "invalid_format";

export interface BarcodeResult {
  status: BarcodeStatus;
  /** GTIN-14 key used for matching; null unless status is "valid". */
  key: string | null;
  /** Cleaned digits (zero-padded if repaired); null when missing. */
  digits: string | null;
  /** True when leading zeros were restored (Excel often drops them). */
  repaired: boolean;
}

/** Strip whitespace, Excel/CSV leading apostrophes, hyphens and anything non-digit. */
export function cleanBarcode(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/^['"`’]+/, "").replace(/\D/g, "");
}

/** GS1 mod-10 check digit validation for GTIN-8/12/13/14. */
export function hasValidCheckDigit(digits: string): boolean {
  if (![8, 12, 13, 14].includes(digits.length) || !/^\d+$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  let sum = 0;
  // Weights alternate 3,1,3,1... starting from the digit next to the check digit.
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += Number(body[i]) * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}

export function toGtin14(digits: string): string {
  return digits.padStart(14, "0");
}

export function analyzeBarcode(raw: string | null | undefined): BarcodeResult {
  const digits = cleanBarcode(raw);
  if (!digits) return { status: "missing", key: null, digits: null, repaired: false };
  // "9.31072E+12": a spreadsheet turned the barcode into scientific notation and lost digits.
  if (/\de[+-]?\d+\s*$/i.test(String(raw))) return { status: "invalid_format", key: null, digits, repaired: false };

  if ([8, 12, 13, 14].includes(digits.length)) {
    return hasValidCheckDigit(digits)
      ? { status: "valid", key: toGtin14(digits), digits, repaired: false }
      : { status: "invalid_check_digit", key: null, digits, repaired: false };
  }

  // 9-11 digits: most likely a UPC-A/EAN-13 that lost its leading zeros in a spreadsheet.
  if (digits.length >= 9 && digits.length <= 11) {
    const padded = digits.padStart(12, "0");
    if (hasValidCheckDigit(padded)) {
      return { status: "valid", key: toGtin14(padded), digits: padded, repaired: true };
    }
  }
  return { status: "invalid_format", key: null, digits, repaired: false };
}

/**
 * Matching keys for *store* barcodes. Store data can contain odd values (internal codes,
 * short codes, bad check digits). Those should still match if an invoice repeats them
 * verbatim, so include the raw digits as well as the GTIN-14 form.
 */
export function storeMatchKeys(raw: string | null | undefined): string[] {
  const digits = cleanBarcode(raw);
  if (!digits) return [];
  const keys = new Set<string>([digits]);
  const a = analyzeBarcode(digits);
  keys.add(a.key ?? toGtin14(digits));
  return [...keys];
}

/** The spellings a store might hold for a valid code (for Shopify search queries). */
export function searchForms(raw: string | null | undefined): string[] {
  const a = analyzeBarcode(raw);
  const forms = new Set<string>();
  const base = a.digits ?? cleanBarcode(raw);
  if (!base) return [];
  forms.add(base);
  if (a.key) {
    const stripped = a.key.replace(/^0+/, "");
    for (const len of [8, 12, 13, 14]) {
      if (stripped.length <= len) forms.add(stripped.padStart(len, "0"));
    }
  }
  return [...forms];
}
