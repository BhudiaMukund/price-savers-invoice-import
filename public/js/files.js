// Turns a picked file into what the API wants, doing the heavy work in the browser
// (Excel -> CSV, photos shrunk, base64 encoding) so the server stays inside its free CPU allowance.

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
function loadSheetJS() {
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

async function spreadsheetToText(file) {
  const XLSX = await loadSheetJS();
  let wb;
  try {
    wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  } catch {
    throw new FileProblem("This spreadsheet couldn't be opened. Save it again from Excel and retry.");
  }
  const parts = [];
  for (const name of wb.SheetNames) {
    // rawNumbers keeps barcodes like 9310720073156 intact instead of 9.31072E+12.
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { rawNumbers: true, blankrows: false }).trim();
    if (csv.replace(/[,\s]/g, "")) parts.push(`## Sheet: ${name}\n${csv}`);
  }
  if (!parts.length) throw new FileProblem("This spreadsheet has no data in it.");
  return parts.join("\n\n");
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

/** Returns { kind: "text", text } or { kind: "base64", mimeType, base64 }. */
export async function prepare(file) {
  if (file.size === 0) throw new FileProblem("This file is empty.");
  switch (typeOf(file)) {
    case "spreadsheet":
      return { kind: "text", text: await spreadsheetToText(file) };
    case "text":
      return { kind: "text", text: await file.text() };
    case "pdf":
      if (file.size > MAX_PDF_BYTES) throw new FileProblem("This PDF is over 7 MB. Split it into smaller files.");
      return { kind: "base64", mimeType: "application/pdf", base64: await toBase64(file) };
    case "photo": {
      const { blob, type } = await preparePhoto(file);
      return { kind: "base64", mimeType: type, base64: await toBase64(blob) };
    }
    default:
      throw new FileProblem("This file type can't be read. Use a PDF, a photo, Excel or CSV.");
  }
}
