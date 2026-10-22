// Supplier catalogues: the list page (upload a catalogue, fill in missing photos) and one upload's page.
// app.js passes in its helpers (h, toast, navigate...) so both share one look and one way of doing things.

import { catalogueFileName, catalogueAlt } from "./photo-names.js";
import { buildItems, buildSample, cellRef, colLetter, fingerprint, guessMap, pictureCount, readCatalogueFiles, withLinkColumns } from "./catalogue-read.js";
import { loadSheetJS } from "./files.js";
import { sameSupplier, supplierPicker } from "./supplier-picker.js";
import { detectSupplier } from "./supplier-detect.js";
import { topText } from "./sheet-read.js";
import { describe, keepOf, loadLibrary, packThumb, sameOnProduct, tidyLibrary } from "./lookalike.js";
import { maybeSame, sameByThumb } from "./phash.js";

const MAX_FILE_BYTES = 400 * 1024 * 1024;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const PHOTO_CONCURRENCY = 3;

/** Shopify's limits for images: 20 MB and 25 megapixels. */
const SHOPIFY_MAX_SIDE = 5000;
const SHRUNK_SIDE = 4000;

/**
 * Photos over Shopify's limits are shrunk in the browser (to 4000 pixels on the long side) instead of being
 * left out. Everything else is sent exactly as it is. Returns null if the photo can't be decoded.
 */
async function fitForShopify(p) {
  const tooBig = p.bytes.byteLength > MAX_PHOTO_BYTES;
  if (!tooBig && p.bytes.byteLength < 3 * 1024 * 1024) return p; // can't be over 25 megapixels as a normal photo
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([p.bytes], { type: p.type }));
  } catch {
    return tooBig ? null : p;
  }
  const long = Math.max(bmp.width, bmp.height);
  if (!tooBig && long <= SHOPIFY_MAX_SIDE && bmp.width * bmp.height <= 25_000_000) {
    bmp.close?.();
    return p;
  }
  const scale = Math.min(1, SHRUNK_SIDE / long);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const encode = (type, q) => new Promise((res) => canvas.toBlob(res, type, q));
  // PNGs keep transparency; if that's still too big, fall back to JPEG.
  let type = p.type === "image/png" ? "image/png" : "image/jpeg";
  let blob = await encode(type, 0.9);
  if (!blob || blob.size > MAX_PHOTO_BYTES) {
    type = "image/jpeg";
    blob = await encode(type, 0.85);
  }
  if (!blob || blob.size > MAX_PHOTO_BYTES) return null;
  const name = p.name.replace(/\.[^.]+$/, "") + (type === "image/png" ? ".png" : ".jpg");
  return { ...p, name, type, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/** Does this link show a picture? (The browser only needs to load it, which works for any site.) */
function canLoadImage(url, ms = 8000) {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.referrerPolicy = "no-referrer";
    img.src = url;
  });
}

/** A bitmap (BMP) as PNG bytes, for pictures Excel stored uncompressed. */
async function bitmapToPng(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/bmp" }));
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("no png");
  return new Uint8Array(await blob.arrayBuffer());
}

