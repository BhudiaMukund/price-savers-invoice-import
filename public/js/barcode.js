// Browser copy of src/barcode.ts (analysis) plus SVG bar drawing.
// test/barcode-parity.test.ts checks this file and the server agree.

export function cleanBarcode(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/^['"`’]+/, "").replace(/\D/g, "");
}

export function hasValidCheckDigit(digits) {
  if (![8, 12, 13, 14].includes(digits.length) || !/^\d+$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return (10 - (sum % 10)) % 10 === check;
}

export function analyzeBarcode(raw) {
  const digits = cleanBarcode(raw);
  if (!digits) return { status: "missing", key: null, digits: null, repaired: false };
  if (/\de[+-]?\d+\s*$/i.test(String(raw))) return { status: "invalid_format", key: null, digits, repaired: false };
  if ([8, 12, 13, 14].includes(digits.length)) {
    return hasValidCheckDigit(digits)
      ? { status: "valid", key: digits.padStart(14, "0"), digits, repaired: false }
      : { status: "invalid_check_digit", key: null, digits, repaired: false };
  }
  if (digits.length >= 9 && digits.length <= 11) {
    const padded = digits.padStart(12, "0");
    if (hasValidCheckDigit(padded)) return { status: "valid", key: padded.padStart(14, "0"), digits: padded, repaired: true };
  }
  return { status: "invalid_format", key: null, digits, repaired: false };
}

// ---- Drawing EAN-13 / UPC-A / EAN-8 bars -------------------------------------------------

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((c) => c.replace(/./g, (b) => (b === "0" ? "1" : "0")));
const G = R.map((c) => [...c].reverse().join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** Returns { modules: "1010...", guards: Set<index> } or null when the code can't be drawn. */
export function encode(digits) {
  if (!digits) return null;
  let d = digits;
  if (d.length === 14 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 12) d = "0" + d; // UPC-A is EAN-13 with a leading zero
  const guards = new Set();
  const mark = (s, from) => { for (let i = 0; i < s.length; i++) guards.add(from + i); };
  if (d.length === 13) {
    const parity = PARITY[Number(d[0])];
    let m = "101";
    for (let i = 1; i <= 6; i++) m += (parity[i - 1] === "L" ? L : G)[Number(d[i])];
    const mid = m.length;
    m += "01010";
    for (let i = 7; i <= 12; i++) m += R[Number(d[i])];
    const end = m.length;
    m += "101";
    mark("101", 0); mark("01010", mid); mark("101", end);
    return { modules: m, guards };
  }
  if (d.length === 8) {
    let m = "101";
    for (let i = 0; i < 4; i++) m += L[Number(d[i])];
    const mid = m.length;
    m += "01010";
    for (let i = 4; i < 8; i++) m += R[Number(d[i])];
    const end = m.length;
    m += "101";
    mark("101", 0); mark("01010", mid); mark("101", end);
    return { modules: m, guards };
  }
  return null;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Draw bars for a valid code. Returns an <svg> or null. */
export function barsSvg(digits) {
  const enc = encode(digits);
  if (!enc) return null;
  const { modules, guards } = enc;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${modules.length} 24`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("bars");
  let i = 0;
  while (i < modules.length) {
    if (modules[i] !== "1") { i++; continue; }
    let j = i;
    const guard = guards.has(i);
    while (j < modules.length && modules[j] === "1" && guards.has(j) === guard) j++;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(i));
    rect.setAttribute("y", "0");
    rect.setAttribute("width", String(j - i));
    rect.setAttribute("height", guard ? "24" : "20");
    svg.appendChild(rect);
    i = j;
  }
  return svg;
}
