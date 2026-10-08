// Reads a supplier catalogue in the browser: Excel (with pictures floating over the sheet or placed in
// cells), CSV, a ZIP (of a spreadsheet and/or photos), or photo files named by code or barcode.
// Pure functions, no DOM: the page passes in SheetJS and an unzip function, and the tests do the same.

import { analyzeBarcode } from "./barcode.js";

export const PHOTO_EXT = /\.(jpe?g|png|gif|webp)$/i;
const OTHER_PICTURE_EXT = /\.(emf|wmf|tiff?|bmp|svg|heic|heif)$/i;
const SHEET_EXT = /\.(xlsx|xlsm|xls|ods|csv|tsv|txt)$/i;
const ZIP_EXT = /\.zip$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

let nextId = 0;
const photoOf = (name, bytes, ext) => ({ id: `p${++nextId}`, name, bytes, type: MIME[ext.toLowerCase()] });
const extOf = (name) => (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
const baseName = (p) => p.split("/").pop();

/* ------------------------------------------------------------------ tiny XML helpers (Excel's XML is regular) */

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}
/** Attribute by local name, whatever namespace prefix the file uses (r:id, r:embed...). */
function attr(a, local) {
  for (const [k, v] of Object.entries(a)) if (k === local || k.endsWith(`:${local}`)) return v;
  return undefined;
}
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const text = (bytes) => (bytes ? new TextDecoder().decode(bytes) : "");

/** Resolve a relationship target against the folder of the part that owns it. */
function resolvePath(ownerPart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = ownerPart.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
function relsPathFor(part) {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}
function readRels(zip, part) {
  const map = new Map();
  for (const m of text(zip[relsPathFor(part)]).matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.TargetMode === "External") continue;
    map.set(a.Id, { target: resolvePath(part, decode(a.Target)), type: a.Type ?? "" });
  }
  return map;
}