/** A smaller copy of a Shopify CDN image, for thumbnails. */
export function thumb(url, width = 160) {
  if (!url) return "";
  if (!/cdn\.shopify\.com/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
}

export function createCatalogues(ctx) {
  const { api, h, $, icon, toast, confirmDialog, fact, errorText, plural, fmt, fmtWhen, person, findExisting, matchSupplier, state, SessionExpired, ApiError } = ctx;
  // File names in a line of text: a long list (a portal export of 22 files) is summed up.
  const filesText = (names) =>
    names.length <= 3 ? names.join(", ") : `${fmt(names.length)} files (${names[0]} and ${fmt(names.length - 1)} more)`;

  /* ============================================================ shared bits */

  /** One photo tile: the picture, or a placeholder while Shopify is still processing it. */
  function photoTile(p, size = 56, cls = "") {
    if (p.objectUrl || (p.status === "ready" && p.url)) {
      return h("img", { class: `ph ${cls}`, src: p.objectUrl ?? thumb(p.url, size * 2), alt: "", loading: "lazy", width: size, height: size, decoding: "async" });
    }
    if (p.link) return h("img", { class: `ph ${cls}`, src: p.link, alt: "", loading: "lazy", width: size, height: size, referrerpolicy: "no-referrer" });
    if (p.status === "failed") return h("span", { class: `ph ph-bad ${cls}`, title: "Shopify couldn't use this photo" }, icon("alert", 16));
    return h("span", { class: `ph ph-wait ${cls}`, title: "Shopify is still processing this photo" }, h("span", { class: "spinner" }));
  }

  function photoStrip(photos, max = 4, size = 48) {
    const shown = photos.slice(0, max).map((p) => photoTile(p, size));
    if (photos.length > max) shown.push(h("span", { class: "ph ph-more" }, `+${photos.length - max}`));
    return h("span", { class: "ph-strip" }, shown.length ? shown : h("span", { class: "ph ph-none", title: "No photos" }, icon("image", 16)));
  }

  /* ============================================================ tidying look-alikes */

  async function tidy() {
    if (!state.health?.files) return;
    const merged = await tidyLibrary(api);
    if (merged) {
      toast("ok", `Combined ${plural(merged, "look-alike photo")} in your catalogues, so ${merged === 1 ? "it isn't" : "they aren't"} stored twice.`);
      if (state.view === "catalogue" && page.code) refreshUpload().then(() => loadItems({ reset: true }));
    }
  }

  /* ============================================================ list page */

  const list = { next: null, seq: 0, uploads: [] };

  /** "Today", "Yesterday", "Earlier this week", "Last week", "Earlier this month", then "September 2026". */
  function dateGroup(iso) {
    const d = new Date(iso);
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const diff = Math.round((day(now) - day(d)) / 86_400_000);
    if (diff <= 0) return "Today";
    if (diff === 1) return "Yesterday";
    const monday = day(now);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    if (d >= monday) return "Earlier this week";
    const lastMonday = new Date(monday);
    lastMonday.setDate(lastMonday.getDate() - 7);
    if (d >= lastMonday) return "Last week";
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "Earlier this month";
    return d.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  }

  function renderGroups() {
    const groups = [];
    for (const u of list.uploads) {
      const label = dateGroup(u.createdAt);
      let g = groups[groups.length - 1];
      if (!g || g.label !== label) groups.push((g = { label, uploads: [] }));
      g.uploads.push(u);
    }
    $("#cat-list").replaceChildren(
      ...groups.map((g) => {
        const suppliers = new Set(g.uploads.map((u) => u.supplier)).size;
        return h(
          "section",
          { class: "cat-group" },
          h(
            "h3",
            { class: "cat-group-title" },
            g.label,
            h("span", {}, `${plural(g.uploads.length, "catalogue")}${suppliers > 1 ? ` from ${fmt(suppliers)} suppliers` : ""}`),
          ),
          h("ul", { class: "run-list" }, ...g.uploads.map(uploadItem)),
        );
      }),
    );
  }

  async function loadList({ reset = true } = {}) {
    renderBanner($("#cat-banner"));
    if (reset) tidy();
    const seq = ++list.seq;
    if (reset) list.next = null;
    try {
      const res = await api.listCatalogues({ q: $("#cat-q").value.trim(), before: reset ? null : list.next });
      if (seq !== list.seq || state.view !== "catalogues") return;
      list.uploads = reset ? res.uploads : [...list.uploads, ...res.uploads];
      renderGroups();
      list.next = res.next;
      $("#cat-more").hidden = !res.next;
      const empty = $("#cat-empty");
      empty.hidden = list.uploads.length > 0;
      if (!empty.hidden) {
        const q = $("#cat-q").value.trim();
        empty.replaceChildren(h("strong", {}, q ? "No uploads match" : "No catalogues yet"), q ? "Try another supplier or file name." : "Add a supplier's export above to get started.");
      }
    } catch (err) {
      if (err instanceof SessionExpired) return ctx.sessionExpired();
      const empty = $("#cat-empty");
      empty.hidden = false;
      empty.replaceChildren(h("strong", {}, "Couldn't load catalogues"), errorText(err));
    }
  }

  function uploadItem(u) {
    const status = u.undoneAt ? h("span", { class: "badge" }, "Undone") : h("span", { class: "badge badge-ok" }, plural(u.photoCount, "photo"));
    return h(
      "li",
      {},
      h(
        "a",
        { class: "run-item", href: `/catalogues/${u.code}`, "data-nav": "" },
        h("span", { class: "run-code" }, u.code),
        h(
          "span",
          { class: "run-main" },
          h("span", { class: "run-names" }, u.supplier),
          h("span", { class: "run-meta" }, `${person(u.createdBy)}, ${fmtWhen(u.createdAt)}`, u.fileNames.length ? h("span", { title: u.fileNames.join("\n") }, filesText(u.fileNames)) : null),
        ),
        h("span", { class: "run-counts" }, h("span", { class: "run-products" }, plural(u.itemCount, "product")), status),
        h("span", { class: "run-go", "aria-hidden": "true" }, icon("right", 16)),
      ),
    );
  }

  function renderBanner(el) {
    const hl = state.health;
    const msg = !hl ? null : !hl.runs ? hl.runsError : !hl.shopify ? `Shopify isn't connected. ${hl.shopifyError ?? ""}` : !hl.files ? hl.filesError : null;
    el.hidden = !msg;
    if (msg) el.replaceChildren(h("span", { class: "callout-icon" }, icon("alert", 18)), h("p", {}, msg));
  }

  /* ============================================================ upload wizard */

  let wiz = null; // { step, read, map, mapSource, built, supplier, problems, progress, result }

  function busy() {
    return wiz?.step === "saving";
  }

  function resetWizard() {
    if (wiz?.urls) for (const u of wiz.urls) URL.revokeObjectURL(u);
    wiz = null;
    $("#cat-wizard").hidden = true;
    $("#cat-wizard").replaceChildren();
    $("#cat-upload").hidden = false;
  }

  async function startUpload(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    if (busy()) return toast("info", "Wait until the catalogue being saved is finished.");
    const big = files.find((f) => f.size > MAX_FILE_BYTES);
    if (big) {
      return toast("bad", `${big.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB, too large to read in a browser. Ask the supplier for photo links or a ZIP of photos, or split the file.`, { sticky: true });
    }
    resetWizard();
    wiz = { step: "reading", fileNames: files.map((f) => f.name), urls: [] };
    $("#cat-upload").hidden = true;
    renderWizard();
    try {
      const [XLSX, fflate] = await Promise.all([loadSheetJS(), import("/vendor/fflate.min.js")]);
      const read = await readCatalogueFiles(files, { XLSX, unzip: (b) => fflate.unzipSync(b), zip: (f, o) => fflate.zipSync(f, o), toPng: bitmapToPng });
      if (!wiz) return;
      wiz.read = read;
      wiz.problems = [...read.problems];
      if (!read.sheets.length && !read.loose.length) {
        wiz.step = "setup";
        wiz.problems.push("No spreadsheet or photos were found in these files.");
        return renderWizard();
      }
      wiz.map = read.sheets.length ? withLinkColumns(read, guessMap(read)) : null;
      wiz.mapSource = read.sheets.length ? "headings" : null;
      if (read.sheets.length && state.health?.ai) {
        wiz.step = "mapping";
        renderWizard();
        await aiMap();
        if (!wiz) return;
      }
      // Supplier: an existing one (from the catalogue's heading, the AI or the file names) is chosen for staff;
      // otherwise the best name is suggested.
      const det = detectSupplier({ aiName: wiz.aiSupplier ?? "", topLines: topText(read.sheets, 3), fileNames: wiz.fileNames, suppliers: state.suppliers });
      wiz.supplier = det.match ?? "";
      wiz.supplierAuto = det.match ? det.from : "";
      wiz.suggestion = det.match ? "" : (det.suggestion ?? "");
      wiz.suggestionFrom = det.from ?? "";
      wiz.step = "setup";
      rebuild();
      renderWizard();
    } catch (err) {
      if (!wiz) return;
      wiz.step = "setup";
      wiz.problems = [errorText(err)];
      renderWizard();
    }
  }

  async function aiMap() {
    const sample = buildSample(wiz.read);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { map } = await api.mapCatalogue(sample, attempt);
        wiz.aiSupplier = map.supplierName ?? "";
        const sheet = wiz.read.sheets.find((s) => s.name === map.sheet) ?? wiz.read.sheets[0];
        const width = Math.max(...sheet.grid.map((r) => r.length));
        const ok = (L) => L && cellRef(`${L}1`).col < width;
        const cols = {
          barcode: ok(map.columns.barcode) ? map.columns.barcode : null,
          supplierCode: ok(map.columns.supplierCode) ? map.columns.supplierCode : null,
          title: ok(map.columns.title) ? map.columns.title : null,
          description: ok(map.columns.description) ? map.columns.description : null,
          photoLinks: map.columns.photoLinks.filter(ok),
        };
        if (cols.barcode || cols.supplierCode) {
          wiz.map = withLinkColumns(wiz.read, { sheet: sheet.name, headerRow: map.headerRow, columns: cols });
          wiz.mapSource = "ai";
        }
        return;
      } catch (err) {
        if (err instanceof SessionExpired) throw err;
        const retry = err instanceof ApiError && err.body?.retryable && attempt < 2;
        if (!retry) return; // keep the guess from the headings
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  function rebuild() {
    wiz.built = buildItems(wiz.read, wiz.map);
  }

  function setMap(change) {
    wiz.map = { ...wiz.map, ...change, columns: { ...wiz.map.columns, ...(change.columns ?? {}) } };
    wiz.mapSource = "staff";
    rebuild();
    renderWizard();
  }

  function columnOptions(sheet) {
    const width = Math.max(...sheet.grid.map((r) => r.length));
    const head = wiz.map.headerRow ? sheet.grid[wiz.map.headerRow - 1] ?? [] : [];
    const first = sheet.grid[wiz.map.headerRow ?? 0] ?? [];
    const opts = [];
    for (let c = 0; c < width; c++) {
      const label = (head[c] || first[c] || "").slice(0, 32);
      opts.push([colLetter(c), label ? `${colLetter(c)}: ${label}` : colLetter(c)]);
    }
    return opts;
  }

  function colSelect(id, label, value, onChange, opts, hint) {
    const sel = h("select", { id, class: "select" }, h("option", { value: "" }, "None"), ...opts.map(([v, t]) => h("option", { value: v }, t)));
    sel.value = value ?? "";
    sel.addEventListener("change", () => onChange(sel.value || null));
    return h("div", { class: "map-field" }, h("label", { for: id }, label), sel, hint ? h("span", { class: "map-hint" }, hint) : null);
  }

  function renderWizard() {
    const box = $("#cat-wizard");
    box.hidden = !wiz;
    if (!wiz) return;
    const head = (title, sub) => h("div", { class: "wiz-head" }, h("h2", {}, title), sub ? h("p", {}, sub) : null);

    if (wiz.step === "reading" || wiz.step === "mapping") {
      box.replaceChildren(
        head(wiz.step === "reading" ? `Reading ${wiz.fileNames.length === 1 ? wiz.fileNames[0] : plural(wiz.fileNames.length, "file")}…` : "Working out the columns…"),
        h("p", { class: "wiz-wait" }, h("span", { class: "spinner" }), wiz.step === "reading" ? "Opening the files and finding the pictures inside." : "Asking the AI which column is which. You can change it next."),
      );
      return;
    }

    if (wiz.step === "saving") {
      const p = wiz.progress;
      box.replaceChildren(
        head(`Saving the ${wiz.supplier} catalogue`, "Keep this page open until it's finished. Photos go into Shopify Files, so they never expire."),
        h("p", { class: "wiz-phase" }, p.phase),
        h("div", { class: "wiz-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(p.total || 1), "aria-valuenow": String(p.done) }, h("span", { style: `width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%` })),
        h("p", { class: "wiz-count" }, p.total ? `${fmt(p.done)} of ${fmt(p.total)}` : ""),
      );
      return;
    }

    if (wiz.step === "done") {
      const r = wiz.result;
      const lines = [`${plural(r.upload.itemCount, "product")} with ${plural(r.upload.photoCount, "photo")} saved as ${r.upload.code}.`];
      if (r.reused) lines.push(`${plural(r.reused, "photo was", "photos were")} already in Shopify Files, so ${r.reused === 1 ? "it wasn't" : "they weren't"} uploaded again.`);
      if (r.similar) lines.push(`${plural(r.similar, "photo looks", "photos look")} the same as ${r.similar === 1 ? "one" : "ones"} already stored (just resized or saved again), so the stored ${r.similar === 1 ? "one is" : "ones are"} used instead.`);
      if (r.stripped) lines.push(`${plural(r.stripped, "product")} that lost ${r.stripped === 1 ? "its" : "their"} photos can get new ones now.`);
      if (r.linksUnusable) lines.push(`The photo links didn't open from here, so the pictures in the sheet were used for ${plural(r.linksUnusable, "product")} instead (they may be small).`);
      if (r.duplicates) lines.push(`${plural(r.duplicates, "photo was", "photos were")} the same picture as another photo of the same product, so ${r.duplicates === 1 ? "it was" : "they were"} kept once.`);
      if (r.upgraded) lines.push(`${plural(r.upgraded, "stored photo was", "stored photos were")} replaced by a sharper version from this file.`);
      if (r.failed) lines.push(`${plural(r.failed, "photo")} couldn't be saved. ${r.failed === 1 ? "It's" : "They're"} listed on the catalogue's page.`);
      if (r.skipped) lines.push(`${plural(r.skipped, "photo", "photos")} couldn't be opened, so ${r.skipped === 1 ? "it was" : "they were"} left out.`);
      box.replaceChildren(
        h("div", { class: "wiz-done" }, h("span", { class: `done-mark${r.failed ? " is-partial" : ""}` }, icon(r.failed ? "alert" : "check", 26)), head("Catalogue saved", lines.join(" "))),
        h(
          "div",
          { class: "wiz-actions" },
          h("button", { type: "button", class: "btn btn-secondary", onclick: resetWizard }, "Done"),
          r.stripped
            ? h("button", { type: "button", class: "btn btn-secondary", onclick: () => (resetWizard(), findMissing(), $("#cat-missing").scrollIntoView({ block: "start" })) }, "Fill in their photos")
            : null,
          h("a", { class: "btn btn-primary", href: `/catalogues/${r.upload.code}`, "data-nav": "" }, "Open the catalogue"),
        ),
      );
      return;
    }

    // setup
    const read = wiz.read;
    const parts = [head("Check the catalogue", filesText(wiz.fileNames))];
    if (wiz.problems.length) parts.push(h("div", { class: "cat-banner" }, h("span", { class: "callout-icon" }, icon("alert", 18)), h("p", {}, wiz.problems.join(" "))));
    if (!read || (!read.sheets.length && !read.loose.length)) {
      parts.push(h("div", { class: "wiz-actions" }, h("button", { type: "button", class: "btn btn-secondary", onclick: resetWizard }, "Close")));
      return box.replaceChildren(...parts);
    }

    // Supplier (required)
    picker = supplierPicker({
      id: "wiz-supplier",
      value: wiz.supplier ?? "",
      getSuppliers: () => state.suppliers,
      onCommit: (name, isNew) => setSupplier(name, isNew, false),
      h,
      icon,
    });
    parts.push(
      h(
        "div",
        { class: "wiz-row" },
        h("label", { for: "wiz-supplier", class: "wiz-label" }, "Supplier ", h("span", { class: "wiz-required" }, "required")),
        h("div", {}, picker.el, h("p", { class: "map-hint", id: "wiz-sup-note", "aria-live": "polite" }, ...supplierNote())),
      ),
    );
    paintSupplierState();

    // Columns
    if (read.sheets.length && wiz.map) {
      const sheet = read.sheets.find((s) => s.name === wiz.map.sheet) ?? read.sheets[0];
      const opts = columnOptions(sheet);
      const c = wiz.map.columns;
      const fields = [];
      if (read.sheets.length > 1) {
        const sel = h("select", { id: "map-sheet", class: "select" }, ...read.sheets.map((s) => h("option", { value: s.name }, s.name)));
        sel.value = sheet.name;
        sel.addEventListener("change", () => setMap({ sheet: sel.value }));
        fields.push(h("div", { class: "map-field" }, h("label", { for: "map-sheet" }, "Sheet"), sel));
      }
      const hr = h("input", { id: "map-header", class: "select", type: "number", min: "0", max: String(sheet.grid.length), value: String(wiz.map.headerRow ?? 0) });
      hr.addEventListener("change", () => setMap({ headerRow: Number(hr.value) > 0 ? Number(hr.value) : null }));
      fields.push(h("div", { class: "map-field" }, h("label", { for: "map-header" }, "Headings row"), hr, h("span", { class: "map-hint" }, "0 if there are none")));
      fields.push(colSelect("map-barcode", "Barcode", c.barcode, (v) => setMap({ columns: { barcode: v } }), opts));
      fields.push(colSelect("map-code", "Supplier code", c.supplierCode, (v) => setMap({ columns: { supplierCode: v } }), opts));
      fields.push(colSelect("map-title", "Product name", c.title, (v) => setMap({ columns: { title: v } }), opts));
      fields.push(colSelect("map-desc", "Description", c.description, (v) => setMap({ columns: { description: v } }), opts, "Added to new products"));
      const links = [...c.photoLinks, null].slice(0, 4);
      links.forEach((L, i) =>
        fields.push(
          colSelect(`map-link-${i}`, i ? "More photo links" : "Photo links", L, (v) => {
            const next = [...c.photoLinks];
            if (v) next[i] = v;
            else next.splice(i, 1);
            setMap({ columns: { photoLinks: [...new Set(next.filter(Boolean))] } });
          }, opts),
        ),
      );
      const source = { ai: "Columns worked out by AI from the first rows.", headings: "Columns guessed from the headings.", staff: "Columns set by you." }[wiz.mapSource];
      parts.push(h("div", { class: "wiz-row" }, h("span", { class: "wiz-label" }, "Columns"), h("div", {}, h("p", { class: "map-hint map-source" }, source, " Check them against the preview below."), h("div", { class: "map-grid" }, ...fields))));
    }

    // Summary
    const { items, stats } = wiz.built ?? { items: [], stats: {} };
    const photoCount = new Set(items.flatMap((i) => i.photos)).size;
    const spareCount = items.filter((i) => i.backup).length; // sheet pictures beside a link to the same photo
    const linkCount = items.reduce((a, i) => a + i.links.length, 0);
    const mixed = items.filter((i) => i.mixed).length;
    const pictures = items.reduce((a, i) => a + pictureCount(i), 0);
    const noPhoto = items.filter((i) => !i.photos.length && !i.links.length).length;
    // Several files picked: say if any of them weren't read (different headings from the chosen sheet).
    const left = read.sheetFiles > 1 && wiz.built ? new Set(read.sheets.map((s) => s.file)).size - (stats.files ?? 0) : 0;
    const facts = [
      fact(
        "sheet",
        `${plural(items.length, "product")} `,
        read.sheets.length
          ? `from ${plural(stats.rows ?? 0, "row")}${(stats.sheets ?? 0) > 1 ? ` across ${(stats.files ?? 0) < 2 ? `${fmt(stats.sheets)} sheets` : stats.files === stats.sheets ? `${fmt(stats.files)} files` : `${fmt(stats.sheets)} sheets in ${fmt(stats.files)} files`} with the same headings` : ""}.`
          : "from the photo names.",
      ),
      left ? fact("alert", `${plural(left, "file has", "files have")} different headings `, `so ${left === 1 ? "it wasn't" : "they weren't"} read. Choose ${left === 1 ? "its sheet" : "one"} under Sheet to read it instead, or upload ${left === 1 ? "it" : "them"} as a separate catalogue.`, true) : null,
      fact("image", `${plural(pictures, "photo")} `, linkCount && photoCount ? `(${fmt(photoCount)} in the files, ${fmt(linkCount)} links).${spareCount ? ` ${fmt(spareCount)} products also have a small picture in the sheet beside their link: only the full-size link is used.` : ""}` : linkCount && spareCount ? `as links. ${spareCount === 1 ? "It also has" : `${fmt(spareCount)} also have`} a small picture in the sheet, which isn't uploaded as well: the full-size link is used.` : linkCount ? "as links. Shopify downloads them now, so it's fine if they expire later." : "found."),
      noPhoto ? fact("alert", `${plural(noPhoto, "product has", "products have")} no photo. `, `${noPhoto === 1 ? "It's" : "They're"} still saved, to match by barcode or code.`) : null,
      stats.skipped ? fact("hand", `${plural(stats.skipped, "row was", "rows were")} skipped `, "(headings, totals or notes without a barcode or code).") : null,
      stats.unplaced ? fact("alert", `${plural(stats.unplaced, "photo isn't", "photos aren't")} on a product row `, `(a logo, or a name that doesn't match a code), so ${stats.unplaced === 1 ? "it's" : "they're"} left out.`, true) : null,
      stats.unsupported ? fact("alert", `${plural(stats.unsupported, "picture is", "pictures are")} in a format Shopify can't use `, `(like EMF), so ${stats.unsupported === 1 ? "it's" : "they're"} left out.`, true) : null,
      mixed ? fact("alert", `${plural(mixed, "product shows", "products show")} several colours or styles. `, "When it's on an invoice, staff pick the right photo instead of getting them all.", true) : null,
    ].filter(Boolean);
    parts.push(h("ul", { class: "facts wiz-facts" }, ...facts));

    // Preview
    const show = items.slice(0, 12);
    const preview = show.map((it) => {
      const photos = it.photos.map((p) => {
        p.objectUrl ??= wiz.urls[wiz.urls.push(URL.createObjectURL(new Blob([p.bytes], { type: p.type }))) - 1];
        return p;
      });
      const all = [...photos, ...it.links.map((link) => ({ link }))];
      return h(
        "li",
        { class: "cat-item" },
        photoStrip(all, 4, 52),
        h(
          "div",
          { class: "cat-item-main" },
          h("div", { class: "cat-item-title" }, it.title || h("em", {}, "No name")),
          h(
            "div",
            { class: "item-meta" },
            it.code ? h("span", { class: "mono" }, it.code) : null,
            it.barcode ? h("span", { class: "mono" }, it.barcode) : it.badBarcode ? h("span", { class: "is-bad" }, `Barcode “${it.badBarcode}” isn't readable`) : h("span", {}, "No barcode"),
            it.mixed ? h("span", { class: "badge badge-warn" }, "Several colours") : null,
            it.rows[0] ? h("span", {}, `Row ${it.rows[0]}`) : null,
          ),
          it.description ? h("p", { class: "cat-item-desc" }, it.description) : null,
        ),
      );
    });
    parts.push(
      h("div", { class: "wiz-preview-head" }, h("h3", {}, "Preview"), h("span", {}, items.length > show.length ? `First ${show.length} of ${fmt(items.length)}` : "")),
      preview.length ? h("ul", { class: "cat-items" }, ...preview) : h("div", { class: "list-empty" }, h("strong", {}, "No products found"), "Choose the barcode or supplier code column above."),
    );

    parts.push(
      h(
        "div",
        { class: "wiz-actions" },
        h("button", { type: "button", class: "btn btn-secondary", onclick: resetWizard }, "Cancel"),
        h("button", { type: "button", class: "btn btn-brand", id: "wiz-save", disabled: !canSave(), onclick: save }, `Save ${plural(items.length, "product")}`),
      ),
    );
    box.replaceChildren(...parts);
  }

  let picker = null;

  function setSupplier(name, isNew, fromSuggestion) {
    wiz.supplier = name;
    wiz.supplierIsNew = isNew;
    wiz.supplierAuto = "";
    if (name) wiz.supplierError = false;
    if (fromSuggestion) picker?.setValue(name);
    paintSupplierState();
  }

  function paintSupplierState() {
    const note = $("#wiz-sup-note");
    if (note) {
      note.replaceChildren(...supplierNote());
      note.classList.toggle("is-bad", !!wiz?.supplierError && !(wiz.supplier ?? "").trim());
      note.classList.toggle("is-warn", !(wiz?.supplier ?? "").trim() && !!wiz?.suggestion && !wiz?.supplierError);
    }
    $("#wiz-supplier")?.classList.toggle("is-missing", !!wiz?.supplierError && !(wiz?.supplier ?? "").trim());
    const btn = $("#wiz-save");
    if (btn) btn.disabled = !canSave();
  }

  function supplierNote() {
    const name = (wiz?.supplier ?? "").trim();
    const where = { invoice: "the catalogue", sheet: "the catalogue's heading", file: "the file name" };
    if (!name && wiz?.suggestion) {
      const sug = wiz.suggestion;
      return [
        wiz.supplierError ? h("strong", {}, "Choose a supplier to save this catalogue. ") : null,
        `${wiz.suggestionFrom === "file" ? "The file name suggests" : "The catalogue says"} “${sug}”, which isn't one of your suppliers yet. `,
        h("button", { type: "button", class: "link", onclick: () => setSupplier(sameSupplier(sug, state.suppliers) ?? sug, !sameSupplier(sug, state.suppliers), true) }, `Use “${sug}”`),
        " or pick one from the list.",
      ];
    }
    if (!name) {
      return wiz?.supplierError
        ? [h("strong", {}, "Choose a supplier to save this catalogue. "), "Pick one from the list, or type a name to add a new one."]
        : ["Choose the supplier this catalogue is from. Supplier codes are matched within that supplier."];
    }
    if (wiz.supplierIsNew) return [h("strong", {}, `“${name}” will be added as a new supplier. `), "Supplier codes are matched within this supplier."];
    if (wiz.supplierAuto) return [`Matched from ${where[wiz.supplierAuto] ?? "the catalogue"}. Change it if that's wrong. `, "Supplier codes are matched within this supplier."];
    return ["Supplier codes are matched within this supplier. Barcodes match whoever sells the product."];
  }

  /** Save is only greyed out for problems staff can't fix here; a missing supplier is explained on click. */
  function canSave() {
    return Boolean(wiz?.built?.items.length && state.health?.files && !state.sessionExpired);
  }

  async function save() {
    if (!canSave() || busy()) return;
    if (!(wiz.supplier ?? "").trim()) {
      wiz.supplierError = true;
      paintSupplierState();
      // Brought into view, not focused: focusing opens the list, which would cover the message.
      $("#wiz-supplier")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const items = wiz.built.items;
    let supplier = wiz.supplier.replace(/\s+/g, " ").trim();
    const existing = sameSupplier(supplier, state.suppliers);
    if (existing) supplier = existing;
    else {
      try {
        state.suppliers = (await api.addSupplier(supplier)).suppliers;
      } catch {
        /* still used for this catalogue */
      }
    }
    wiz.supplier = supplier;
    wiz.step = "saving";
    wiz.progress = { phase: "Starting…", done: 0, total: 0 };
    renderWizard();
    const set = (phase, done, total) => {
      Object.assign(wiz.progress, { phase, done, total });
      renderWizard();
    };
    const tally = { failed: 0, reused: 0, skipped: 0, similar: 0, upgraded: 0, duplicates: 0 };
    try {
      // A second try after a failure carries on with the same upload: photos and links already sent are
      // recognised and skipped, and products already saved aren't added again.
      if (wiz.resume?.supplier !== supplier) wiz.resume = null;
      if (!wiz.resume) wiz.resume = { code: (await api.createCatalogue(supplier, wiz.fileNames)).upload.code, supplier, itemsAdded: 0 };
      const code = wiz.resume.code;

      // 0a. Pictures in the sheet that sit beside a link to the same photo were set aside: the links are used.
      //     Check that a few of those links open (in this browser; Shopify fetches them itself later). If none
      //     do (the supplier's site blocks outside use), the sheet's own pictures are used instead.
      const spare = items.filter((i) => i.backup);
      if (spare.length) {
        set("Checking the photo links", 0, 1);
        const sample = spare.slice(0, 6).map((i) => i.links[0]);
        const opened = await Promise.all(sample.map((u) => canLoadImage(u)));
        for (const it of spare) {
          if (!opened.some(Boolean)) {
            it.photos = it.backup;
            it.links = [];
            tally.linksUnusable = (tally.linksUnusable ?? 0) + 1;
          }
          delete it.backup;
        }
      }

      // 0. The same picture twice on one product (an Excel thumbnail beside its full-size copy, one stretched to
      //    fit its cell) is one photo. Photo links are compared later, once Shopify has fetched them.
      const looksOf = new Map();
      for (let n = 0; n < items.length; n++) {
        const it = items[n];
        if (it.photos.length < 2) continue;
        if (n % 20 === 0) set("Checking for duplicate photos", n, items.length);
        const kept = [];
        for (const p of it.photos) {
          if (!p.type) {
            kept.push(p);
            continue;
          }
          if (!looksOf.has(p)) looksOf.set(p, await describe(p.bytes, p.type));
          const d = looksOf.get(p);
          const at = kept.findIndex((k) => looksOf.has(k) && sameOnProduct(d, looksOf.get(k)));
          if (at < 0) {
            kept.push(p);
            continue;
          }
          tally.duplicates++;
          if (d.pixels >= looksOf.get(kept[at]).pixels * 1.5) kept[at] = p; // the sharper copy stays
        }
        it.photos = kept;
      }
      looksOf.clear();

      // 1. Fingerprint every photo, so a picture already in Shopify Files is never uploaded twice.
      const photos = [...new Set(items.flatMap((i) => i.photos))];
      // Each photo is named and described after the first product it belongs to.
      const metaOf = new Map(); // photo -> { item, index, count }
      for (const it of items) it.photos.forEach((p, index) => metaOf.has(p) || metaOf.set(p, { item: it, index, count: it.photos.length }));
      const fpOf = new Map();
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        if (!p.type) {
          tally.skipped++;
          continue;
        }
        fpOf.set(p, await fingerprint(p.bytes));
        if (i % 20 === 0) set("Preparing photos", i, photos.length);
      }
      const fileOf = new Map(); // fingerprint -> file id
      const fps = [...new Set(fpOf.values())];
      for (let i = 0; i < fps.length; i += 200) {
        const { known } = await api.knownPhotos(code, fps.slice(i, i + 200));
        for (const [fp, f] of Object.entries(known)) fileOf.set(fp, f.fileId);
      }
      tally.reused = fps.filter((fp) => fileOf.has(fp)).length;
      const firstPhoto = new Map();
      for (const [p, fp] of fpOf) if (!firstPhoto.has(fp)) firstPhoto.set(fp, p);

      // 1b. Look-alikes: a photo that looks the same as one already stored, or as another one in these files
      //     (just resized or saved again), isn't stored a second time. A clearly sharper version replaces
      //     the stored one instead.
      const library = await loadLibrary(api);
      const looks = new Map(); // fingerprint -> visual description
      const sameAs = new Map(); // fingerprint -> fingerprint of the look-alike that will be stored
      const reps = []; // { fp, d }: one per distinct picture among the new photos
      const fresh = fps.filter((fp) => !fileOf.has(fp));
      for (let i = 0; i < fresh.length; i++) {
        const fp = fresh[i];
        if (i % 10 === 0) set("Comparing with the photos already stored", i, fresh.length);
        const p = firstPhoto.get(fp);
        const d = await describe(p.bytes, p.type);
        looks.set(fp, d);
        if (!d?.parsed) continue;
        const twin = reps.find((r) => maybeSame(d.parsed, r.d.parsed) && sameByThumb(d.thumb, r.d.thumb));
        if (!twin) {
          reps.push({ fp, d });
        } else if (d.pixels >= twin.d.pixels * 1.5) {
          sameAs.set(twin.fp, fp); // this copy is sharper: store it instead
          twin.fp = fp;
          twin.d = d;
        } else sameAs.set(fp, twin.fp);
      }
      const upgrades = []; // { fp, from }: upload this, then retire the stored look-alike
      for (const r of reps) {
        const hit = await library.match(r.d);
        if (!hit) continue;
        if (r.d.pixels >= (hit.pixels || 0) * 1.5 && hit.pixels) upgrades.push({ fp: r.fp, from: hit.fileId });
        else fileOf.set(r.fp, hit.fileId);
      }
      const root = (fp) => {
        let f = fp;
        for (let n = 0; sameAs.has(f) && n < 50; n++) f = sameAs.get(f);
        return f;
      };

      // 2. Upload the new ones, a few at a time.
      const todo = fresh.filter((fp) => root(fp) === fp && !fileOf.has(fp));
      tally.similar = fresh.length - todo.length;
      let done = 0;
      const toUpload = todo.length;
      set("Uploading photos to Shopify Files", 0, toUpload);
      const worker = async () => {
        while (todo.length) {
          const fp = todo.shift();
          const p = firstPhoto.get(fp);
          try {
            const fit = await fitForShopify(p); // the fingerprint stays that of the original file
            if (!fit) {
              tally.skipped++;
              set("Uploading photos to Shopify Files", ++done, toUpload);
              continue;
            }
            const m = metaOf.get(p);
            const named = { ...fit, name: (m && catalogueFileName(m.item, m.index, fit.name)) || fit.name };
            const res = await api.uploadPhoto(code, named, fp, m ? catalogueAlt(m.item, m.index, m.count) : "");
            fileOf.set(fp, res.photo.fileId);
            const d = looks.get(fp);
            if (d?.parsed && !res.reused) sigs.push({ fileId: res.photo.fileId, sig: d.sig, thumb: await packThumb(d.thumb), pixels: d.pixels });
          } catch (err) {
            if (err instanceof SessionExpired) throw err;
            tally.failed++;
          }
          set("Uploading photos to Shopify Files", ++done, toUpload);
        }
      };
      const sigs = [];
      await Promise.all(Array.from({ length: PHOTO_CONCURRENCY }, worker));
      for (const fp of fresh) if (!fileOf.has(fp) && fileOf.has(root(fp))) fileOf.set(fp, fileOf.get(root(fp)));
      // Remember each new photo's fingerprint, so later catalogues are compared against it.
      for (let i = 0; i < sigs.length; i += 50) await api.saveSignatures(sigs.slice(i, i + 50)).catch(() => {});

      // 3. Photo links: Shopify downloads each one itself.
      const links = [...new Set(items.flatMap((i) => i.links))];
      const linkMeta = new Map(); // link -> { item, index, count }; links come after the item's own photos
      for (const it of items) {
        const count = it.photos.length + it.links.length;
        it.links.forEach((l, k) => linkMeta.has(l) || linkMeta.set(l, { item: it, index: it.photos.length + k, count }));
      }
      const linkInfo = (url) => {
        const m = linkMeta.get(url);
        if (!m) return { url, alt: "" };
        const name = catalogueFileName(m.item, m.index, url);
        return { url, alt: catalogueAlt(m.item, m.index, m.count), ...(name ? { name } : {}) };
      };
      const fileOfLink = new Map();
      const lb = state.health?.catalogueLimits?.linkBatch ?? 25;
      // A batch that fails is split in halves to find the link that can't be sent, which is counted as
      // failed while the rest carry on (one bad link no longer stops the whole catalogue).
      const sendLinks = async (batch) => {
        try {
          const { results } = await api.photoLinks(code, batch.map(linkInfo));
          results.forEach((r, k) => (r.photo ? fileOfLink.set(batch[k], r.photo.fileId) : tally.failed++));
        } catch (err) {
          if (err instanceof SessionExpired) throw err;
          if (batch.length === 1) return void tally.failed++;
          const half = Math.ceil(batch.length / 2);
          await sendLinks(batch.slice(0, half));
          await sendLinks(batch.slice(half));
        }
      };
      for (let i = 0; i < links.length; i += lb) {
        set("Sending photo links to Shopify", i, links.length);
        await sendLinks(links.slice(i, i + lb));
      }

      // 4. The products themselves.
      const ib = state.health?.catalogueLimits?.itemBatch ?? 100;
      for (let i = wiz.resume.itemsAdded; i < items.length; i += ib) {
        set("Saving products", i, items.length);
        await api.catalogueItemsAdd(
          code,
          items.slice(i, i + ib).map((it) => ({
            barcode: it.barcode,
            code: it.code,
            title: it.title || null,
            description: it.description || null,
            mixed: it.mixed,
            photos: [...it.photos.map((p) => fileOf.get(fpOf.get(p))), ...it.links.map((l) => fileOfLink.get(l))].filter(Boolean),
          })),
        );
        wiz.resume.itemsAdded = Math.min(items.length, i + ib);
      }
      set("Finishing", items.length, items.length);
      // Sharper versions replace the stored look-alikes everywhere they're used.
      const swaps = upgrades.filter((u) => fileOf.get(u.fp)).map((u) => ({ from: u.from, to: fileOf.get(u.fp) }));
      for (let i = 0; i < swaps.length; i += 25) tally.upgraded += (await api.mergePhotos(swaps.slice(i, i + 25)).catch(() => ({ merged: 0 }))).merged;
      const res = await api.finishCatalogue(code);
      wiz.step = "done";
      wiz.resume = null;
      wiz.result = { upload: res.upload, ...tally };
      try {
        wiz.result.stripped = (await api.strippedProducts()).matched;
      } catch {
        wiz.result.stripped = 0;
      }
      renderWizard();
      loadList();
      // Photo links are fingerprinted once Shopify has fetched them (a few seconds), then tidied the same way.
      if (links.length) for (const wait of [8000, 30000, 90000]) setTimeout(() => tidy(), wait);
    } catch (err) {
      if (err instanceof SessionExpired) ctx.sessionExpired();
      wiz.step = "setup";
      wiz.problems = [`Saving stopped: ${errorText(err)} Press Save again to carry on from where it stopped: photos and products already saved aren't repeated.`];
      renderWizard();
    }
  }

  /* ============================================================ fill in missing photos */

  let missing = null; // { checked, rows: [{ product, match, photos: Set(fileId), include, status }], adding }

  let missingRetry = 0;
  let missingTries = 0;
  async function findMissing({ again = false } = {}) {
    clearTimeout(missingRetry);
    if (!again) missingTries = 0;
    const btn = $("#cat-missing-find");
    btn.disabled = true;
    const box = $("#cat-missing");
    box.hidden = false;
    if (!again) box.replaceChildren(h("p", { class: "wiz-wait" }, h("span", { class: "spinner" }), "Looking through your store for products without photos…"));
    try {
      const res = await api.missingPhotos();
      missing = {
        checked: res.checked,
        rows: res.found.map((f) => {
          const ready = f.match.photos.filter((p) => p.status === "ready");
          return { ...f, chosen: f.match.mixed ? [] : ready.map((p) => p.fileId), include: !f.match.mixed, status: null };
        }),
        waiting: res.waiting ?? [],
        adding: null,
      };
      renderMissing();
      // Photos from a catalogue saved moments ago may still be processing: look again shortly.
      const processing = missing.rows.some((r) => r.match.photos.some((p) => p.status === "processing"));
      if (processing && missingTries++ < 15 && state.view === "catalogues") {
        missingRetry = setTimeout(() => !missing?.adding && !missing?.rows.some((r) => r.status) && findMissing({ again: true }), 4000);
      }
    } catch (err) {
      if (err instanceof SessionExpired) return ctx.sessionExpired();
      box.replaceChildren(h("div", { class: "cat-banner" }, h("span", { class: "callout-icon" }, icon("alert", 18)), h("p", {}, `Couldn't check the store. ${errorText(err)}`)));
    } finally {
      btn.disabled = false;
    }
  }

  function renderMissing() {
    const box = $("#cat-missing");
    if (!missing) return (box.hidden = true);
    box.hidden = false;
    const left = missing.rows.filter((r) => r.status !== "added");
    const chosen = left.filter((r) => r.include && r.chosen.length);
    const head = h(
      "div",
      { class: "wiz-head" },
      h("h2", {}, missing.rows.length ? `${plural(missing.rows.length, "product")} can get photos` : "Nothing to fill in"),
      h(
        "p",
        {},
        `Checked ${plural(missing.checked, "product")} in your store without a photo`,
        missing.rows.some((r) => r.stripped) || missing.waiting.length ? ", and every product whose photos were removed with a catalogue" : "",
        `. ${missing.rows.length ? "Each gets its own copy of the catalogue's photos." : "None of them are in a catalogue with photos yet."}`,
      ),
    );
    const waiting = missing.waiting.length
      ? h(
          "details",
          { class: "cat-waiting" },
          h("summary", {}, `${plural(missing.waiting.length, "product")} lost ${missing.waiting.length === 1 ? "its" : "their"} photos and ${missing.waiting.length === 1 ? "is" : "are"} waiting for a catalogue that has ${missing.waiting.length === 1 ? "it" : "them"}`),
          h("p", { class: "map-hint" }, "They show up above, ready to fill in, as soon as you upload a catalogue with their barcode or supplier code."),
          h("ul", {}, ...missing.waiting.map((w) => h("li", {}, w.product.title, h("span", {}, `Photos removed with ${w.stripped?.catalogue ?? "a catalogue"} ${w.stripped ? fmtWhen(w.stripped.removedAt) : ""}`)))),
        )
      : null;
    const rows = missing.rows.map((r) => {
      const ready = r.match.photos.filter((p) => p.status === "ready");
      const cb = h("input", { type: "checkbox", class: "check", disabled: r.status === "added" || !!missing.adding || !r.chosen.length, "aria-label": `Add photos to ${r.product.title}` });
      const waitingPhotos = !ready.length && r.match.photos.some((p) => p.status === "processing");
      cb.checked = r.include && r.chosen.length > 0 && r.status !== "added";
      cb.addEventListener("change", () => {
        r.include = cb.checked;
        renderMissing();
      });
      return h(
        "li",
        { class: `cat-item${r.status === "added" ? " is-done" : ""}` },
        h("span", { class: "cat-item-sel" }, cb),
        photoPicker(waitingPhotos ? r.match.photos : ready, r.chosen, (next) => {
          r.chosen = next;
          r.include = next.length > 0;
          renderMissing();
        }, r.status === "added" || !!missing.adding),
        h(
          "div",
          { class: "cat-item-main" },
          h("div", { class: "cat-item-title" }, r.product.title),
          h(
            "div",
            { class: "item-meta" },
            r.product.vendor ? h("span", {}, r.product.vendor) : null,
            h("span", {}, `Matched by ${r.match.by === "barcode" ? "barcode" : "supplier code"} in ${r.match.catalogue}`),
            r.match.mixed ? h("span", { class: "badge badge-warn" }, "Several colours: pick the photo") : null,
            r.stripped ? h("span", { class: "badge badge-warn", title: `Its photos were removed with catalogue ${r.stripped.catalogue}` }, `Photos removed with ${r.stripped.catalogue}`) : null,
            waitingPhotos ? h("span", { class: "badge badge-busy" }, "Photos still processing") : null,
            r.status === "added" ? h("span", { class: "badge badge-ok" }, "Photos added") : r.status ? h("span", { class: "badge badge-bad", title: r.status }, "Not added") : null,
            r.status && r.status !== "added" ? h("span", { class: "map-hint" }, r.status) : null,
          ),
        ),
      );
    });
    const action = missing.rows.length
      ? h(
          "div",
          { class: "wiz-actions" },
          missing.adding ? h("span", { class: "wiz-count" }, `${fmt(missing.adding.done)} of ${fmt(missing.adding.total)} done`) : null,
          h("button", { type: "button", class: "btn btn-secondary", onclick: () => ((missing = null), renderMissing()) }, "Close"),
          h("button", { type: "button", class: "btn btn-brand", disabled: !chosen.length || !!missing.adding, onclick: addMissing }, missing.adding ? "Adding…" : `Add photos to ${plural(chosen.length, "product")}`),
        )
      : h("div", { class: "wiz-actions" }, h("button", { type: "button", class: "btn btn-secondary", onclick: () => ((missing = null), renderMissing()) }, "Close"));
    box.replaceChildren(...[head, rows.length ? h("ul", { class: "cat-items" }, ...rows) : null, waiting, action].filter(Boolean));
  }

  async function addMissing() {
    const chosen = missing.rows.filter((r) => r.status !== "added" && r.include && r.chosen.length);
    if (!chosen.length) return;
    missing.adding = { done: 0, total: chosen.length };
    renderMissing();
    const size = state.health?.catalogueLimits?.attachBatch ?? 10;
    try {
      for (let i = 0; i < chosen.length; i += size) {
        const batch = chosen.slice(i, i + size);
        const { results } = await api.attachPhotos(batch.map((r) => ({ productId: r.product.productId, title: r.product.title, fileIds: r.chosen })));
        const byId = new Map(results.map((x) => [x.productId, x]));
        for (const r of batch) {
          const x = byId.get(r.product.productId);
          r.status = x?.ok ? "added" : x?.error ?? "No answer";
        }
        missing.adding.done = Math.min(chosen.length, i + batch.length);
        renderMissing();
      }
      const ok = chosen.filter((r) => r.status === "added").length;
      toast(ok === chosen.length ? "ok" : "bad", `Added photos to ${plural(ok, "product")}.${ok < chosen.length ? ` ${chosen.length - ok} didn't work: see the list.` : ""}`);
    } catch (err) {
      toast("bad", `Adding photos stopped. ${errorText(err)}`);
    } finally {
      missing.adding = null;
      renderMissing();
    }
  }

  /**
   * Photos to choose from. Click (or tap) a photo to use it or leave it out: chosen photos show a tick.
   * The first chosen photo is the main one. Right-click (or long-press on a touch screen) a photo for
   * "Make main photo".
   */
  function photoPicker(photos, chosen, onChange, locked = false) {
    const strip = h("div", { class: "photo-strip", role: "group" });
    if (!photos.length) {
      strip.append(h("span", { class: "ph ph-none" }, icon("image", 16)));
      return strip;
    }
    const makeMain = (id) => onChange([id, ...chosen.filter((x) => x !== id)]);
    const toggle = (id, on) => onChange(on ? chosen.filter((x) => x !== id) : [...chosen, id]);
    for (const p of photos) {
      const at = chosen.indexOf(p.fileId);
      const on = at >= 0;
      const main = at === 0;
      const ready = p.status === "ready";
      const btn = h(
        "button",
        {
          type: "button",
          class: `pick${on ? " is-on" : ""}${main ? " is-main" : ""}`,
          disabled: locked || !ready,
          role: "checkbox",
          "aria-checked": String(on),
          "aria-label": `${main ? "Main photo" : on ? "Photo, used" : "Photo, not used"}${ready ? "" : ", still processing"}`,
          title: !ready ? "Shopify is still processing this photo" : main ? "Main photo. Click to leave it out." : on ? "Used. Click to leave it out, right-click to make it the main photo." : "Not used. Click to use it.",
          onclick: () => toggle(p.fileId, on),
        },
        photoTile(p, 72),
        h("span", { class: "pick-tick", "aria-hidden": "true" }, on ? icon("check", 13) : null),
        main ? h("span", { class: "pick-main-tag", "aria-hidden": "true" }, "Main") : null,
      );
      if (!locked && ready) {
        const items = () => [
          main ? null : ["Make main photo", () => makeMain(p.fileId)],
          [on ? "Leave this photo out" : "Use this photo", () => toggle(p.fileId, on)],
        ];
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const r = btn.getBoundingClientRect();
          openMenu(e.clientX || r.left + 8, e.clientY || r.bottom, items());
        });
        // Long-press on touch screens (some don't send a right-click)
        let timer = 0;
        btn.addEventListener("pointerdown", (e) => {
          if (e.pointerType !== "touch") return;
          timer = setTimeout(() => {
            timer = -1;
            openMenu(e.clientX, e.clientY, items());
          }, 550);
        });
        const cancel = () => timer > 0 && clearTimeout(timer);
        btn.addEventListener("pointerup", (e) => {
          cancel();
          if (timer === -1) {
            e.preventDefault();
            timer = 0;
            btn.addEventListener("click", (ev) => ev.stopImmediatePropagation(), { once: true, capture: true });
          }
        });
        btn.addEventListener("pointerleave", cancel);
        btn.addEventListener("pointercancel", cancel);
        // Keyboard: the menu key or Shift+F10 also opens it (the browser sends contextmenu).
      }
      strip.append(btn);
    }
    return strip;
  }

  /** A small menu at the pointer, closed by a click elsewhere, Escape or scrolling. */
  let menuEl = null;
  function closeMenu() {
    if (!menuEl) return;
    const back = menuEl._return;
    menuEl.remove();
    menuEl = null;
    removeEventListener("pointerdown", outside, true);
    removeEventListener("scroll", closeMenu, true);
    back?.focus?.({ preventScroll: true });
  }
  function outside(e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }
  function menuKeys(e) {
    if (!menuEl) return;
    const btns = [...menuEl.querySelectorAll("button")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus();
    } else if (e.key === "Tab") closeMenu();
  }
  function openMenu(x, y, items) {
    closeMenu();
    const ret = document.activeElement;
    menuEl = h(
      "div",
      { class: "ctx-menu", role: "menu" },
      ...items.filter(Boolean).map(([label, fn]) =>
        h("button", { type: "button", role: "menuitem", onclick: () => (closeMenu(), fn()) }, label),
      ),
    );
    menuEl._return = ret;
    // On the menu itself, so Escape closes only the menu and not the side panel it sits in.
    menuEl.addEventListener("keydown", menuKeys);
    (document.querySelector("#drawer:not([hidden])") ?? document.body).append(menuEl);
    const w = menuEl.offsetWidth;
    const hgt = menuEl.offsetHeight;
    menuEl.style.cssText = `left:${Math.min(x, innerWidth - w - 8)}px;top:${Math.min(y, innerHeight - hgt - 8)}px`;
    menuEl.querySelector("button")?.focus({ preventScroll: true });
    setTimeout(() => {
      addEventListener("pointerdown", outside, true);
      addEventListener("scroll", closeMenu, true);
    });
  }

  /* ============================================================ one upload's page */

  const page = { code: null, offset: 0, seq: 0, poll: 0, polls: 0 };

  async function showUpload(code) {
    clearTimeout(page.poll);
    page.code = code;
    page.polls = 0;
    $("#cu-title").textContent = code;
    $("#cu-sub").textContent = "";
    $("#cu-stats").replaceChildren();
    $("#cu-items").replaceChildren();
    $("#cu-q").value = "";
    $("#cu-failed").hidden = true;
    $("#cu-undo").hidden = true;
    renderBanner($("#cu-banner"));
    await refreshUpload();
    loadItems({ reset: true });
    tidy();
  }

  async function refreshUpload() {
    const code = page.code;
    try {
      const { upload: u } = await api.getCatalogue(code);
      if (page.code !== code || state.view !== "catalogue") return;
      page.upload = u;
      $("#cu-title").textContent = `${u.code}: ${u.supplier}`;
      document.title = `${u.code} ${u.supplier} | Catalogues`;
      $("#cu-sub").textContent = `Uploaded by ${person(u.createdBy)} ${fmtWhen(u.createdAt)}${u.fileNames.length ? ` from ${filesText(u.fileNames)}` : ""}.`;
      const ph = u.photos ?? {};
      $("#cu-stats").replaceChildren(
        ...[
          stat(fmt(u.itemCount), u.itemCount === 1 ? "product" : "products"),
          stat(fmt(ph.ready ?? 0), ph.ready === 1 ? "photo ready" : "photos ready"),
          ph.processing ? stat(fmt(ph.processing), "being processed by Shopify", "is-busy") : null,
          ph.failed ? stat(fmt(ph.failed), "couldn't be saved", "is-bad") : null,
        ].filter(Boolean),
      );
      const banner = $("#cu-banner");
      if (u.undoneAt) {
        banner.hidden = false;
        banner.replaceChildren(h("span", { class: "callout-icon" }, icon("alert", 18)), h("p", {}, `Undone by ${person(u.undoneBy)} ${fmtWhen(u.undoneAt)}. It's no longer used for invoices. Press Remove catalogue to take it off the list.`));
      } else renderBanner(banner);
      $("#cu-undo").hidden = false; // also finishes removing an older, undone upload
      const failed = $("#cu-failed");
      failed.hidden = !u.failed?.length;
      if (u.failed?.length) {
        $("#cu-failed-sum").textContent = `${plural(ph.failed ?? u.failed.length, "photo")} couldn't be saved`;
        $("#cu-failed-list").replaceChildren(
          ...u.failed.map((f) => h("li", {}, h("span", { class: "mono" }, f.source), h("span", {}, f.error))),
        );
      }
      // Shopify processes new photos in the background: check again for a while.
      if (ph.processing && page.polls++ < 40) {
        page.poll = setTimeout(async () => {
          const before = page.upload?.photos?.processing;
          await refreshUpload();
          if (page.upload?.photos?.processing !== before) loadItems({ reset: true, keepScroll: true });
        }, 4000);
      }
    } catch (err) {
      if (err instanceof SessionExpired) return ctx.sessionExpired();
      toast("bad", err instanceof ApiError && err.status === 404 ? `Catalogue ${code} wasn't found.` : `Couldn't open ${code}. ${errorText(err)}`);
    }
  }

  function stat(n, label, cls = "") {
    return h("div", { class: `cu-stat ${cls}` }, h("strong", {}, n), h("span", {}, label));
  }

  async function loadItems({ reset = false } = {}) {
    const code = page.code;
    const seq = ++page.seq;
    if (reset) page.offset = 0;
    const q = $("#cu-q").value.trim();
    try {
      const res = await api.catalogueItems(code, { q, offset: page.offset });
      if (seq !== page.seq || page.code !== code) return;
      const lis = res.items.map((it) =>
        h(
          "li",
          { class: "cat-item" },
          photoStrip(it.photos, 4, 52),
          h(
            "div",
            { class: "cat-item-main" },
            h("div", { class: "cat-item-title" }, it.title || h("em", {}, "No name")),
            h(
              "div",
              { class: "item-meta" },
              it.code ? h("span", { class: "mono" }, it.code) : null,
              it.barcode ? h("span", { class: "mono" }, it.barcode) : h("span", {}, "No barcode"),
              h("span", {}, plural(it.photos.length, "photo")),
              it.mixed ? h("span", { class: "badge badge-warn" }, "Several colours") : null,
            ),
            it.description ? h("p", { class: "cat-item-desc" }, it.description) : null,
          ),
        ),
      );
      if (reset) $("#cu-items").replaceChildren(...lis);
      else $("#cu-items").append(...lis);
      page.offset += res.items.length;
      $("#cu-more").hidden = !res.more;
      const empty = $("#cu-empty");
      empty.hidden = $("#cu-items").childElementCount > 0;
      if (!empty.hidden) empty.replaceChildren(h("strong", {}, q ? "Nothing matches" : "No products"), q ? "Try part of the name, the code or the barcode." : "");
    } catch (err) {
      if (err instanceof SessionExpired) return ctx.sessionExpired();
      toast("bad", `Couldn't load the products. ${errorText(err)}`);
    }
  }

  /** A dialog that only goes ahead once the code is typed exactly. */
  function strictConfirm({ title, text, items = [], more = 0, code, ok }) {
    const dlg = $("#strict");
    $("#st-title").textContent = title;
    $("#st-text").textContent = text;
    $("#st-list").replaceChildren(...items.map((t) => h("li", {}, t)), ...(more > 0 ? [h("li", { class: "strict-more" }, `and ${plural(more, "more product")}`)] : []));
    $("#st-label").replaceChildren("To go ahead, type ", h("strong", { class: "mono" }, code), " below.");
    const input = $("#st-input");
    const btn = $("#st-ok");
    input.value = "";
    btn.textContent = ok;
    btn.disabled = true;
    const check = () => (btn.disabled = input.value.trim().toUpperCase() !== code.toUpperCase());
    input.oninput = check;
    input.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault(); // Enter only goes ahead once the code matches
      if (!btn.disabled) dlg.close("ok");
    };
    dlg.returnValue = "";
    dlg.showModal();
    input.focus();
    return new Promise((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok" ? input.value.trim() : null), { once: true }));
  }

  /**
   * Remove a catalogue: it stops being used for invoices, its photos are deleted from Shopify Files, and it
   * leaves the list. If products in the store use its photos, a strict warning asks for its code to be typed:
   * those products lose the photos too, and are listed under Fill in missing photos for new ones later.
   */
  async function removeUpload() {
    const u = page.upload;
    if (!u) return;
    const btn = $("#cu-undo");
    if (!u.undoneAt) {
      const ok = await confirmDialog({
        title: `Remove catalogue ${u.code}?`,
        ok: "Remove catalogue",
        danger: true,
        facts: [
          fact("hand", "Stops using it for invoices straight away. ", "An older catalogue from this supplier is used again, if there is one."),
          fact("trash", "Deletes its photos from Shopify Files, ", "except ones another catalogue also uses."),
          fact("alert", "This can't be undone. ", "You can upload the file again later.", true),
        ],
      });
      if (!ok) return;
    }
    btn.disabled = true;
    try {
      let remaining = 0;
      let removedFrom = 0;
      if (!u.undoneAt) {
        let res;
        try {
          res = await api.undoCatalogue(u.code);
        } catch (err) {
          if (!(err instanceof ApiError && err.body?.code === "has_products")) throw err;
          const b = err.body;
          const typed = await strictConfirm({
            title: `${plural(b.products, "product")} in your store ${b.products === 1 ? "uses" : "use"} photos from ${u.code}`,
            text: `Removing ${u.code} also removes those photos from ${b.products === 1 ? "that product" : "those products"} in Shopify. ${b.products === 1 ? "It's" : "They're"} then listed under Fill in missing photos, so ${b.products === 1 ? "it" : "they"} can get new photos when another catalogue has them.`,
            items: b.titles,
            more: b.products - b.titles.length,
            code: u.code,
            ok: `Remove ${u.code} and its photos`,
          });
          if (!typed) return;
          res = await api.undoCatalogue(u.code, typed);
        }
        remaining = res.remaining;
        removedFrom = res.products ?? 0;
      } else remaining = (await api.undoCatalogue(u.code)).remaining; // finish an earlier, interrupted removal
      const total = remaining;
      while (remaining > 0) {
        btn.textContent = `Deleting photos (${fmt(total - remaining)} of ${fmt(total)})…`;
        const step = await api.undoCatalogueStep(u.code);
        if (step.error && step.remaining >= remaining) throw new ApiError(step.error, 502);
        remaining = step.remaining;
      }
      await api.removeCatalogue(u.code);
      toast(
        "ok",
        `Removed ${u.code}.${total ? ` Deleted ${plural(total, "photo")} from Shopify Files.` : ""}${removedFrom ? ` ${plural(removedFrom, "product")} lost ${removedFrom === 1 ? "its" : "their"} photos: find ${removedFrom === 1 ? "it" : "them"} under Fill in missing photos.` : ""}`,
        { sticky: removedFrom > 0 },
      );
      ctx.navigate("/catalogues");
    } catch (err) {
      toast("bad", `Removing stopped part way. ${errorText(err)} Press Remove again to finish.`, { sticky: true });
      await refreshUpload();
      loadItems({ reset: true });
    } finally {
      btn.disabled = false;
      btn.replaceChildren(h("span", { class: "btn-icon" }, icon("trash", 18)), "Remove catalogue");
    }
  }

  /* ============================================================ wiring */

  function wire() {
    const pick = $("#cat-pick");
    pick.addEventListener("change", () => {
      startUpload(pick.files);
      pick.value = "";
    });
    $("#cat-missing-find").addEventListener("click", findMissing);
    let t = 0;
    $("#cat-q").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => loadList({ reset: true }), 250);
    });
    $("#cat-more").addEventListener("click", () => loadList({ reset: false }));
    let t2 = 0;
    $("#cu-q").addEventListener("input", () => {
      clearTimeout(t2);
      t2 = setTimeout(() => loadItems({ reset: true }), 250);
    });
    $("#cu-more").addEventListener("click", () => loadItems());
    $("#cu-undo").addEventListener("click", removeUpload);
  }

  function leave() {
    clearTimeout(page.poll);
    page.code = null;
  }

  return { wire, loadList, showUpload, startUpload, busy, leave, photoPicker, photoTile, renderBanner: () => renderBanner($("#cat-banner")) };
}
