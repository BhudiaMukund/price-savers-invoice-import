// Thin API client. Every call goes through here so sign-in expiry is handled in one place.

export class SessionExpired extends Error {}
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// What a response means. Only Cloudflare Access's own redirect or login page (or the Worker's "Not signed in")
// is an expired sign-in. A Cloudflare error page (the Worker ran out of time or memory, too many requests, a
// gateway error) is just a busy moment: calling it "sign-in expired" sent people to reload for nothing.
const ACCESS_PAGE = /cloudflareaccess\.com|cdn-cgi\/access|access\.cloudflare|Sign in to continue|<title>[^<]*(sign in|log in)/i;
const BUSY_CODES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 530]);
const BUSY_MESSAGE = "The server was busy for a moment.";
const RETRY_WAITS = [1500, 4000, 9000];

async function attempt(path, init) {
  let res;
  try {
    // Cloudflare Access redirects to its login page when the sign-in expires. Don't follow it.
    res = await fetch(path, { ...init, redirect: "manual", credentials: "same-origin" });
  } catch {
    return { kind: "offline" };
  }
  if (res.type === "opaqueredirect") return { kind: "login?" };
  let body = null;
  const text = await res.text().catch(() => "");
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const html = !body && /<html|<!doctype/i.test(text);
  if (res.status === 401 && (body || ACCESS_PAGE.test(text))) return { kind: "login?" };
  if (html && ACCESS_PAGE.test(text)) return { kind: "login?" };
  if (html || (!body && BUSY_CODES.has(res.status))) return { kind: "busy", status: res.status };
  if (res.status === 403 && !body) return { kind: "login?" }; // blocked by Access, not by the Worker
  return { kind: "done", res, body };
}

/** Is the sign-in really gone? One quick call that needs no work from the server. */
async function signedOut() {
  const r = await attempt("/api/health", {});
  return r.kind === "login?" || (r.kind === "done" && r.res.status === 401);
}

async function call(path, init = {}) {
  const { retry, ...fetchInit } = init;
  const waits = retry === true ? RETRY_WAITS : retry ? RETRY_WAITS.slice(0, retry) : []; // true: 3 tries more; a number: that many
  for (let n = 0; ; n++) {
    const r = await attempt(path, fetchInit);
    if (r.kind === "login?") {
      if (await signedOut()) throw new SessionExpired();
      // The sign-in is fine: that response was a hiccup, so treat it like a busy server.
      r.kind = "busy";
    }
    if (r.kind === "done") {
      if (!r.res.ok) throw new ApiError(r.body?.error || `Something went wrong (${r.res.status}).`, r.res.status, r.body);
      return r.body;
    }
    if (n < waits.length) {
      await new Promise((resolve) => setTimeout(resolve, waits[n]));
      continue;
    }
    if (r.kind === "offline") throw new ApiError("Can't reach the server. Check the internet connection and try again.", 0);
    throw new ApiError(BUSY_MESSAGE, r.status ?? 503, { retryable: true, code: "busy" });
  }
}

const json = (data) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

