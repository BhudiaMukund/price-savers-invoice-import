// Spreadsheet invoices (Excel, CSV, TSV) read by the page itself. The AI only says which column is which
// (from the first rows); every row is then read here, so barcodes and codes are copied exactly and long
// files have no line limit. Pure functions on grids of text, so the tests run them without a browser.

import { analyzeBarcode } from "./barcode.js";

/* ------------------------------------------------------------------ text files */

/** Bytes of a CSV/TSV/TXT file to text: UTF-8, UTF-16 (Excel's "Unicode text"), or Windows-1252. */
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  if (b[0] === 0xff && b[1] === 0xfe) text = new TextDecoder("utf-16le").decode(b);
  else if (b[0] === 0xfe && b[1] === 0xff) text = new TextDecoder("utf-16be").decode(b);
  else {
    text = new TextDecoder("utf-8").decode(b);
    // Not valid UTF-8: an older Windows export (curly quotes, pound sign, accents). Read it as Excel wrote it.
    if (text.includes("�")) text = windows1252(b);
  }
  return text.replace(/^﻿/, "");
}

// Windows-1252 differs from Latin-1 only in 0x80-0x9F (curly quotes, dashes, the euro sign...).
const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";
function windows1252(b) {
  let out = "";
  for (const byte of b) out += byte >= 0x80 && byte <= 0x9f ? CP1252[byte - 0x80] : String.fromCharCode(byte);
  return out;
}

// On a tie, a semicolon, tab or pipe wins over a comma ("2,50" is a price in a semicolon file).
const DELIMS = [";", "\t", "|", ","];

/** Split one line by a delimiter, respecting quotes (only used to pick the delimiter). */
function countFields(line, d) {
  let n = 1;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

/** Which character separates the columns: the one giving the same number (>1) of columns on most lines. */
export function detectDelimiter(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 40);
  let best = ",";
  let bestScore = 0;
  for (const d of DELIMS) {
    const counts = lines.map((l) => countFields(l, d));
    const freq = new Map();
    for (const c of counts) if (c > 1) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modeN = 0;
    let mode = 0;
    for (const [c, f] of freq) if (f > modeN || (f === modeN && c > mode)) (modeN = f), (mode = c);
    const multi = counts.filter((c) => c > 1).length;
    const score = modeN * 2 + multi + (mode > 1 ? Math.min(mode, 10) / 10 : 0);
    if (score > bestScore) (bestScore = score), (best = d);
  }
  return best;
}

/** CSV/TSV text to rows of cells (quotes, doubled quotes, line breaks inside quotes, any line ending). */
export function parseDelimited(text) {
  let src = text;
  let d = null;
  const sep = /^sep=(.)\r?\n/i.exec(src); // Excel's "sep=;" hint line
  if (sep) {
    d = sep[1];
    src = src.slice(sep[0].length);
  }
  d ??= detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === "") {
      q = true;
      cell = "";
    } else if (ch === d) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.replace(/\s+/g, " ").trim()));
}

/** Rows of cells, trimmed, with empty columns at the right dropped. */
export function tidyGrid(grid) {
  return grid.map((r) => {
    const out = r.map((v) => String(v ?? "").replace(/\s+/g, " ").trim());
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  });
}

/** A SheetJS workbook to sheets of text cells, row and column numbers as in the file (A1 = [0][0]). */
export function sheetsFromWorkbook(XLSX, wb) {
  const sheets = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws?.["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    // rawNumbers keeps barcodes like 9310720073156 intact instead of 9.31072E+12.
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, rawNumbers: true, defval: "", blankrows: true, range: { s: { r: 0, c: 0 }, e: range.e } });
    const tidy = tidyGrid(grid);
    if (tidy.some((r) => r.length)) sheets.push({ name, grid: tidy });
  }
  return sheets;
}

/* ------------------------------------------------------------------ cells */

