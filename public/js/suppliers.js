// Supplier helpers shared by the page (and unit-tested from test/suppliers.test.ts).

const NOISE =
  /\b(pty|ltd|limited|proprietary|co|company|corp|corporation|inc|the|australia|australian|aust|au|group|trading|wholesale|wholesalers|imports?|importers?|distributors?|distribution|supplies|international|intl|enterprises?)\b/g;

/** "Alpen Pty. Ltd." and "ALPEN" both become "alpen". */
export function supplierKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The existing supplier that a name read off an invoice refers to, or null if there's no clear match. */
export function matchSupplier(name, list) {
  const k = supplierKey(name);
  if (!k) return null;
  const exact = list.find((s) => supplierKey(s) === k);
  if (exact) return exact;
  // One name containing the other ("IG Design" vs "IG Design Group Australia"), if it's unambiguous.
  const close = list.filter((s) => {
    const sk = supplierKey(s);
    return sk.length >= 3 && k.length >= 3 && (sk.includes(k) || k.includes(sk));
  });
  return close.length === 1 ? close[0] : null;
}

/** Same name, ignoring case and spacing. */
export function findExisting(name, list) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return n ? (list.find((s) => s.toLowerCase() === n) ?? null) : null;
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

/** Unique import ID such as 20261007-R42-ALPEN-K3F9: date, run, supplier, and a random code. */
export function makeImportId(supplier, runCode, date = new Date(), random = crypto.getRandomValues(new Uint8Array(4))) {
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const slug = String(supplier ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "NOSUPPLIER";
  const code = [...random].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  const run = /^R\d+$/.test(String(runCode ?? "")) ? `${runCode}-` : "";
  return `${day}-${run}${slug}-${code}`;
}