export const api = {
  health: () => call("/api/health"),
  store: () => call("/api/store"),
  /** part: for one part of a long spreadsheet, a note telling the AI which part it is. */
  extractText: (filename, text, attempt = 1, part = "") =>
    call("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AI-Attempt": String(attempt) },
      body: JSON.stringify({ filename, text, ...(part ? { part } : {}) }),
    }),
  /** pages: { from, to } to read only those pages of a long PDF. */
  extractFile: (filename, mimeType, base64, attempt = 1, pages = null) =>
    call("/api/extract-file", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-File-Name": encodeURIComponent(filename),
        "X-File-Type": mimeType,
        "X-AI-Attempt": String(attempt),
        ...(pages ? { "X-Pages": `${pages.from}-${pages.to}` } : {}),
      },
      body: base64,
    }),
  mapInvoice: (sample, attempt = 1) =>
    call("/api/invoice/map", { method: "POST", headers: { "Content-Type": "application/json", "X-AI-Attempt": String(attempt) }, body: JSON.stringify({ sample }) }),
  tidyTitles: (items, supplier, attempt = 1) =>
    call("/api/titles", { method: "POST", headers: { "Content-Type": "application/json", "X-AI-Attempt": String(attempt) }, body: JSON.stringify({ items, supplier }) }),
  match: (items) => call("/api/match", json({ items })),
  lookup: (items) => call("/api/lookup", json({ items })),
  create: (runCode, items, stock) => call("/api/create", json({ runCode, items, stock: stock === true })),
  activate: (items) => call("/api/activate", json({ items })),
  stock: (runCode, items) => call("/api/stock", json({ runCode, items })),
  undoStock: (importId, productIds) => call("/api/stock/undo", json({ importId, productIds })),
  locations: () => call("/api/locations"),
  listRuns: ({ q = "", mine = false, before = null, limit = 30 } = {}) =>
    call(`/api/runs?${new URLSearchParams({ q, mine: mine ? "1" : "", limit: String(limit), ...(before ? { before: String(before) } : {}) })}`),
  createRun: () => call("/api/runs", { method: "POST" }),
  getRun: (code) => call(`/api/runs/${encodeURIComponent(code)}`, { retry: true }),
  /** dataJson is already a JSON string, so we don't serialise twice. */
  saveRun: (code, version, dataJson, keepalive = false) =>
    call(`/api/runs/${encodeURIComponent(code)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: `{"version":${Number(version)},"data":${dataJson}}`,
      keepalive,
    }),
  deleteRun: (code) => call(`/api/runs/${encodeURIComponent(code)}`, { method: "DELETE" }),
  suppliers: () => call("/api/suppliers"),
  addSupplier: (name) => call("/api/suppliers", json({ name })),
  undo: (importId, productIds) => call("/api/undo", json({ importId, productIds })),

  // Settings and supplier management
  saveSettings: (changes) => call("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) }),
  supplierDetails: () => call("/api/suppliers/details"),
  deleteSupplier: (name) => call("/api/suppliers", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }),

  // Supplier catalogues
  listCatalogues: ({ q = "", before = null } = {}) => call(`/api/catalogues?${new URLSearchParams({ q, ...(before ? { before: String(before) } : {}) })}`),
  createCatalogue: (supplier, fileNames) => call("/api/catalogues", json({ supplier, fileNames })),
  getCatalogue: (code) => call(`/api/catalogues/${encodeURIComponent(code)}`, { retry: true }),
  catalogueItems: (code, { q = "", offset = 0 } = {}) => call(`/api/catalogues/${encodeURIComponent(code)}/items?${new URLSearchParams({ q, offset: String(offset) })}`, { retry: true }),
  knownPhotos: (code, fingerprints) => call(`/api/catalogues/${encodeURIComponent(code)}/known`, { ...json({ fingerprints }), retry: true }),
  uploadPhoto: (code, photo, fingerprint, alt) =>
    call(`/api/catalogues/${encodeURIComponent(code)}/photo`, {
      method: "POST",
      headers: { "Content-Type": photo.type, "X-File-Name": encodeURIComponent(photo.name), "X-Alt": encodeURIComponent(alt.slice(0, 300)), "X-Fingerprint": fingerprint },
      body: new Blob([photo.bytes], { type: photo.type }),
      retry: true, // the same photo (same fingerprint) is never stored twice, so trying again is safe
    }),
  photoLinks: (code, links) => call(`/api/catalogues/${encodeURIComponent(code)}/links`, { ...json({ links }), retry: 1 }), // links already sent are recognised, so repeating is safe; one more try, then the page splits the batch
  catalogueItemsAdd: (code, items) => call(`/api/catalogues/${encodeURIComponent(code)}/items`, json({ items })),
  finishCatalogue: (code) => call(`/api/catalogues/${encodeURIComponent(code)}/finish`, { method: "POST" }),
  undoCatalogue: (code, confirm = "") => call(`/api/catalogues/${encodeURIComponent(code)}/undo`, json({ confirm })),
  removeCatalogue: (code) => call(`/api/catalogues/${encodeURIComponent(code)}`, { method: "DELETE" }),
  strippedProducts: () => call("/api/catalogue/stripped"),
  undoCatalogueStep: (code) => call(`/api/catalogues/${encodeURIComponent(code)}/undo-step`, { method: "POST" }),
  mapCatalogue: (sample, attempt = 1) =>
    call("/api/catalogue/map", { method: "POST", headers: { "Content-Type": "application/json", "X-AI-Attempt": String(attempt) }, body: JSON.stringify({ sample }) }),
  matchCatalogue: (supplier, items) => call("/api/catalogue/match", json({ supplier, items })),
  missingPhotos: () => call("/api/catalogue/missing-photos"),
  photoSignatures: (after = 0) => call(`/api/catalogue/signatures${after ? `?after=${after}` : ""}`, { retry: true }),
  photosWithoutSignature: () => call("/api/catalogue/signatures/missing", { retry: true }),
  saveSignatures: (items) => call("/api/catalogue/signatures", { ...json({ items }), retry: true }),
  photoThumbs: (fileIds) => call("/api/catalogue/thumbs", { ...json({ fileIds }), retry: true }),
  mergePhotos: (pairs) => call("/api/catalogue/merge", { ...json({ pairs }), retry: true }),
  attachPhotos: (items) => call("/api/catalogue/attach", json({ items })),
};