export function colLetter(i) {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(letter) {
  if (!letter || !/^[A-Z]{1,3}$/.test(letter)) return -1;
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const NUM_E = /^\d+(?:\.\d+)?e[+-]?\d+$/i;

/**
 * A barcode cell as the supplier meant it: "'9310720073156" (Excel text marker), "9310 7200 7315 6",
 * "EAN: 9310720073156", "9310720073156.0", or two codes in one cell (the first valid one wins).
 * Scientific notation ("9.31E+12") is kept as written so it's flagged: the real digits are lost.
 */
export function cleanBarcodeCell(v) {
  let s = String(v ?? "").trim().replace(/^['"`’]+|['"`’]+$/g, "");
  if (!s) return "";
  if (NUM_E.test(s.replace(/\s/g, ""))) return s.replace(/\s/g, "");
  s = s.replace(/^(ean|apn|upc|gtin|barcode|bar code)\s*[:#-]?\s*/i, "");
  s = s.replace(/^(\d+)\.0+$/, "$1");
  const groups = s.split(/[\/,;|]|\s{2,}|\s+(?=\d{8})/).map((g) => g.replace(/[\s-]/g, "")).filter((g) => /^\d{6,14}$/.test(g));
  if (groups.length > 1) return groups.find((g) => analyzeBarcode(g).status === "valid") ?? groups[0];
  const joined = s.replace(/(\d)[\s-]+(?=\d)/g, "$1");
  return /\d/.test(joined) ? joined : "";
}

/** Codes are short and have no sentences ("All prices ex GST" isn't a code). */
export function cleanCodeCell(v) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim().replace(/^['"`’]+|['"`’]+$/g, "");
  if (!s || s.length > 40 || s.split(" ").length > 3) return "";
  return /^[A-Za-z0-9][A-Za-z0-9 ._\/#+-]*$/.test(s) ? s : "";
}

const hasLetters = (s) => /\p{L}/u.test(s);

/* ------------------------------------------------------------------ sample for the AI */

/** The first rows of each sheet, as "Row N: A=value | B=value", for the AI to work out the columns. */
export function buildInvoiceSample(sheets, maxRows = 40) {
  const parts = [];
  for (const sheet of sheets.slice(0, 5)) {
    const lines = [];
    for (let r = 0; r < sheet.grid.length && lines.length < maxRows; r++) {
      const cells = sheet.grid[r].map((v, c) => (v ? `${colLetter(c)}=${v.slice(0, 60)}` : null)).filter(Boolean);
      if (cells.length) lines.push(`Row ${r + 1}: ${cells.join(" | ")}`.slice(0, 700));
    }
    const filled = sheet.grid.filter((r) => r.some(Boolean)).length;
    parts.push(`## Sheet: ${sheet.name} (${filled} rows)\n${lines.join("\n")}`);
  }
  return parts.join("\n\n").slice(0, 70_000);
}

/* ------------------------------------------------------------------ working out the columns ourselves */

const HEAD = {
  barcode: /\b(bar\s*code|barcode|ean\s*13|ean|apn|upc|gtin)\b/i,
  notRetail: /\b(outer|carton|ctn|inner|case|shipper)\b/i,
  code: /\b((item|stock|product|part|article|style|cat|catalogue|supplier|prod)\s*(no|#|code|number|num|id)|code|sku|plu|item|ref|article)\b/i,
  title: /\b(description|desc|title|name|product|details|item\s*description)\b/i,
};

// Quantity columns. "Supplied" headings beat a bare "Qty"; ordered / back-ordered / price columns never count.
const QTY_SUPPLIED = /(ship|suppl|deliver|despatch|dispatch|invoic)/i;
const QTY_HEAD = /^(qty|quantity|qnty|pcs|pieces|(qty|quantity|units)\.?\s*(shipped|supplied|sent|delivered|invoiced|inv|sup|del)|(shipped|supplied|delivered|despatched|dispatched|invoiced)(\s*(qty|quantity|units?))?|inv\.?\s*(qty|quantity)|ctns?|cartons?|cases?|boxes)\.?$/i;
const QTY_NOT = /(order|\bord\b|back\s*-?\s*order|\bb\/?o\b|outstanding|\bo\/s\b|price|cost|total|value|amount|\bper\b|inner|outer|pack\s*size|pk\s*size|rrp|disc)/i;
const UNIT_HEAD = /^(uom|u\/m|unit(\s*of\s*(measure|issue))?|measure|sell\s*unit)$/i;
const PER_HEAD = /^(carton\s*(qty|quantity|size)|ctn\s*(qty|quantity|size)|(qty|quantity|units?)\s*(per|\/)\s*(ctn|carton|case|pack|pk|box|inner)|(inner|outer)\s*(qty|quantity|size)|pack\s*(size|qty|quantity)|case\s*(qty|quantity|size)|pk\s*(size|qty)|inner|outer)$/i;
const isQtyHeading = (t) => QTY_HEAD.test(t.trim()) && !QTY_NOT.test(t);

const BUNDLE_UNIT = /^(ctns?|cartons?|cases?|cs|box(es)?|bx|inners?|outers?|packs?|pks?|sets?|trays?|bags?|displays?|bundles?)\.?$/i;

/** Quantity, unit and units-per-carton columns found by their headings (letters, or null). */
function quantityColumnsByHeading(row, taken) {
  let qty = null;
  let qtyScore = 0;
  let unit = null;
  let per = null;
  row.forEach((cell, c) => {
    const t = (cell ?? "").trim();
    if (!t || t.length > 30 || taken.has(c)) return;
    if (UNIT_HEAD.test(t)) unit ??= c;
    else if (PER_HEAD.test(t)) per ??= c;
    else if (isQtyHeading(t)) {
      const score = QTY_SUPPLIED.test(t) ? 2 : 1;
      if (score > qtyScore) (qty = c), (qtyScore = score);
    }
  });
  return { quantity: qty === null ? null : colLetter(qty), unit: unit === null ? null : colLetter(unit), unitsPer: per === null ? null : colLetter(per) };
}

/** "12", "1,200", "12 EA", "3 CTN": the number and any unit words after it. */
export function parseQuantityCell(v) {
  const m = /^\s*(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]{1,10})?\.?\s*$/.exec(String(v ?? ""));
  if (!m) return null;
  return { quantity: Number(m[1].replace(/,/g, "")), unit: m[2] ?? "" };
}

/** Share of values passing a test (0 when there are none). */
const share = (vals, test) => (vals.length ? vals.filter(test).length / vals.length : 0);

/** The values in one column below the header, skipping empties. */
function columnValues(grid, start, c, limit = 400) {
  const out = [];
  for (let r = start; r < grid.length && out.length < limit; r++) {
    const v = grid[r]?.[c] ?? "";
    if (v) out.push(v);
  }
  return out;
}

const looksLikeBarcodeValue = (v) => {
  const s = cleanBarcodeCell(v);
  return NUM_E.test(s) || /^\d{8,14}$/.test(s);
};

/** Find the column that holds barcodes by its values: mostly 8-14 digits, many with a valid check digit. */
function barcodeColumnByValues(grid, start, exclude) {
  const width = Math.max(0, ...grid.slice(start, start + 400).map((r) => r.length));
  let best = -1;
  let bestHits = 0;
  for (let c = 0; c < width; c++) {
    if (exclude.has(c)) continue;
    const vals = columnValues(grid, start, c);
    const valid = vals.filter((v) => analyzeBarcode(cleanBarcodeCell(v)).status === "valid").length;
    if (valid >= 2 && share(vals, looksLikeBarcodeValue) >= 0.6 && valid > bestHits) (best = c), (bestHits = valid);
  }
  return best;
}

/** Headings rows: a row naming a description column and a barcode or code column. */
export function guessInvoiceMap(sheets) {
  let best = null;
  for (const sheet of sheets) {
    for (let r = 0; r < Math.min(sheet.grid.length, 60); r++) {
      const row = sheet.grid[r];
      const cols = { barcode: null, supplierCode: null, title: null, titleExtras: [], quantity: null, unit: null, unitsPer: null };
      let score = 0;
      row.forEach((cell, c) => {
        if (!cell || cell.length > 40) return;
        const L = colLetter(c);
        if (!cols.barcode && HEAD.barcode.test(cell) && !HEAD.notRetail.test(cell)) (cols.barcode = L), (score += 3);
        else if (!cols.title && HEAD.title.test(cell) && !HEAD.code.test(cell.replace(HEAD.title, ""))) (cols.title = L), (score += 2);
        else if (!cols.supplierCode && HEAD.code.test(cell) && !HEAD.barcode.test(cell)) (cols.supplierCode = L), (score += 2);
      });
      if (cols.title && score >= 4 && (!best || score > best.score)) {
        const taken = new Set([cols.title, cols.barcode, cols.supplierCode].filter(Boolean).map(colIndex));
        Object.assign(cols, quantityColumnsByHeading(row, taken));
        best = { score, map: { sheet: sheet.name, headerRow: r + 1, columns: cols } };
      }
    }
  }
  if (best) return best.map;
  // No headings: the column that's mostly barcodes, and the column with the most words as the title.
  for (const sheet of sheets) {
    const exclude = new Set();
    const bc = barcodeColumnByValues(sheet.grid, 0, exclude);
    if (bc >= 0) exclude.add(bc);
    const width = Math.max(0, ...sheet.grid.slice(0, 400).map((r) => r.length));
    let title = -1;
    let words = 0;
    for (let c = 0; c < width; c++) {
      if (exclude.has(c)) continue;
      const vals = columnValues(sheet.grid, 0, c);
      const w = vals.reduce((a, v) => a + (hasLetters(v) ? v.split(" ").length : 0), 0) / (vals.length || 1);
      if (share(vals, hasLetters) >= 0.6 && w > words) (title = c), (words = w);
    }
    if (title >= 0 && bc >= 0) {
      return { sheet: sheet.name, headerRow: null, columns: { barcode: colLetter(bc), supplierCode: null, title: colLetter(title), titleExtras: [], quantity: null, unit: null, unitsPer: null } };
    }
  }
  return null;
}

/**
 * Check a column layout (the AI's, or our own guess) against the data, fix what's clearly wrong, and say
 * whether it can be trusted. Returns { map, trusted, why }.
 */
export function checkInvoiceMap(sheets, proposed) {
  const guess = guessInvoiceMap(sheets);
  if (!proposed && !guess) return { map: null, trusted: false, why: "no columns found" };
  if (proposed?.layout === "other") return { map: null, trusted: false, why: "not laid out as a table" };
  const base = proposed?.columns?.title ? proposed : guess ?? proposed;
  const sheet = sheets.find((s) => s.name.trim().toLowerCase() === String(base.sheet ?? "").trim().toLowerCase()) ?? sheets.find((s) => s.name === guess?.sheet) ?? sheets[0];
  if (!sheet) return { map: null, trusted: false, why: "empty" };
  let headerRow = Number.isInteger(base.headerRow) && base.headerRow >= 1 && base.headerRow <= sheet.grid.length ? base.headerRow : null;
  // A "headings" row holding a valid barcode is a product: the headings are above it (or there are none).
  const bcCol = colIndex(base.columns.barcode);
  while (headerRow && bcCol >= 0 && analyzeBarcode(cleanBarcodeCell(sheet.grid[headerRow - 1]?.[bcCol])).status === "valid") {
    headerRow = headerRow > 1 ? headerRow - 1 : null;
  }
  // A row of column headings below the one given (the AI pointed at the supplier's details above it).
  {
    const [t, bc, cd] = [colIndex(base.columns.title), bcCol, colIndex(base.columns.supplierCode)];
    const at = sheet.grid.slice(0, 60).findIndex((row) => headingCount(row, t, bc, cd) >= 2);
    if (at >= 0 && (!headerRow || at + 1 > headerRow)) headerRow = at + 1;
  }
  let start = headerRow ?? 0;
  const width = Math.max(0, ...sheet.grid.slice(0, start + 400).map((r) => r.length));
  const idx = (L) => {
    const i = colIndex(L);
    return i >= 0 && i < width ? i : -1;
  };
  const cols = {
    title: idx(base.columns.title),
    barcode: idx(base.columns.barcode),
    supplierCode: idx(base.columns.supplierCode),
    titleExtras: (base.columns.titleExtras ?? []).map(idx).filter((i) => i >= 0),
  };
  const sameSheetGuess = guess && guess.sheet === sheet.name ? guess : null;
  // Title: a column of words.
  const titleOk = (c) => c >= 0 && share(columnValues(sheet.grid, start, c), hasLetters) >= 0.5;
  if (!titleOk(cols.title)) {
    const alt = sameSheetGuess ? colIndex(sameSheetGuess.columns.title) : -1;
    if (!titleOk(alt)) return { map: null, trusted: false, why: "no description column" };
    cols.title = alt;
    if (sameSheetGuess.headerRow) {
      headerRow = sameSheetGuess.headerRow;
      start = headerRow;
    }
  }
  // Barcode: mostly 8-14 digits. If not, look for the column that really holds them.
  if (cols.barcode >= 0 && (cols.barcode === cols.title || share(columnValues(sheet.grid, start, cols.barcode), looksLikeBarcodeValue) < 0.6)) cols.barcode = -1;
  if (cols.barcode < 0) cols.barcode = barcodeColumnByValues(sheet.grid, headerRow ?? 0, new Set([cols.title, ...cols.titleExtras]));
  // Code: short values without sentences.
  const codeOk = (c) => c >= 0 && c !== cols.title && c !== cols.barcode && share(columnValues(sheet.grid, start, c), (v) => !!cleanCodeCell(v)) >= 0.6;
  if (!codeOk(cols.supplierCode)) {
    const alt = sameSheetGuess ? colIndex(sameSheetGuess.columns.supplierCode) : -1;
    cols.supplierCode = codeOk(alt) ? alt : -1;
  }
  // Extra name parts: short text, never a number column.
  cols.titleExtras = [...new Set(cols.titleExtras)].filter((c) => {
    if ([cols.title, cols.barcode, cols.supplierCode].includes(c)) return false;
    const vals = columnValues(sheet.grid, start, c);
    return vals.length > 0 && share(vals, hasLetters) >= 0.6 && share(vals, (v) => v.length <= 40) >= 0.9;
  });
  // Quantity columns: the supplied quantity is a column of numbers; the unit is short text; units-per is numbers.
  const taken = new Set([cols.title, cols.barcode, cols.supplierCode, ...cols.titleExtras]);
  const headerCells = headerRow ? sheet.grid[headerRow - 1] ?? [] : [];
  const guessed = sameSheetGuess?.columns ?? {};
  // Totals rows ("Section total", "GST") put words in these columns too, so half the values being numbers is enough.
  const numeric = (c) => {
    if (c < 0 || taken.has(c)) return false;
    const vals = columnValues(sheet.grid, start, c);
    return vals.filter((v) => parseQuantityCell(v)).length >= 2 && share(vals, (v) => !!parseQuantityCell(v)) >= 0.5;
  };
  const orderedOnly = (c) => c >= 0 && /order|back/i.test(headerCells[c] ?? "") && !QTY_SUPPLIED.test(headerCells[c] ?? "");
  let qtyCol = idx(base.columns.quantity);
  if (!numeric(qtyCol) || orderedOnly(qtyCol)) {
    const alt = colIndex(guessed.quantity);
    qtyCol = numeric(alt) ? alt : -1;
  }
  if (qtyCol >= 0) taken.add(qtyCol);
  const shortText = (c) => c >= 0 && !taken.has(c) && share(columnValues(sheet.grid, start, c), (v) => /^[A-Za-z][A-Za-z/. ]{0,11}$/.test(v)) >= 0.5;
  let unitCol = idx(base.columns.unit);
  if (!shortText(unitCol)) unitCol = shortText(colIndex(guessed.unit)) ? colIndex(guessed.unit) : -1;
  if (unitCol >= 0) taken.add(unitCol);
  const perOk = (c) => c >= 0 && !taken.has(c) && share(columnValues(sheet.grid, start, c), (v) => /^\D{0,3}\d+$/.test(v.trim())) >= 0.5;
  let perCol = idx(base.columns.unitsPer);
  if (!perOk(perCol)) perCol = perOk(colIndex(guessed.unitsPer)) ? colIndex(guessed.unitsPer) : -1;
  const map = {
    sheet: sheet.name,
    headerRow,
    columns: {
      title: colLetter(cols.title),
      barcode: cols.barcode >= 0 ? colLetter(cols.barcode) : null,
      supplierCode: cols.supplierCode >= 0 ? colLetter(cols.supplierCode) : null,
      titleExtras: cols.titleExtras.map(colLetter),
      quantity: qtyCol >= 0 ? colLetter(qtyCol) : null,
      unit: unitCol >= 0 ? colLetter(unitCol) : null,
      unitsPer: perCol >= 0 ? colLetter(perCol) : null,
    },
  };
  const { items } = readInvoiceRows(sheets, map);
  if (!items.length) return { map, trusted: false, why: "no product lines" };
  // Most lines should have a title (a wrong layout gives lots of rows with numbers only).
  if (share(items, (i) => !!i.invoiceTitle) < 0.5) return { map, trusted: false, why: "most lines have no description" };
  return { map, trusted: true, why: "" };
}

/* ------------------------------------------------------------------ reading the rows */

// Lines that aren't products. Only applied to lines with no barcode and no item code, and the whole cell
// must be the label (so "Thank You Cards", "Balance Bike" or "Total Wipeout Game" stay products).
const TOTALS = new RegExp(
  "^\\s*(invoice\\s+|order\\s+)?(" +
    "sub\\s*-?\\s*total|section\\s+total|grand\\s+total|totals?|" +
    "total\\s+(ex|inc|excl|incl)\\.?(\\s+(gst|tax|vat))?|" +
    "total\\s+(qty|quantity|items|units|cartons|amount(\\s+(due|payable|owing))?|due|payable|value|cost|price)|" +
    "gst|tax|vat|discount|rebate|rounding|surcharge|deposit|balance(\\s+(due|owing))?|amount\\s+(due|paid|owing|payable)|" +
    "carried\\s+forward|brought\\s+forward|c\\/f|b\\/f|less\\b\\s*:?.*" +
    ")\\s*(\\(?\\s*(\\d+(\\.\\d+)?\\s*%|[a-z]{3}|inc\\.?\\s*gst|ex\\.?\\s*gst)\\s*\\)?)?\\s*[:.]?\\s*(\\(?\\$?\\s*-?[\\d.,]+\\)?)?\\s*$",
  "i",
);
const NOTE = /^\s*(thank\s+you\s+for\b|terms(\s+(and|&)\s+conditions|\s+of\s+(trade|payment|sale))?\s*[:.]|payment\s+(terms|details|due|method)\b|bank\s+(details|account)\b|bsb\b|account\s+(name|no|number)\b|page\s+\d+(\s+of\s+\d+)?\s*$|e\s*&\s*o\s*e\b)/i;
// Freight lines: the label, maybe with a place or a word like "charge" after it. A freight code (FRT) counts.
const FREIGHT = /^\s*(freight|delivery|shipping|postage|courier|handling|fuel\s+levy|carriage|cartage)(\s*(&|and)\s*(handling|delivery|insurance))?(\s+(charge|charges|fee|fees|cost|costs))?\s*([-–:,(].*)?$/i;
const FREIGHT_CODE = /^(frt|frgt|freight|del|deliv|ship|shp|post|cour|fuel|carr)\b/i;

const HEADING_TITLE = /^(item\s+|product\s+)?(description|desc\.?|title|name|product(\s+name)?|details)$/i;
const HEADING_BARCODE = /^(unit\s+|retail\s+)?(bar\s*code|ean(\s*13)?|apn|upc|gtin)(\s*(no\.?|number|code))?$/i;
const HEADING_CODE = /^((item|stock|product|part|article|supplier)\s*(no\.?|#|code|number)|code|sku|item|ref|plu)$/i;

function headingCount(row, ti, bi, ci) {
  let n = 0;
  if (ti >= 0 && HEADING_TITLE.test(row[ti] ?? "")) n++;
  if (bi >= 0 && HEADING_BARCODE.test(row[bi] ?? "")) n++;
  if (ci >= 0 && HEADING_CODE.test(row[ci] ?? "")) n++;
  return n;
}

/** A row of column headings (repeated mid-sheet, or read as data when the headings row was misjudged). */
function looksLikeHeadings(row, ti, bi, ci) {
  return headingCount(row, ti, bi, ci) >= 2 || (ti >= 0 && HEADING_TITLE.test(row[ti] ?? ""));
}

/** "Customer:", "Ship to:", "Date:": a row of details about the order, not a product. */
const LABEL = /^[A-Za-z][A-Za-z .#\/&-]{0,24}:$/;

/** Header row texts in the mapped columns, to spot the heading repeated on each printed page. */
function headerTexts(sheet, headerRow, idxs) {
  if (!headerRow) return null;
  const row = sheet.grid[headerRow - 1] ?? [];
  const t = idxs.map((i) => (i >= 0 ? (row[i] ?? "").toLowerCase() : "")).filter(Boolean);
  return t.length >= 1 ? t : null;
}

/** Other sheets with the same headings in the same columns (an invoice split over several sheets). */
function sameLayoutSheets(sheets, main, map, idxs) {
  const head = headerTexts(main, map.headerRow, idxs);
  if (!head || head.length < 2) return [];
  const out = [];
  for (const s of sheets) {
    if (s === main) continue;
    for (let r = 0; r < Math.min(s.grid.length, 60); r++) {
      const row = s.grid[r];
      const t = idxs.map((i) => (i >= 0 ? (row[i] ?? "").toLowerCase() : "")).filter(Boolean);
      if (t.length === head.length && t.every((v, k) => v === head[k])) {
        out.push({ sheet: s, headerRow: r + 1 });
        break;
      }
    }
  }
  return out;
}

/**
 * Every product line, using the chosen columns. Skips blank lines, headings, notes, totals, freight and
 * the column headings repeated on each printed page.
 * Returns { items: [{ ref, invoiceTitle, supplierCode, barcode }], skipped, sheets }.
 */
export function readInvoiceRows(sheets, map) {
  const items = [];
  const skipped = { blank: 0, headings: 0, totals: 0, notes: 0 };
  const main = map && sheets.find((s) => s.name === map.sheet);
  if (!main) return { items, skipped, sheets: [] };
  const ti = colIndex(map.columns.title);
  const bi = colIndex(map.columns.barcode);
  const ci = colIndex(map.columns.supplierCode);
  const xi = (map.columns.titleExtras ?? []).map(colIndex).filter((i) => i >= 0);
  const qi = colIndex(map.columns.quantity);
  const ui = colIndex(map.columns.unit);
  const pi = colIndex(map.columns.unitsPer);
  const idxs = [ti, bi, ci];
  const parts = [{ sheet: main, headerRow: map.headerRow }, ...sameLayoutSheets(sheets, main, map, idxs)];
  for (const { sheet, headerRow } of parts) {
    const head = headerTexts(sheet, headerRow, idxs);
    // A quantity column headed "Cartons" or "Ctns" counts cartons even with no unit column.
    const qHead = headerRow && qi >= 0 ? (sheet.grid[headerRow - 1]?.[qi] ?? "").trim() : "";
    const headUnit = /^(ctns?|cartons?|cases?|boxes|dozens?)\.?$/i.test(qHead) ? qHead : "";
    const quantityOf = (row) => {
      if (qi < 0) return {};
      const q = parseQuantityCell(row[qi]);
      const unit = (ui >= 0 ? (row[ui] ?? "").trim() : "") || q?.unit || headUnit;
      const per = pi >= 0 ? /(\d+)\s*$/.exec((row[pi] ?? "").trim())?.[1] : null;
      // A pack-size column only matters when the quantity counts cartons or packs. "Qty 12 EA" with "Inner 6" is 12.
      return { quantity: q ? q.quantity : null, unit, unitsPer: per && Number(per) >= 1 && BUNDLE_UNIT.test(unit) ? Number(per) : null };
    };
    // No headings row: the list starts at the first line with a barcode or an item code (the supplier's
    // name, dates and delivery notes above it aren't products).
    let first = headerRow ?? 0;
    if (!headerRow) {
      const at = sheet.grid.findIndex(
        (row) =>
          (bi >= 0 && /\d{8,14}|\de\+/i.test(cleanBarcodeCell(row[bi]))) ||
          (ci >= 0 && /\d/.test(cleanCodeCell(row[ci]))) ||
          (hasLetters(row[ti] ?? "") && row.some((v) => /^\$?\d+(\.\d+)?$/.test(v))), // a description and a plain number (qty, price)
      );
      first = at < 0 ? 0 : at;
      skipped.notes += sheet.grid.slice(0, first).filter((r) => r.some(Boolean)).length;
    }
    for (let r = first; r < sheet.grid.length; r++) {
      const row = sheet.grid[r];
      const filled = row.filter(Boolean).length;
      if (!filled) {
        skipped.blank++;
        continue;
      }
      if (head) {
        const t = idxs.map((i) => (i >= 0 ? (row[i] ?? "").toLowerCase() : "")).filter(Boolean);
        if (t.length === head.length && t.every((v, k) => v === head[k])) {
          skipped.headings++;
          continue;
        }
      }
      if (looksLikeHeadings(row, ti, bi, ci)) {
        skipped.headings++;
        continue;
      }
      const cell = row[ti] ?? "";
      let title = hasLetters(cell) ? cell : "";
      for (const x of xi) {
        const extra = row[x] ?? "";
        if (extra && hasLetters(extra) && !title.toLowerCase().includes(extra.toLowerCase())) title = title ? `${title} ${extra}` : "";
      }
      const barcode = bi >= 0 ? cleanBarcodeCell(row[bi]) : "";
      const code = ci >= 0 ? cleanCodeCell(row[ci]) : "";
      const bc = analyzeBarcode(barcode);
      const validBarcode = bc.status === "valid";
      const barcodeLike = validBarcode || /^\d{8,14}$/.test(barcode) || NUM_E.test(barcode);
      if (!title) {
        // No description: only a product if it has a barcode (staff then give it a title).
        if (barcodeLike) items.push({ ref: `${sheet.name}!${r + 1}`, invoiceTitle: "", supplierCode: code || null, barcode, ...quantityOf(row) });
        else skipped.notes++;
        continue;
      }
      if (!validBarcode && row.some((v) => LABEL.test(v))) {
        skipped.notes++;
        continue;
      }
      if (!validBarcode && !code && filled <= 1) {
        skipped.headings++; // "--- HALLOWEEN ---", "All prices ex GST"
        continue;
      }
      if (!validBarcode && !code && (TOTALS.test(title) || NOTE.test(title))) {
        skipped.totals++;
        continue;
      }
      if (!validBarcode && (!code || FREIGHT_CODE.test(code)) && FREIGHT.test(title) && title.split(" ").length <= 6) {
        skipped.totals++;
        continue;
      }
      items.push({ ref: `${sheet.name}!${r + 1}`, invoiceTitle: title.slice(0, 255), supplierCode: code || null, barcode: barcode || null, ...quantityOf(row) });
    }
  }
  return { items, skipped, sheets: parts.map((p) => p.sheet.name) };
}

/* ------------------------------------------------------------------ invoice details without the AI */

const NUMBER_LABEL = /^(tax\s+)?(invoice|inv|order|sales\s+order|purchase\s+order|po|so|document|doc|reference|ref)\s*(no\.?|number|num|#)?\s*[:#.]?\s*$/i;
const NUMBER_INLINE = /\b(?:invoice|inv|order|po|so)\s*(?:no\.?|number|num|#)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\/-]{2,30})\b/i;

/** "Order No:" | "SO-48290" near the top of the first sheet. */
export function findInvoiceNumber(sheets) {
  const grid = sheets[0]?.grid ?? [];
  for (let r = 0; r < Math.min(grid.length, 25); r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (!v) continue;
      if (NUMBER_LABEL.test(v)) {
        const next = row.slice(c + 1).find(Boolean);
        if (next && /\d/.test(next) && next.length <= 30) return next;
      }
      const m = NUMBER_INLINE.exec(v);
      if (m && /\d/.test(m[1])) return m[1];
    }
  }
  return null;
}

/** The first few rows as plain text, to find the supplier's name among the known suppliers. */
export function topText(sheets, rows = 6) {
  return (sheets[0]?.grid ?? [])
    .slice(0, rows)
    .map((r) => r.filter(Boolean).join(" "))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ text for the AI (layouts that aren't tables) */

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Rows at the top before the first line that looks like a product (words, and a plain number such as a
 * quantity or price): supplier, invoice number, column headings. */
function preambleOf(rows, max = 20) {
  const at = rows.findIndex((r) => r.filter(Boolean).length >= 3 && r.some((v) => /^\$?\d+(\.\d+)?$/.test(v)) && r.some((v) => hasLetters(v)));
  return at < 0 ? 0 : Math.min(at, max);
}

/**
 * A layout the page can't read by columns, cut into parts of about `lines` rows for the AI.
 * Returns pieces { sheet, head, body, first }: head is the top rows (supplier, invoice number, headings),
 * repeated on later parts so the AI understands each part on its own. partText() turns a piece into text.
 */
export function textParts(sheets, lines = 120) {
  const pieces = [];
  for (const sheet of sheets) {
    const rows = sheet.grid.filter((r) => r.some(Boolean));
    if (!rows.length) continue;
    const csv = rows.map((r) => r.map(csvCell).join(","));
    const pre = preambleOf(rows);
    const head = csv.slice(0, pre);
    const body = csv.slice(pre);
    if (!body.length) {
      pieces.push({ sheet: sheet.name, head, body: [], first: true });
      continue;
    }
    for (let i = 0; i < body.length; i += lines) pieces.push({ sheet: sheet.name, head, body: body.slice(i, i + lines), first: i === 0 });
  }
  return pieces;
}

/** Halve a piece that was still too long for one AI reply (null when it can't be split further). */
export function splitPiece(piece) {
  if (piece.body.length < 6) return null;
  const mid = Math.ceil(piece.body.length / 2);
  return [
    { ...piece, body: piece.body.slice(0, mid) },
    { ...piece, body: piece.body.slice(mid), first: false },
  ];
}

/** The text and the note sent to the AI for piece k of n. */
export function partText(piece, k, n) {
  if (piece.first) {
    return {
      text: `## Sheet: ${piece.sheet}\n${[...piece.head, ...piece.body].join("\n")}`,
      part: n > 1 ? `This is part ${k + 1} of ${n} of a long spreadsheet.` : "",
    };
  }
  return {
    text: `## Sheet: ${piece.sheet}\n${piece.head.join("\n")}\n--- this part starts here ---\n${piece.body.join("\n")}`,
    part:
      `This is part ${k + 1} of ${n} of a long spreadsheet. The rows above "--- this part starts here ---" are only ` +
      "repeated so you know the supplier and the columns: they were read already, so don't return products from them.",
  };
}