/** "E7" -> { row: 6, col: 4 } (zero-based). */
export function cellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}
export function colLetter(col) {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/* ------------------------------------------------------------------ pictures inside an .xlsx */

/**
 * Every picture in the workbook, with the sheet and cell it belongs to.
 * Returns { bySheet: { [sheetName]: [{ row, col, rows: [row numbers it covers, most first], photo }] }, unsupported }.
 */
export function xlsxPictures(zip) {
  const bySheet = {};
  let unsupported = 0;
  const mediaCache = new Map();
  const media = (path) => {
    if (!mediaCache.has(path)) {
      const bytes = zip[path];
      const ext = extOf(path);
      if (!bytes) mediaCache.set(path, null);
      else if (!MIME[ext]) {
        unsupported++;
        mediaCache.set(path, null);
      } else mediaCache.set(path, photoOf(baseName(path), bytes, ext));
    }
    return mediaCache.get(path);
  };

  const wbPart = "xl/workbook.xml";
  const wbRels = readRels(zip, wbPart);
  const sheets = [...text(zip[wbPart]).matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const a = attrs(m[0]);
    return { name: decode(a.name ?? ""), part: wbRels.get(attr(a, "id"))?.target };
  });

  // In-cell pictures (Excel 365 "Place in cell"): cell vm -> metadata -> rich value -> relationship -> media.
  const richImages = richValueImages(zip);

  for (const sh of sheets) {
    if (!sh.part || !zip[sh.part]) continue;
    const list = [];
    const rels = readRels(zip, sh.part);
    const sheetXml = text(zip[sh.part]);
    const heightOf = rowHeights(sheetXml);
    for (const rel of rels.values()) {
      if (!/\/drawing$/.test(rel.type)) continue;
      const drawingRels = readRels(zip, rel.target);
      const xml = text(zip[rel.target]);
      for (const m of xml.matchAll(/<(\w+:)?(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/\1\2>/g)) {
        const block = m[0];
        const pos = (which) => {
          const b = new RegExp(`<(\\w+:)?${which}>([\\s\\S]*?)</(\\w+:)?${which}>`).exec(block)?.[2];
          if (!b) return null;
          const num = (tag) => Number(new RegExp(`<(\\w+:)?${tag}>(-?\\d+)</`).exec(b)?.[2] ?? NaN);
          return { col: num("col"), row: num("row"), rowOff: num("rowOff") || 0 };
        };
        const from = pos("from");
        if (!from || Number.isNaN(from.row)) continue; // absoluteAnchor: not tied to a cell
        let to = pos("to");
        if (!to) {
          // oneCellAnchor: work out the bottom from the picture's height.
          const cy = Number(/<(\w+:)?ext\b[^>]*\bcy="(\d+)"/.exec(block)?.[2] ?? 0);
          let row = from.row;
          let left = cy + from.rowOff;
          while (left > heightOf(row) && row < from.row + 50) left -= heightOf(row++);
          to = { row, rowOff: left };
        }
        const rows = coverage(from, to, heightOf);
        for (const em of block.matchAll(/<(\w+:)?blip\b[^>]*>/g)) {
          const id = attr(attrs(em[0]), "embed");
          const target = id && drawingRels.get(id)?.target;
          const photo = target ? media(target) : null;
          if (photo) list.push({ row: from.row, col: from.col, rows, photo });
        }
      }
    }
    if (richImages.size) {
      for (const m of text(zip[sh.part]).matchAll(/<c\b[^>]*\bvm="(\d+)"[^>]*>/g)) {
        const a = attrs(m[0]);
        const at = cellRef(a.r ?? "");
        const target = richImages.get(Number(m[1]));
        const photo = target ? media(target) : null;
        if (at && photo) list.push({ row: at.row, col: at.col, rows: [at.row], photo });
      }
    }
    list.sort((a, b) => a.row - b.row || a.col - b.col);
    if (list.length) bySheet[sh.name] = list;
  }
  return { bySheet, unsupported };
}

const EMU_PER_POINT = 12700;

/** Row heights in EMU (Excel's drawing unit), from the sheet's own row settings. */
function rowHeights(sheetXml) {
  const def = Number(/<sheetFormatPr\b[^>]*\bdefaultRowHeight="([\d.]+)"/.exec(sheetXml)?.[1] ?? 15) * EMU_PER_POINT;
  const custom = new Map();
  for (const m of sheetXml.matchAll(/<row\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.ht && a.r) custom.set(Number(a.r) - 1, Number(a.ht) * EMU_PER_POINT);
  }
  return (row) => custom.get(row) ?? def;
}

/** Rows a picture covers, the row holding most of it first. */
function coverage(from, to, heightOf) {
  if (to.row <= from.row) return [from.row];
  const parts = [];
  for (let r = from.row; r <= to.row && r < from.row + 50; r++) {
    const h = heightOf(r);
    const top = r === from.row ? Math.min(from.rowOff, h) : 0;
    const bottom = r === to.row ? Math.min(to.rowOff, h) : h;
    parts.push({ r, size: Math.max(0, bottom - top) });
  }
  return parts.sort((a, b) => b.size - a.size || a.r - b.r).map((p) => p.r);
}

/** Map of cell "vm" index (1-based) -> media path, for pictures placed in cells. */
function richValueImages(zip) {
  const out = new Map();
  const meta = text(zip["xl/metadata.xml"]);
  const rv = text(zip["xl/richData/rdrichvalue.xml"]);
  const relPart = "xl/richData/richValueRel.xml";
  if (!meta || !rv || !zip[relPart]) return out;

  // Which key of each rich value structure holds the picture's relationship index.
  const structs = [...text(zip["xl/richData/rdrichvaluestructure.xml"]).matchAll(/<s\b[^>]*>([\s\S]*?)<\/s>/g)].map((m) =>
    [...m[1].matchAll(/<k\b[^>]*>/g)].findIndex((k) => /LocalImageIdentifier/.test(attrs(k[0]).n ?? "")),
  );
  const values = [...rv.matchAll(/<rv\b([^>]*)>([\s\S]*?)<\/rv>/g)].map((m) => {
    const s = Number(attrs(`<x ${m[1]}>`).s ?? 0);
    const vs = [...m[2].matchAll(/<v\b[^>]*>([^<]*)<\/v>/g)].map((v) => v[1]);
    const k = structs[s] ?? 0;
    return Number(vs[k >= 0 ? k : 0]);
  });
  const relIds = [...text(zip[relPart]).matchAll(/<rel\b[^>]*>/g)].map((m) => attr(attrs(m[0]), "id"));
  const rels = readRels(zip, relPart);

  // valueMetadata blocks point at futureMetadata blocks, which hold the rich value index.
  const future = /<futureMetadata\b[^>]*name="XLRICHVALUE"[^>]*>([\s\S]*?)<\/futureMetadata>/.exec(meta)?.[1] ?? "";
  const rvIndex = [...future.matchAll(/<bk>([\s\S]*?)<\/bk>/g)].map((b) => Number(/<(\w+:)?rvb\b[^>]*\bi="(\d+)"/.exec(b[1])?.[2] ?? NaN));
  const valueMeta = /<valueMetadata\b[^>]*>([\s\S]*?)<\/valueMetadata>/.exec(meta)?.[1] ?? "";
  [...valueMeta.matchAll(/<bk>([\s\S]*?)<\/bk>/g)].forEach((b, i) => {
    const v = Number(/<rc\b[^>]*\bv="(\d+)"/.exec(b[1])?.[1] ?? NaN);
    const relIndex = values[rvIndex[v]];
    const target = rels.get(relIds[relIndex])?.target;
    if (target) out.set(i + 1, target);
  });
  return out;
}

/* ------------------------------------------------------------------ reading the files */

/**
 * Read everything picked. Returns
 * { sheets: [{ name, grid: string[][], links: Map("r:c" -> url) }], pictures: { [sheet]: [...] },
 *   loose: [photo], unsupported, fileNames, problems: [string] }
 */
export async function readCatalogueFiles(files, { XLSX, unzip, zip }) {
  const out = { sheets: [], pictures: {}, loose: [], unsupported: 0, fileNames: [], problems: [] };
  const entries = []; // { name, bytes }
  for (const f of files) {
    out.fileNames.push(f.name);
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (ZIP_EXT.test(f.name)) {
      let zip;
      try {
        zip = unzip(bytes);
      } catch {
        out.problems.push(`${f.name} couldn't be opened as a ZIP file.`);
        continue;
      }
      for (const [name, data] of Object.entries(zip)) {
        if (name.endsWith("/") || name.startsWith("__MACOSX/") || baseName(name).startsWith(".")) continue;
        entries.push({ name, bytes: data });
      }
    } else entries.push({ name: f.name, bytes });
  }

  let sheetFile = null;
  for (const e of entries) {
    if (SHEET_EXT.test(e.name)) {
      if (sheetFile) {
        out.problems.push(`Only one spreadsheet is read at a time, so ${baseName(e.name)} was left out.`);
        continue;
      }
      sheetFile = e;
    } else if (PHOTO_EXT.test(e.name)) out.loose.push(photoOf(baseName(e.name), e.bytes, extOf(e.name)));
    else if (OTHER_PICTURE_EXT.test(e.name)) out.unsupported++;
  }

  if (sheetFile) {
    // .xlsx is a ZIP. Open it once: the pictures come from here, and the Excel reader gets a copy without
    // them (it would otherwise unpack every photo just to read the text, which is slow on big catalogues).
    let parts = null;
    if (/\.(xlsx|xlsm)$/i.test(sheetFile.name)) {
      try {
        parts = unzip(sheetFile.bytes);
      } catch {
        parts = null;
      }
    }
    let wb;
    try {
      if (/\.(csv|tsv|txt)$/i.test(sheetFile.name)) {
        wb = XLSX.read(new TextDecoder().decode(sheetFile.bytes), { type: "string", raw: true });
      } else if (parts && zip) {
        const slim = {};
        for (const [name, data] of Object.entries(parts)) if (!/^xl\/(media|embeddings|printerSettings)\//.test(name)) slim[name] = data;
        wb = XLSX.read(zip(slim, { level: 0 }), { type: "array", cellDates: true });
        sheetFile.bytes = null; // the unpacked parts are all that's needed now: let the browser free the file
      } else {
        wb = XLSX.read(sheetFile.bytes, { type: "array", cellDates: true });
      }
    } catch {
      out.problems.push(`${baseName(sheetFile.name)} couldn't be opened. Save it again from Excel and retry.`);
      wb = null;
    }
    if (wb) {
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (!ws?.["!ref"]) continue;
        const range = XLSX.utils.decode_range(ws["!ref"]);
        // Start at A1 so row/column numbers match the sheet (and the picture anchors).
        const grid = XLSX.utils.sheet_to_json(ws, {
          header: 1,
          raw: false,
          rawNumbers: true,
          defval: "",
          blankrows: true,
          range: { s: { r: 0, c: 0 }, e: range.e },
        });
        const links = new Map();
        for (const [addr, cell] of Object.entries(ws)) {
          if (addr[0] === "!" || !cell?.l?.Target) continue;
          const at = cellRef(addr);
          if (at && /^https?:/i.test(cell.l.Target)) links.set(`${at.row}:${at.col}`, cell.l.Target);
        }
        if (grid.some((r) => r.some((v) => String(v).trim()))) out.sheets.push({ name, grid: grid.map((r) => r.map((v) => String(v ?? "").trim())), links });
      }
      if (parts) {
        try {
          const pics = xlsxPictures(parts);
          out.pictures = pics.bySheet;
          out.unsupported += pics.unsupported;
        } catch {
          out.problems.push("The pictures inside the spreadsheet couldn't be read.");
        }
      } else if (/\.(xlsx|xlsm)$/i.test(sheetFile.name)) {
        out.problems.push("The pictures inside the spreadsheet couldn't be read.");
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ working out the columns */

const HEAD = {
  barcode: /\b(bar\s*code|barcode|ean|apn|upc|gtin|ean13)\b/i,
  supplierCode: /\b(item\s*(no|#|code|number)|stock\s*(no|code)|product\s*(code|no)|part\s*(no|number)|code|sku|article|style\s*no)\b/i,
  title: /\b(description|desc|title|name|product)\b/i,
  description: /\b(long\s*description|full\s*description|details|features|notes?)\b/i,
  photoLinks: /\b(image|photo|picture|pic|img|url|link)s?\b/i,
};

/** A best guess from the headings, used when the AI can't be reached, and as the starting point. */
export function guessMap(read) {
  let best = null;
  for (const sheet of read.sheets) {
    for (let r = 0; r < Math.min(sheet.grid.length, 40); r++) {
      const row = sheet.grid[r];
      const cols = { barcode: null, supplierCode: null, title: null, description: null, photoLinks: [] };
      let score = 0;
      row.forEach((cell, c) => {
        if (!cell || cell.length > 40) return;
        const L = colLetter(c);
        if (!cols.barcode && HEAD.barcode.test(cell) && !/\b(outer|carton|ctn|inner)\b/i.test(cell)) (cols.barcode = L), score += 3;
        else if (!cols.description && HEAD.description.test(cell)) (cols.description = L), score++;
        else if (!cols.supplierCode && HEAD.supplierCode.test(cell) && !HEAD.barcode.test(cell)) (cols.supplierCode = L), score += 2;
        else if (!cols.title && HEAD.title.test(cell)) (cols.title = L), score += 2;
        else if (HEAD.photoLinks.test(cell)) cols.photoLinks.push(L), score++;
      });
      if (score >= 3 && (!best || score > best.score)) best = { score, map: { sheet: sheet.name, headerRow: r + 1, columns: cols } };
    }
  }
  if (best) return best.map;
  // No headings: the column that's mostly barcodes, and the longest text column as the title.
  const sheet = read.sheets[0];
  if (!sheet) return null;
  const width = Math.max(...sheet.grid.map((r) => r.length));
  let bc = null;
  let title = null;
  let bcHits = 0;
  let titleLen = 0;
  for (let c = 0; c < width; c++) {
    const vals = sheet.grid.slice(0, 200).map((r) => r[c] ?? "").filter(Boolean);
    const hits = vals.filter((v) => analyzeBarcode(v).status === "valid" && /^\d[\d\s]*$/.test(v)).length;
    const avg = vals.reduce((a, v) => a + (/^[\d.\s$]+$/.test(v) ? 0 : v.length), 0) / (vals.length || 1);
    if (hits > bcHits) (bc = c), (bcHits = hits);
    if (avg > titleLen) (title = c), (titleLen = avg);
  }
  return {
    sheet: sheet.name,
    headerRow: null,
    columns: { barcode: bc === null ? null : colLetter(bc), supplierCode: null, title: title === null ? null : colLetter(title), description: null, photoLinks: [] },
  };
}

/** The first rows of each sheet, as text for the AI to work out the layout. */
export function buildSample(read, maxRows = 30) {
  const parts = [];
  for (const sheet of read.sheets.slice(0, 4)) {
    const lines = [];
    for (let r = 0; r < sheet.grid.length && lines.length < maxRows; r++) {
      const cells = sheet.grid[r]
        .map((v, c) => {
          const link = sheet.links.get(`${r}:${c}`);
          const val = v || (link ? link : "");
          return val ? `${colLetter(c)}=${val.replace(/\s+/g, " ").slice(0, 60)}` : null;
        })
        .filter(Boolean);
      if (cells.length) lines.push(`Row ${r + 1}: ${cells.join(" | ")}`);
    }
    const pics = read.pictures[sheet.name]?.length;
    parts.push(`## Sheet: ${sheet.name}${pics ? ` (${pics} pictures placed on rows)` : ""}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/* ------------------------------------------------------------------ products */

/** Notes and totals land in the code column too ("All prices ex GST. E&OE."): codes are short, without sentences. */
const looksLikeCode = (v) => /^[A-Za-z0-9][A-Za-z0-9 ._\/#-]{0,29}$/.test(v) && v.split(/\s+/).length <= 3;

const ASSORTED = /\b(asst|assorted|assortment|mixed|various|colours|colors|styles|designs)\b/i;
const keyOf = (barcode, code) => {
  const bk = analyzeBarcode(barcode).key;
  if (bk) return `b:${bk}`;
  const ck = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return ck ? `c:${ck}` : null;
};

/**
 * Turn the rows into products using the chosen columns. Rows for the same barcode or code are merged
 * (some exports have one row per photo). Pictures are joined to the row they sit on; loose photo files
 * are joined by name.
 * Returns { items, stats: { rows, skipped, photos, placed, unplaced, links, unsupported } }.
 */
export function buildItems(read, map) {
  const byKey = new Map();
  const items = [];
  const stats = { rows: 0, skipped: 0, photos: 0, unplaced: 0, links: 0, unsupported: read.unsupported };
  const sheet = map && read.sheets.find((s) => s.name === map.sheet);
  const colIdx = (L) => (L ? cellRef(`${L}1`).col : -1);

  const itemFor = (barcode, code) => {
    const key = keyOf(barcode, code);
    if (!key) return null;
    let it = byKey.get(key);
    if (!it) {
      const bc = analyzeBarcode(barcode);
      // A barcode that doesn't add up (or was scrambled by a spreadsheet) isn't kept: the code is used instead.
      it = { key, barcode: bc.key ? bc.digits : null, badBarcode: bc.status === "invalid_check_digit" || bc.status === "invalid_format" ? barcode : null, code: code || null, title: "", description: "", photos: [], links: [], mixed: false, rows: [] };
      byKey.set(key, it);
      items.push(it);
    }
    return it;
  };

  const rowItem = new Map(); // sheet row -> item
  if (sheet) {
    const c = map.columns;
    const [bi, ci, ti, di] = [colIdx(c.barcode), colIdx(c.supplierCode), colIdx(c.title), colIdx(c.description)];
    const li = (c.photoLinks ?? []).map(colIdx);
    const start = map.headerRow ?? 0; // headerRow is 1-based, so this is the first row after it
    for (let r = start; r < sheet.grid.length; r++) {
      const row = sheet.grid[r];
      if (!row.some(Boolean)) continue;
      stats.rows++;
      const barcode = bi >= 0 ? row[bi] ?? "" : "";
      const code = ci >= 0 && looksLikeCode(row[ci] ?? "") ? row[ci] : "";
      const it = itemFor(barcode && /\d/.test(barcode) ? barcode : "", code);
      if (!it) {
        stats.skipped++; // headings inside the list, totals, notes
        continue;
      }
      it.rows.push(r + 1);
      rowItem.set(r, it);
      if (!it.title && ti >= 0) it.title = row[ti] ?? "";
      if (!it.description && di >= 0) it.description = row[di] ?? "";
      for (const i of li) {
        const vals = [sheet.links.get(`${r}:${i}`), ...(row[i] ?? "").split(/[\s,;|]+/)].filter((v) => v && /^https?:\/\/\S+$/i.test(v));
        for (const url of vals) if (!it.links.includes(url)) it.links.push(url);
      }
    }
    // Pictures: on the row holding most of the picture (or the next-most, if that row has no product).
    for (const pic of read.pictures[sheet.name] ?? []) {
      stats.photos++;
      let it = null;
      for (const r of pic.rows) if (!it) it = rowItem.get(r) ?? null;
      if (!it) {
        stats.unplaced++;
        continue;
      }
      if (!it.photos.includes(pic.photo)) it.photos.push(pic.photo);
    }
    // Pictures on other sheets can't be tied to a row.
    for (const [name, pics] of Object.entries(read.pictures)) if (name !== sheet.name) (stats.photos += pics.length), (stats.unplaced += pics.length);
  }

  // Loose photo files, named like HN-7701.jpg, HN-7701_2.jpg, 9399111770133 back.jpg
  const known = new Map();
  for (const it of items) {
    known.set(it.key, it);
    if (it.code) known.set(`c:${it.code.toUpperCase().replace(/[^A-Z0-9]/g, "")}`, it);
  }
  const stemKey = (stem) => keyOf(/^\d{8,14}$/.test(stem) ? stem : "", /^\d{8,14}$/.test(stem) ? "" : stem);
  const stems = read.loose.map((p) => p.name.replace(/\.[^.]+$/, "").trim().toUpperCase());
  const allStems = new Set(stems);
  // "KC-310-1.jpg" and "KC-310-2.jpg" together: photos 1 and 2 of KC-310.
  const numbered = new Map();
  for (const st of stems) {
    const m = /^(.+)-(\d{1,2})$/.exec(st);
    if (m) numbered.set(m[1], (numbered.get(m[1]) ?? 0) + 1);
  }
  const placed = [];
  for (const photo of read.loose) {
    stats.photos++;
    const stem = photo.name.replace(/\.[^.]+$/, "").trim();
    const m = /^(.*?)(?:\s*[_\s(]\s*|-)(\d{1,2}|front|back|side|top|bottom|alt\d*|main)\)?$/i.exec(stem);
    const candidates = [{ stem, order: 0 }];
    if (m && m[1]) {
      const sep = stem.slice(m[1].length).trim()[0];
      // "HN-7701-2": only treat "-2" as a photo number if "HN-7701" is a product (or another file's name).
      // A number after a dash is a photo number when "KC-310" is a product or a file, or when there are
      // several numbered files for it. A code that really ends in "-12" is still matched first (whole name).
      if (sep !== "-" || known.has(stemKey(m[1])) || allStems.has(m[1].toUpperCase()) || (numbered.get(m[1].toUpperCase()) ?? 0) > 1) {
        candidates.push({ stem: m[1], order: /^\d+$/.test(m[2]) ? Number(m[2]) : 50 });
      }
    }
    let target = null;
    let order = 0;
    for (const cand of candidates) {
      const k = stemKey(cand.stem);
      if (k && known.has(k)) {
        target = known.get(k);
        order = cand.order;
        break;
      }
    }
    if (!target && !sheet) {
      // No spreadsheet: the photo names are the products.
      const cand = candidates[candidates.length - 1];
      const digits = /^\d{8,14}$/.test(cand.stem);
      target = itemFor(digits ? cand.stem : "", digits ? "" : cand.stem);
      if (target) {
        known.set(target.key, target);
        if (!target.rows.length) target.rows.push(0);
      }
      order = cand.order;
    }
    if (!target) {
      stats.unplaced++;
      continue;
    }
    placed.push({ target, photo, order });
  }
  placed.sort((a, b) => a.order - b.order || a.photo.name.localeCompare(b.photo.name));
  for (const p of placed) if (!p.target.photos.includes(p.photo)) p.target.photos.push(p.photo);

  for (const it of items) {
    stats.links += it.links.length;
    it.mixed = it.photos.length + it.links.length > 1 && ASSORTED.test(`${it.title} ${it.description}`);
  }
  return { items, stats };
}

/** SHA-256 of a photo's bytes, so the same picture is only stored once. */
export async function fingerprint(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
