// File names and alt text for photos going into Shopify.
// Names describe the product ("skull-candle-holder-blk-12cm-hn-7701-2.jpg") so Content > Files is searchable
// and Google Images gets a meaningful name, instead of Excel's "image12.png".

import { basicTitle } from "./titles.js";

const EXT_RE = /\.(jpe?g|png|gif|webp)$/i;

/** Lower-case words joined by dashes, accents dropped, cut at a word boundary. */
export function slug(text, max = 60) {
  const s = String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf("-");
  return (at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).replace(/-+$/, "");
}

/** The image extension of a file name or link, or "" when it has none. */
export function imageExt(nameOrUrl) {
  let path = String(nameOrUrl ?? "");
  try {
    if (/^https?:/i.test(path)) path = decodeURIComponent(new URL(path).pathname);
  } catch {
    /* not a link */
  }
  const m = EXT_RE.exec(path);
  return m ? `.${m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase()}` : "";
}

/**
 * The product's name as a person would say it: capitals, supplier abbreviations ("ASST", "BLK"), pack ratios
 * ("12/60") and stock notes tidied by the same rules as the title shown on invoices.
 */
export function readableName(item) {
  const title = String(item?.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) return "";
  return basicTitle(title, { code: item?.code ?? "", barcode: item?.barcode ?? "" });
}

/**
 * Name for photo `index` (0 = main) of a catalogue product: its title and code, then -2, -3 for extra photos.
 * Keeps the original name when the product has neither, and returns "" for a link with no image extension
 * (Shopify then names it from the link itself).
 */
export function catalogueFileName(item, index, original) {
  const ext = imageExt(original);
  if (!ext) return "";
  const title = slug(readableName(item), 60);
  const code = slug(item?.code, 24);
  const hasCode = code && `-${title}-`.includes(`-${code}-`);
  const base = [title, hasCode ? "" : code].filter(Boolean).join("-");
  if (!base) return original;
  return `${base}${index > 0 ? `-${index + 1}` : ""}${ext}`;
}

/**
 * Alt text for a catalogue photo in Shopify Files: what the product is, in plain words. The supplier's code
 * means nothing to someone using a screen reader, so it only stands in when there is no title.
 */
export function catalogueAlt(item, index, count) {
  const code = String(item?.code ?? "").trim();
  const barcode = String(item?.barcode ?? "").trim();
  const base = readableName(item) || (code ? `Product ${code}` : barcode ? `Product with barcode ${barcode}` : "");
  return count > 1 && index > 0 ? `${base}, photo ${index + 1} of ${count}` : base;
}
