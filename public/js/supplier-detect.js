// Working out the supplier of an invoice or catalogue: from the name the AI read on it, the top lines of a
// spreadsheet, and the file name. An existing supplier (under any spelling) is chosen for staff; otherwise
// the best name is offered as a suggestion, never added without a click.

import { matchSupplier } from "./suppliers.js";

const SHOP = /\bprice\s*savers\b/i; // the shop being billed is never the supplier
const NOT_SUPPLIER_LINE = /\b(customer|bill(ed)?\s*to|ship(ped)?\s*to|deliver(y|ed)?\s*to|sold\s*to|invoice\s*to|attention|attn)\b/i;
// Words in file names and headings that aren't part of a business name.
const DOC_WORDS =
  /\b(tax\s+)?(invoice|inv|order|orders|purchase|sales|confirmation|quote|quotation|statement|delivery|docket|packing|slip|catalogue|catalog|product|products|price|prices|pricelist|list|range|export|portal|b2b|report|stock|sheet|new|updated?|final|copy|scan|scanned|img|image|images|photo|photos|pictures|inside|links|document|doc|file|untitled|download|attachment|page|from|for|the)\b/gi;
const SUFFIX = /\b(pty\.?|ltd\.?|limited|proprietary|inc\.?|incorporated|llc|p\/l)\b/gi;

// All capitals or all lower case (from a system or a file name): Title Case. Mixed case is kept as written.
const titleCase = (s) =>
  /[a-z]/.test(s) && /[A-Z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s(&/-])([a-z])/g, (_, p, c) => p + c.toUpperCase());

/** A business name tidied for the supplier list: "SUNBURST PARTY SUPPLIES PTY LTD" -> "Sunburst Party Supplies". */
export function cleanSupplierName(name) {
  let s = String(name ?? "").replace(/\s+/g, " ").trim();
  s = s.split(/\s+[-–|:]\s+/)[0]; // "SUNBURST PARTY SUPPLIES - B2B PORTAL ORDER EXPORT"
  s = s.replace(SUFFIX, " ").replace(/[,.]+$/, "").replace(/\s+/g, " ").trim();
  if (!/[A-Za-z]{2}/.test(s) || s.length > 60 || SHOP.test(s)) return "";
  return titleCase(s);
}

/** A file name's part that names the business: "3 - Harbour Novelty Imports - Order HN-5521.xlsx" -> "Harbour Novelty Imports". */
export function nameFromFile(fileName) {
  const stem = String(fileName ?? "").replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const parts = stem.split(/\s+[-–]\s+|_{2,}|\s*\(\s*|\s*\)\s*/).map((p) => p.replace(/_/g, " ").trim()).filter(Boolean);
  for (const p of parts) {
    if (SHOP.test(p.replace(/[-_.]+/g, " "))) continue;
    const words = p
      .replace(/([A-Za-z])[-_.]+(?=[A-Za-z])/g, "$1 ") // "koala-photos" -> "koala photos"
      .split(/\s+/)
      .filter((w) => !/\d/.test(w)) // codes, dates, "scan0001"
      .join(" ")
      .replace(DOC_WORDS, " ")
      .replace(/[^A-Za-z&' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/[A-Za-z]{3}/.test(words) && words.split(" ").length <= 5) return cleanSupplierName(words);
  }
  return "";
}

/**
 * The supplier: { match } when it's one of the existing suppliers (with where it was found), otherwise
 * { suggestion } with the best new name, or nothing.
 * aiName: the name the AI read; topLines: the first lines of a spreadsheet; fileNames: the files picked.
 */
export function detectSupplier({ aiName = "", topLines = [], fileNames = [], suppliers = [] }) {
  const list = suppliers.filter((s) => !SHOP.test(s));
  const lines = topLines.filter((l) => l && !SHOP.test(l) && !NOT_SUPPLIER_LINE.test(l)).slice(0, 4);
  const files = fileNames.map(nameFromFile).filter(Boolean);
  const tries = [
    ...(aiName && !SHOP.test(aiName) ? [{ text: aiName, from: "invoice" }] : []),
    ...lines.map((text) => ({ text, from: "sheet" })),
    ...files.map((text) => ({ text, from: "file" })),
    ...fileNames.map((n) => ({ text: n.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "), from: "file" })),
  ];
  for (const t of tries) {
    const m = matchSupplier(t.text, list) ?? matchSupplier(cleanSupplierName(t.text), list);
    if (m) return { match: m, from: t.from };
  }
  // No existing supplier: suggest the name read on it, a heading that looks like a business name, or the file name.
  const heading = lines.map(cleanSupplierName).find((n) => n && !/\d/.test(n) && !new RegExp(DOC_WORDS.source, "i").test(n) && n.split(" ").length <= 5);
  const fromAi = cleanSupplierName(aiName);
  const suggestion = fromAi || heading || files[0] || "";
  if (!suggestion) return {};
  return { suggestion, from: fromAi ? "invoice" : heading ? "sheet" : "file" };
}
