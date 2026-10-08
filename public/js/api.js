// Thin API client. Every call goes through here so sign-in expiry is handled in one place.

export class SessionExpired extends Error {}
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(path, init = {}) {
  let res;
  try {
    // Cloudflare Access redirects to its login page when the sign-in expires. Don't follow it.
    res = await fetch(path, { ...init, redirect: "manual", credentials: "same-origin" });
  } catch {
    throw new ApiError("Can't reach the server. Check the internet connection and try again.", 0);
  }
  if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) throw new SessionExpired();
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // An HTML login page here also means the sign-in expired.
    if (/<html/i.test(text)) throw new SessionExpired();
  }
  if (!res.ok) throw new ApiError(body?.error || `Something went wrong (${res.status}).`, res.status, body);
  return body;
}

const json = (data) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

export const api = {
  health: () => call("/api/health"),
  store: () => call("/api/store"),
  extractText: (filename, text, attempt = 1) =>
    call("/api/extract", { method: "POST", headers: { "Content-Type": "application/json", "X-AI-Attempt": String(attempt) }, body: JSON.stringify({ filename, text }) }),
  extractFile: (filename, mimeType, base64, attempt = 1) =>
    call("/api/extract-file", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-File-Name": encodeURIComponent(filename),
        "X-File-Type": mimeType,
        "X-AI-Attempt": String(attempt),
      },
      body: base64,
    }),
  match: (items) => call("/api/match", json({ items })),
  lookup: (items) => call("/api/lookup", json({ items })),
  create: (runCode, items) => call("/api/create", json({ runCode, items })),
  listRuns: ({ q = "", mine = false, before = null, limit = 30 } = {}) =>
    call(`/api/runs?${new URLSearchParams({ q, mine: mine ? "1" : "", limit: String(limit), ...(before ? { before: String(before) } : {}) })}`),
  createRun: () => call("/api/runs", { method: "POST" }),
  getRun: (code) => call(`/api/runs/${encodeURIComponent(code)}`),
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
  getCatalogue: (code) => call(`/api/catalogues/${encodeURIComponent(code)}`),
  catalogueItems: (code, { q = "", offset = 0 } = {}) => call(`/api/catalogues/${encodeURIComponent(code)}/items?${new URLSearchParams({ q, offset: String(offset) })}`),
  knownPhotos: (code, fingerprints) => call(`/api/catalogues/${encodeURIComponent(code)}/known`, json({ fingerprints })),
  uploadPhoto: (code, photo, fingerprint, alt) =>
    call(`/api/catalogues/${encodeURIComponent(code)}/photo`, {
      method: "POST",
      headers: { "Content-Type": photo.type, "X-File-Name": encodeURIComponent(photo.name), "X-Alt": encodeURIComponent(alt.slice(0, 300)), "X-Fingerprint": fingerprint },
      body: new Blob([photo.bytes], { type: photo.type }),
    }),
  photoLinks: (code, links) => call(`/api/catalogues/${encodeURIComponent(code)}/links`, json({ links })),
  catalogueItemsAdd: (code, items) => call(`/api/catalogues/${encodeURIComponent(code)}/items`, json({ items })),
  finishCatalogue: (code) => call(`/api/catalogues/${encodeURIComponent(code)}/finish`, { method: "POST" }),
  undoCatalogue: (code) => call(`/api/catalogues/${encodeURIComponent(code)}/undo`, { method: "POST" }),
  undoCatalogueStep: (code) => call(`/api/catalogues/${encodeURIComponent(code)}/undo-step`, { method: "POST" }),
  mapCatalogue: (sample, attempt = 1) =>
    call("/api/catalogue/map", { method: "POST", headers: { "Content-Type": "application/json", "X-AI-Attempt": String(attempt) }, body: JSON.stringify({ sample }) }),
  matchCatalogue: (supplier, items) => call("/api/catalogue/match", json({ supplier, items })),
  missingPhotos: () => call("/api/catalogue/missing-photos"),
  photoSignatures: () => call("/api/catalogue/signatures"),
  photosWithoutSignature: () => call("/api/catalogue/signatures/missing"),
  saveSignatures: (items) => call("/api/catalogue/signatures", json({ items })),
  photoThumbs: (fileIds) => call("/api/catalogue/thumbs", json({ fileIds })),
  mergePhotos: (pairs) => call("/api/catalogue/merge", json({ pairs })),
  attachPhotos: (items) => call("/api/catalogue/attach", json({ items })),
};
