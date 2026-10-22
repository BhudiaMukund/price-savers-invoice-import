// Turns a picked file into what the API wants, doing the heavy work in the browser
// (Excel -> CSV, photos shrunk, base64 encoding) so the server stays inside its free CPU allowance.

import { decodeText, parseDelimited, sheetsFromWorkbook, tidyGrid } from "./sheet-read.js";

const MAX_PDF_BYTES = 7 * 1024 * 1024;
const PHOTO_LONG_EDGE = 2400;

const SPREADSHEET = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;
const TEXTLIKE = /\.(csv|tsv|txt)$/i;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export const ACCEPT = ".pdf,.csv,.tsv,.txt,.xlsx,.xlsm,.xlsb,.xls,.ods,image/*";

export class FileProblem extends Error {}

function typeOf(file) {
  const name = file.name.toLowerCase();
  if (SPREADSHEET.test(name)) return "spreadsheet";
  if (TEXTLIKE.test(name) || file.type === "text/csv" || file.type === "text/plain") return "text";
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (PHOTO_TYPES.has(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(name)) return "photo";
  return "unknown";
}

let xlsxLoading = null;
export function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/xlsx.core.min.js";
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => {
      xlsxLoading = null;
      reject(new FileProblem("Couldn't load the Excel reader. Reload the page and try again."));
    };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

/** Excel / OpenDocument to sheets of text cells, row and column numbers as in the file (A1 = [0][0]). */
async function readWorkbook(file) {
  const XLSX = await loadSheetJS();
  let wb;
  try {
    wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  } catch {
    throw new FileProblem("This spreadsheet couldn't be opened. Save it again from Excel and retry.");
  }
  const sheets = sheetsFromWorkbook(XLSX, wb);
  if (!sheets.length) throw new FileProblem("This spreadsheet has no data in it.");
  return sheets;
}

/** CSV / TSV / TXT to one sheet, whatever the encoding and separator. */
async function readDelimited(file) {
  const text = decodeText(new Uint8Array(await file.arrayBuffer()));
  const grid = tidyGrid(parseDelimited(text));
  if (!grid.some((r) => r.length)) throw new FileProblem("This file has no data in it.");
  return [{ name: file.name.replace(/\.[^.]+$/, ""), grid }];
}

const latin1 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 65536) text += String.fromCharCode(...bytes.subarray(i, i + 65536));
  return text;
};

/** The page count written in a piece of PDF text: the page tree's /Count, or the page objects. */
function pagesIn(text) {
  let count = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)/g)) count = Math.max(count, Number(m[1]));
  for (const m of text.matchAll(/\/Count\s+(\d+)[^]{0,200}?\/Type\s*\/Pages\b/g)) count = Math.max(count, Number(m[1]));
  const leaves = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return Math.max(count, leaves);
}

async function inflate(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/**
 * How many pages a PDF has, read from the file itself (0 when it can't tell). Newer PDFs keep their page
 * list inside compressed "object streams", so those are unpacked too. Used so a long PDF read a few pages at
 * a time doesn't depend on the AI's count.
 */
export async function pdfPageCount(bytes) {
  const text = latin1(bytes);
  const plain = pagesIn(text);
  if (plain) return plain;
  let count = 0;
  let seen = 0;
  for (const m of text.matchAll(/stream\r?\n/g)) {
    if (seen++ > 400) break;
    const dictStart = text.lastIndexOf("<<", m.index);
    const dict = text.slice(dictStart, m.index);
    if (dictStart < 0 || m.index - dictStart > 600 || !/\/ObjStm\b/.test(dict) || !/\/FlateDecode\b/.test(dict) || /\/DecodeParms/.test(dict)) continue;
    const start = m.index + m[0].length;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const end = len ? start + Number(len[1]) : text.indexOf("endstream", start);
    if (end <= start) continue;
    try {
      count = Math.max(count, pagesIn(latin1(await inflate(bytes.subarray(start, end)))));
    } catch {
      /* a stream that won't unpack: skip it */
    }
  }
  return count;
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new FileProblem("This file couldn't be read."));
    r.readAsDataURL(blob);
  });
}

/** Shrink big photos (phone cameras make 5-12 MB images). HEIC is sent as-is if the browser can't decode it. */
async function preparePhoto(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (file.size > MAX_PDF_BYTES) throw new FileProblem("This photo is too large to send. Take it again at a lower resolution.");
    return { blob: file, type: file.type || "image/heic" };
  }
  const scale = Math.min(1, PHOTO_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024 && file.type !== "image/heic") {
    bitmap.close?.();
    return { blob: file, type: file.type };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  if (!blob) throw new FileProblem("This photo couldn't be prepared. Try a different photo.");
  return { blob, type: "image/jpeg" };
}

/** Returns { kind: "sheets", sheets: [{ name, grid }] } or { kind: "base64", mimeType, base64 }. */
export async function prepare(file) {
  if (file.size === 0) throw new FileProblem("This file is empty.");
  switch (typeOf(file)) {
    case "spreadsheet":
      return { kind: "sheets", sheets: await readWorkbook(file) };
    case "text":
      return { kind: "sheets", sheets: await readDelimited(file) };
    case "pdf":
      if (file.size > MAX_PDF_BYTES) throw new FileProblem("This PDF is over 7 MB. Split it into smaller files.");
      return { kind: "base64", mimeType: "application/pdf", base64: await toBase64(file), pages: await pdfPageCount(new Uint8Array(await file.arrayBuffer())).catch(() => 0) };
    case "photo": {
      const { blob, type } = await preparePhoto(file);
      return { kind: "base64", mimeType: type, base64: await toBase64(blob) };
    }
    default:
      throw new FileProblem("This file type can't be read. Use a PDF, a photo, Excel or CSV.");
  }
}
