import { api, ApiError, SessionExpired } from "./api.js";
import { ACCEPT, FileProblem, prepare } from "./files.js";
import { analyzeBarcode, barsSvg } from "./barcode.js";
import { icon } from "./icons.js";
import { findExisting, makeImportId, matchSupplier } from "./suppliers.js";
import { createCatalogues, thumb } from "./catalogues.js";
import { sameSupplier, supplierPicker } from "./supplier-picker.js";
import { createSettings } from "./settings.js";

/* =============================================================== state */

const state = {
  view: "home", // home | run | runs | loading | catalogues | catalogue
  // The open run: { code, createdBy, createdAt, updatedAt, updatedBy, version, liveByInvoice }
  run: null,
  saveState: "saved", // saved | saving | error | conflict
  rows: [],
  // { id, name, kind, state: queued|reading|done|failed, message,
  //   supplier, supplierFromInvoice, supplierAuto, invoiceNumber, importId }
  sources: [],
  suppliers: [], // existing supplier names (Shopify vendors + ones added here)
  undoing: null, // source id while an import is being undone
  filter: "all",
  sourceFilter: null,
  query: "",
  health: null,
  store: null, // { variants, checkedAt }
  creating: null, // { done, total }
  sessionExpired: false,
  drawer: null, // { id, fix: string[] | null }
  queue: Promise.resolve(),
};

let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

function makeRow(fields) {
  return {
    id: uid("r"),
    sourceId: "manual",
    title: "",
    aiTitle: "", // the AI's tidied title, so staff can switch back to it
    invoiceTitle: "", // the wording printed on the invoice
    supplierCode: "",
    barcode: "",
    barcodeNote: "",
    inStore: null,
    checked: true, // true | false (store lookup pending) | "error"
    selected: false,
    result: null, // { status: "created", productId } | { status: "failed", error }
    adding: false,
    catalogue: null, // matching supplier catalogue entry (with its photos), or null
    photos: [], // catalogue photo file IDs to use, main photo first
    photosTouched: false, // staff changed the photo choice by hand
    useDescription: true,
    catKey: "", // what the catalogue was last checked for (barcode | code | supplier)
    ...fields,
  };
}

/* =============================================================== helpers */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // CSSOM, allowed by the page's CSP (style attributes aren't)
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const fmt = (n) => n.toLocaleString("en-AU");
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const timeOf = (iso) => new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function adminUrl(productId) {
  const handle = state.health?.storeHandle;
  return handle ? `https://admin.shopify.com/store/${encodeURIComponent(handle)}/products/${String(productId).split("/").pop()}` : null;
}

function kindOf(name) {
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv|txt)$/i.test(name)) return "sheet";
  if (/\.(jpe?g|png|webp|heic|heif)$/i.test(name)) return "photo";
  return "pdf";
}
const KIND_ICON = { pdf: "file", sheet: "sheet", photo: "image", manual: "hand" };

/* =============================================================== status model */

function firstIdsByKey() {
  const map = new Map();
  for (const r of state.rows) {
    const k = analyzeBarcode(r.barcode).key;
    if (k && !map.has(k)) map.set(k, r.id);
  }
  return map;
}

function statusOf(row, firstIds) {
  if (row.result?.status === "created") return "added";
  if (row.adding) return "adding";
  const bc = analyzeBarcode(row.barcode);
  if (bc.status === "invalid_check_digit" || bc.status === "invalid_format") return "invalid";
  if (row.inStore) return "exists";
  if (bc.key && firstIds.get(bc.key) !== row.id) return "duplicate";
  if (!row.title.trim()) return "notitle";
  if (row.result?.status === "failed") return "failed";
  if (bc.key && row.checked === false) return "checking";
  if (bc.key && row.checked === "error") return "unchecked";
  if (bc.status === "missing") return "missing";
  return "ready";
}

const GROUP = {
  ready: "new",
  adding: "new",
  missing: "attention",
  invalid: "attention",
  notitle: "attention",
  failed: "attention",
  checking: "attention",
  unchecked: "attention",
  exists: "store",
  duplicate: "store",
  added: "added",
};
const SELECTABLE = new Set(["ready", "missing", "failed", "unchecked"]);

const BADGE = {
  ready: ["badge-new", "New"],
  adding: ["badge-busy", "Adding"],
  added: ["badge-ok badge-done", "Added"],
  exists: ["badge-ok", "In store"],
  duplicate: ["", "Duplicate"],
  invalid: ["badge-bad", "Check barcode"],
  notitle: ["badge-bad", "Needs a title"],
  failed: ["badge-bad", "Not added"],
  checking: ["badge-busy", "Checking"],
  unchecked: ["badge-warn", "Not checked"],
  missing: ["badge-warn", "No barcode"],
};

const FILTERS = [
  ["all", "All"],
  ["new", "New"],
  ["attention", "Needs a look"],
  ["store", "In store"],
  ["added", "Added"],
];

function badge(status) {
  const [cls, text] = BADGE[status];
  const b = h("span", { class: `badge ${cls}` }, status === "added" ? icon("check", 13) : null, text);
  return b;
}

function snapshot() {
  const firstIds = firstIdsByKey();
  const status = new Map(state.rows.map((r) => [r.id, statusOf(r, firstIds)]));
  const counts = { all: state.rows.length, new: 0, attention: 0, store: 0, added: 0 };
  for (const s of status.values()) counts[GROUP[s]]++;
  return { status, counts };
}

function visibleRows(status) {
  const q = state.query.trim().toLowerCase();
  return state.rows.filter((r) => {
    if (state.filter !== "all" && GROUP[status.get(r.id)] !== state.filter) return false;
    if (state.sourceFilter && r.sourceId !== state.sourceFilter) return false;
    if (q && !`${r.title} ${r.invoiceTitle} ${r.supplierCode} ${r.barcode}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/* =============================================================== render */

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const snap = snapshot();
  const v = state.view;
  $("#start").hidden = v !== "home";
  $("#workspace").hidden = v !== "run";
  $("#runs-page").hidden = v !== "runs";
  $("#loading-page").hidden = v !== "loading";
  $("#cat-page").hidden = v !== "catalogues";
  $("#catalogue-page").hidden = v !== "catalogue";
  $("#settings-page").hidden = v !== "settings";
  renderCrumbs();
  if (v !== "run") $("#sources").replaceChildren();
  if (v === "run") {
    renderSources(snap);
    renderRunBar(snap);
    renderHead(snap);
    renderFilters(snap);
    renderCallout(snap);
    renderList(snap);
    if (state.rows.some(needsCatalogueCheck)) scheduleCatalogue();
  }
  renderActionBar(snap);
  if (state.drawer) paintDrawer(snap);
  renderConn();
  renderSupplierOptions();
  saveDraft();
}

function renderConn() {
  const el = $("#conn");
  const hl = state.health;
  if (!hl) return;
  el.dataset.state = hl.shopify ? "ok" : "bad";
  $(".conn-text", el).textContent = hl.shopify
    ? state.store
      ? `Shopify connected, ${plural(state.store.variants, "product")}`
      : "Shopify connected"
    : "Shopify not connected";
  el.title = $(".conn-text", el).textContent;
}

function sourceRows(src) {
  return state.rows.filter((r) => r.sourceId === src.id);
}

/** Supplier is locked once products from this invoice are in Shopify, so they all share one vendor. */
function supplierLocked(src) {
  return sourceRows(src).some((r) => r.result?.status === "created");
}

function buildSourceCard(src) {
  const picker = supplierPicker({
    id: `sup-${src.id}`,
    value: src.supplier ?? "",
    getSuppliers: () => state.suppliers,
    onCommit: (name) => commitSupplier(src, name),
    h,
    icon,
  });
  const li = h(
    "li",
    { class: "source-card", "data-src": src.id },
    h("button", { type: "button", class: "source" }),
    h(
      "button",
      {
        type: "button",
        class: "source-remove",
        "aria-label": `Remove ${src.name} from the list`,
        title: "Remove from this list",
        onclick: () => removeSource(src),
      },
      icon("x", 15),
    ),
    h(
      "div",
      { class: "source-extra" },
      h("label", { class: "sup-label", for: `sup-${src.id}` }, "Supplier"),
      picker.el,
      h("p", { class: "sup-hint" }),
      h("div", { class: "source-actions" }),
    ),
  );
  li._picker = picker;
  return li;
}

function paintSupplierHint(li, src) {
  const hint = $(".sup-hint", li);
  hint.className = "sup-hint";
  const bits = [];
  const name = (src.supplier ?? "").trim();
  if (src.supplierSaving) bits.push("Saving the new supplier…");
  else if (supplierLocked(src)) bits.push("Set on the products already added.");
  else if (!name && src.supplierFromInvoice) {
    bits.push(
      `The invoice says “${src.supplierFromInvoice}”, which isn't one of your suppliers. Pick one from the list, or `,
      h("button", { type: "button", class: "link", onclick: () => commitSupplier(src, src.supplierFromInvoice) }, "add it as a new supplier"),
      ".",
    );
    hint.classList.add("is-warn");
  } else if (!name && (src.state === "done" || src.kind === "manual")) {
    bits.push("Choose a supplier before adding.");
    hint.classList.add("is-warn");
  } else if (name && src.supplierAuto) bits.push("Matched from the invoice.");
  if (src.invoiceNumber) bits.push(h("span", { class: "sup-inv" }, `Invoice ${src.invoiceNumber}`));
  hint.replaceChildren(...bits);
}

function paintSourceCard(li, src, snap) {
  const rows = sourceRows(src);
  const g = { new: 0, attention: 0, store: 0, added: 0 };
  for (const r of rows) g[GROUP[snap.status.get(r.id)]]++;
  let meta;
  if (src.state === "queued") meta = "Waiting to be read";
  else if (src.state === "reading") meta = src.message || "Reading the invoice…";
  else if (src.state === "failed") meta = src.message;
  else if (src.kind === "manual") meta = `${plural(rows.length, "product")} added by hand`;
  else meta = rows.length ? `${plural(rows.length, "product")}${g.new ? `, ${g.new} new` : ""}` : "No products left";

  const pressed = state.sourceFilter === src.id;
  li.dataset.pressed = String(pressed);
  const btn = $(".source", li);
  btn.dataset.kind = src.kind;
  btn.dataset.state = src.state;
  btn.setAttribute("aria-pressed", String(pressed));
  btn.title = pressed ? "Show all invoices" : `Show only ${src.name}`;
  btn.onclick = () => {
    state.sourceFilter = pressed ? null : src.id;
    render();
  };
  const kids = [
    h("span", { class: "source-icon" }, icon(KIND_ICON[src.kind] ?? "file", 17)),
    h("span", { class: "source-name" }, src.name),
    h("span", { class: "source-meta" }, meta),
  ];
  if (src.state === "reading" || src.state === "queued") kids.push(h("span", { class: "source-bar" }, h("span")));
  else if (rows.length) {
    const bar = h("span", { class: "source-bar", "aria-hidden": "true" });
    for (const k of ["added", "new", "attention", "store"]) {
      if (g[k]) bar.append(h("span", { class: `seg-${k}`, style: `width:${(g[k] / rows.length) * 100}%` }));
    }
    kids.push(bar);
  }
  btn.replaceChildren(...kids);

  const rm = $(".source-remove", li);
  const live = liveCount(src);
  rm.disabled = !!state.creating || !!state.undoing;
  rm.classList.toggle("is-locked", live > 0);
  rm.title = live ? `Has ${plural(live, "product")} in Shopify. Undo the import before removing it.` : "Remove from this run";
  rm.setAttribute("aria-label", live ? `${src.name} can't be removed: ${plural(live, "product")} in Shopify` : `Remove ${src.name} from this run`);

  // Supplier, invoice number, import ID, undo
  const extra = $(".source-extra", li);
  extra.hidden = src.state === "failed" && !rows.length;
  const input = $(".sup-input", li);
  li._picker.setValue(src.supplier ?? "");
  li._picker.setDisabled(supplierLocked(src) || !!state.creating);
  input.classList.toggle("is-missing", !(src.supplier ?? "").trim() && (src.state === "done" || src.kind === "manual") && rows.length > 0);
  paintSupplierHint(li, src);

  const actions = $(".source-actions", li);
  const added = rows.filter((r) => r.result?.status === "created").length;
  const acts = [];
  if (src.importId) {
    acts.push(
      h(
        "button",
        {
          type: "button",
          class: "import-id",
          title: "Copy import ID",
          onclick: () => copyText(src.importId, "Import ID copied."),
        },
        h("span", { class: "import-id-label" }, "Import ID"),
        h("span", { class: "mono" }, src.importId),
      ),
    );
  }
  if (added && src.importId) {
    acts.push(
      h(
        "button",
        {
          type: "button",
          class: "btn btn-sm btn-ghost btn-danger undo-btn",
          disabled: !!state.creating || !!state.undoing,
          onclick: () => undoImport(src),
        },
        state.undoing === src.id ? "Undoing…" : `Undo import (${added})`,
      ),
    );
  }
  actions.replaceChildren(...acts);
  actions.hidden = acts.length === 0;
}

function renderSources(snap) {
  const ul = $("#sources");
  const existing = new Map([...ul.children].map((li) => [li.dataset.src, li]));
  const ids = new Set(state.sources.map((s) => s.id));
  for (const [id, li] of existing) if (!ids.has(id)) li.remove();
  let ref = ul.firstElementChild;
  for (const src of state.sources) {
    const li = existing.get(src.id) ?? buildSourceCard(src);
    if (li === ref) ref = ref.nextElementSibling;
    else ul.insertBefore(li, ref);
    paintSourceCard(li, src, snap);
  }
}

function renderSupplierOptions() {
  // The supplier pickers read state.suppliers directly each time they open.
}

/** Products from this invoice that are in Shopify: what this page knows, or what the server's ledger says. */
function liveCount(src) {
  const here = sourceRows(src).filter((r) => r.result?.status === "created").length;
  return Math.max(here, state.run?.liveByInvoice?.[src.id] ?? 0);
}

/**
 * Take an invoice (and its products) off this run. Never touches Shopify. Not allowed while any of its
 * products are still in Shopify: they'd lose their link to the run, so they must be deleted first
 * (Undo import). The server enforces the same rule.
 */
async function removeSource(src) {
  if (state.creating || state.undoing) return;
  const live = liveCount(src);
  if (live) {
    toast(
      "info",
      `${src.name} has ${plural(live, "product")} in Shopify, so it stays in this run. To remove it, use Undo import to delete ${live === 1 ? "that product" : "those products"} first.`,
      { id: `locked-${src.id}` },
    );
    return;
  }
  const rows = sourceRows(src);
  src.cancelled = true; // if it's still being read, ignore the result
  const at = state.sources.indexOf(src);
  state.sources = state.sources.filter((s) => s !== src);
  state.rows = state.rows.filter((r) => r.sourceId !== src.id);
  if (state.sourceFilter === src.id) state.sourceFilter = null;
  if (state.drawer && !state.rows.some((r) => r.id === state.drawer.id)) closeDrawerSilently();
  render();
  const wasReading = src.state === "reading" || src.state === "queued";
  toast("info", `Removed ${src.name} from the list.`, {
    id: `removed-${src.id}`,
    action: wasReading
      ? null
      : [
          "Undo",
          () => {
            src.cancelled = false;
            state.sources.splice(Math.min(at, state.sources.length), 0, src);
            state.rows.push(...rows);
            // Keep products grouped in invoice order.
            const order = new Map(state.sources.map((s, i) => [s.id, i]));
            state.rows.sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0));
            render();
          },
        ],
  });
}

async function commitSupplier(src, value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  src.supplierAuto = false;
  if (!name) {
    src.supplier = "";
    return render();
  }
  // Another spelling of an existing supplier ("ALPEN PTY LTD") is that supplier, never a new one.
  const existing = sameSupplier(name, state.suppliers);
  if (existing) {
    src.supplier = existing;
    return render();
  }
  src.supplier = name;
  src.supplierSaving = true;
  render();
  try {
    const res = await api.addSupplier(name);
    state.suppliers = res.suppliers;
    src.supplier = sameSupplier(name, state.suppliers) ?? name;
    toast("ok", `Added ${src.supplier} to your suppliers.`);
  } catch (err) {
    toast("bad", `Couldn't save ${name} to the supplier list. ${errorText(err)} It'll still be used for these products.`);
  } finally {
    src.supplierSaving = false;
    render();
  }
}

async function loadSuppliers() {
  try {
    const res = await api.suppliers();
    state.suppliers = res.suppliers;
    // Invoices read before the list arrived: try matching again.
    for (const src of state.sources) {
      if (!src.supplier && src.supplierFromInvoice) {
        const m = matchSupplier(src.supplierFromInvoice, state.suppliers);
        if (m) Object.assign(src, { supplier: m, supplierAuto: true });
      }
    }
    render();
  } catch (err) {
    if (err instanceof SessionExpired) return sessionExpired();
    toast("bad", "Couldn't load the supplier list. You can still type a supplier name.");
  }
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast("ok", done);
  } catch {
    toast("info", text);
  }
}

function renderHead() {
  const sub = $("#review-sub");
  const reading = state.sources.some((s) => s.state === "reading" || s.state === "queued");
  if (reading && !state.rows.length) sub.textContent = "Reading your invoice. Products appear here as soon as it's done.";
  else if (state.store) sub.textContent = `Checked against ${plural(state.store.variants, "product")} in your Shopify store at ${timeOf(state.store.checkedAt)}.`;
  else sub.textContent = "Products added by hand are checked against your store by barcode.";
}

function renderFilters(snap) {
  const box = $("#filters");
  const btns = FILTERS.map(([key, label]) => {
    const n = snap.counts[key];
    const sel = state.filter === key;
    return h(
      "button",
      {
        type: "button",
        role: "tab",
        class: "filter",
        "data-filter": key,
        "aria-selected": String(sel),
        tabindex: sel ? "0" : "-1",
        onclick: () => setFilter(key),
      },
      label,
      h("span", { class: `filter-n${n && key !== "all" ? " has" : ""}` }, fmt(n)),
    );
  });
  const hadFocus = box.contains(document.activeElement);
  box.replaceChildren(...btns);
  if (hadFocus) $(`[data-filter="${state.filter}"]`, box)?.focus();
}

function setFilter(key) {
  state.filter = key;
  render();
  $("#list-body")?.scrollIntoView?.({ block: "nearest" });
}

function renderCallout(snap) {
  const n = snap.counts.attention;
  const box = $("#callout");
  const show = n > 0 && !state.creating;
  box.hidden = !show;
  if (show) $("#callout-text").textContent = `${plural(n, "product needs", "products need")} a look before ${n === 1 ? "it" : "they"} can be added.`;
}

function itemNote(row, status) {
  const bc = analyzeBarcode(row.barcode);
  if (status === "invalid") return bc.status === "invalid_check_digit" ? "A digit looks misread" : "Not a valid barcode";
  if (status === "failed") return row.result.error;
  if (status === "exists" && row.inStore.title.trim().toLowerCase() !== row.title.trim().toLowerCase()) return `As “${row.inStore.title}”`;
  if (row.barcodeNote && status === "ready") return "Leading zero restored";
  return null;
}

function renderItem(row, status, sourceName) {
  const bc = analyzeBarcode(row.barcode);
  const selectable = SELECTABLE.has(status) && !state.creating;
  const selected = selectable && row.selected;
  const title = row.title.trim();

  const check = h("input", {
    type: "checkbox",
    class: "check",
    tabindex: "-1",
    "aria-label": `Select ${title || "untitled product"}`,
    disabled: !selectable,
  });
  check.checked = selected;

  const photos = rowPhotos(row);
  const meta = h(
    "div",
    { class: "item-meta" },
    photos.length ? h("span", { class: "item-photos", title: `${plural(photos.length, "photo")} from the ${row.catalogue.supplier} catalogue` }, icon("image", 12), fmt(photos.length)) : null,
    row.supplierCode ? h("span", { class: "mono" }, row.supplierCode) : null,
    row.barcode ? h("span", { class: "item-meta-bar mono" }, row.barcode) : null,
    sourceName ? h("span", {}, sourceName) : null,
  );

  const barCell = h("div", { class: `item-bar${status === "invalid" ? " is-bad" : ""}`, role: "gridcell" });
  if (bc.status === "missing") barCell.append(h("span", { class: "none" }, "No barcode"));
  else {
    barCell.append(h("span", { class: "digits" }, bc.status === "valid" ? bc.digits : row.barcode));
    if (bc.status === "valid") {
      const svg = barsSvg(bc.digits);
      if (svg) barCell.append(svg);
    }
  }

  const note = itemNote(row, status);
  const quiet = status === "exists" || status === "duplicate" || status === "added";
  const el = h(
    "div",
    {
      class: `item${selected ? " is-selected" : ""}${quiet ? " is-quiet" : ""}${state.drawer?.id === row.id ? " is-open" : ""}`,
      role: "row",
      tabindex: "0",
      "data-id": row.id,
      "aria-selected": String(selected),
    },
    h("div", { class: "item-sel", role: "gridcell" }, check),
    h(
      "div",
      { class: `item-main${photos[0] ? " has-thumb" : ""}`, role: "gridcell" },
      photos[0] ? h("img", { class: "item-thumb", src: thumb(photos[0].url, 96), alt: "", loading: "lazy", width: 40, height: 40 }) : null,
      h(
        "div",
        { class: "item-text" },
        h(
          "div",
          { class: `item-title${title ? "" : " is-empty"}`, title: row.invoiceTitle && row.invoiceTitle !== row.title ? `On the invoice: ${row.invoiceTitle}` : null },
          title || "No title yet",
        ),
        meta,
      ),
    ),
    barCell,
    h("div", { class: "item-status", role: "gridcell" }, badge(status), note ? h("span", { class: "status-note" }, note) : null),
    h("div", { class: "item-go", "aria-hidden": "true" }, icon("right", 16)),
  );
  return el;
}

function renderSkeleton() {
  return h(
    "div",
    { class: "item is-skeleton", "aria-hidden": "true" },
    h("div", { class: "item-sel" }),
    h("div", { class: "item-main" }, h("span", { class: "sk", style: "width:60%" }), h("span", { class: "sk", style: "width:28%;margin-top:8px;height:8px" })),
    h("div", { class: "item-bar" }, h("span", { class: "sk", style: "width:110px" })),
    h("div", { class: "item-status" }, h("span", { class: "sk", style: "width:64px;height:20px;border-radius:999px" })),
    h("div"),
  );
}

function renderList(snap) {
  const body = $("#list-body");
  const rows = visibleRows(snap.status);
  const names = new Map(state.sources.map((s) => [s.id, s.kind === "manual" ? "Added by hand" : s.name]));
  const showSource = state.sources.length > 1 && !state.sourceFilter;

  const active = document.activeElement;
  const focusId = active?.closest?.(".item")?.dataset.id;

  const nodes = rows.map((r) => renderItem(r, snap.status.get(r.id), showSource ? names.get(r.sourceId) : null));
  const reading = state.sources.filter((s) => (s.state === "reading" || s.state === "queued") && (!state.sourceFilter || state.sourceFilter === s.id));
  if (reading.length && (state.filter === "all" || state.filter === "new") && !state.query) {
    for (let i = 0; i < 3; i++) nodes.push(renderSkeleton());
  }
  body.replaceChildren(...nodes);
  if (focusId) $(`.item[data-id="${focusId}"]`, body)?.focus({ preventScroll: true });

  const empty = $("#list-empty");
  const isEmpty = nodes.length === 0;
  $("#list").hidden = isEmpty;
  empty.hidden = !isEmpty;
  if (isEmpty) {
    const [t, d] = state.query
      ? [`No products match “${state.query.trim()}”`, "Try part of the title, the supplier code or the barcode."]
      : {
          all: ["Nothing here yet", "Add an invoice to get started."],
          new: ["Nothing new to add", "Everything is already in the store, added, or needs a look."],
          attention: ["Nothing needs a look", "Every product has a title and a valid barcode."],
          store: ["None of these are in the store yet", "Products whose barcode is already in Shopify show up here."],
          added: ["Nothing added yet", "Products you add to Shopify show up here."],
        }[state.filter];
    empty.replaceChildren(h("strong", {}, t), d);
  }

  const selectable = rows.filter((r) => SELECTABLE.has(snap.status.get(r.id)));
  const all = $("#select-all");
  const on = selectable.filter((r) => r.selected).length;
  all.disabled = !selectable.length || !!state.creating;
  all.checked = selectable.length > 0 && on === selectable.length;
  all.indeterminate = on > 0 && on < selectable.length;
}

function chosenRows(snap) {
  return state.rows.filter((r) => r.selected && SELECTABLE.has(snap.status.get(r.id)));
}

function renderActionBar(snap) {
  const bar = $("#actionbar");
  const chosen = chosenRows(snap);
  const show = (chosen.length > 0 || state.creating) && !$("#workspace").hidden && !state.drawer;
  bar.hidden = !show;
  if (!show) return;
  const btn = $("#ab-add");
  const count = $("#ab-count");
  if (state.creating) {
    const { done, total } = state.creating;
    count.replaceChildren(`Adding to Shopify`, h("small", {}, `${fmt(done)} of ${fmt(total)} done`));
    btn.disabled = true;
    btn.textContent = "Adding…";
    $("#ab-clear").hidden = true;
    $("#ab-progress").hidden = false;
    $("#ab-progress-fill").style.width = `${Math.round((done / total) * 100)}%`;
  } else {
    const missing = sourcesMissingSupplier(chosen);
    count.replaceChildren(
      `${fmt(chosen.length)} selected`,
      h("small", {}, missing.length ? `Choose a supplier for ${missing[0].name}${missing.length > 1 ? ` and ${missing.length - 1} more` : ""}` : "Added at $0, in-store only"),
    );
    btn.disabled = !state.health?.shopify || state.sessionExpired;
    btn.textContent = missing.length ? "Choose supplier" : `Add ${chosen.length === 1 ? "1 product" : `${fmt(chosen.length)} products`}`;
    $("#ab-clear").hidden = false;
    $("#ab-progress").hidden = true;
  }
}

function sourcesMissingSupplier(rows) {
  const ids = new Set(rows.map((r) => r.sourceId));
  return state.sources.filter((s) => ids.has(s.id) && !(s.supplier ?? "").trim());
}

/* =============================================================== supplier catalogues: photos for invoice lines */

/** The catalogue photos this row will get (ready ones only, in the chosen order). */
function rowPhotos(row) {
  if (!row.catalogue || !row.photos?.length) return [];
  const byId = new Map(row.catalogue.photos.map((p) => [p.fileId, p]));
  return row.photos.map((id) => byId.get(id)).filter((p) => p && p.status === "ready" && p.url);
}

function catKeyOf(row) {
  const src = state.sources.find((s) => s.id === row.sourceId);
  const code = (row.supplierCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${analyzeBarcode(row.barcode).key ?? ""}|${code}|${(src?.supplier ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function needsCatalogueCheck(row) {
  return row.result?.status !== "created" && !row.adding && row.catKey !== catKeyOf(row);
}

let catTimer = 0;
let catBusy = false;
function scheduleCatalogue() {
  if (catBusy || !state.health?.runs || state.view !== "run") return;
  clearTimeout(catTimer);
  catTimer = setTimeout(runCatalogue, 500);
}

/** Look up the supplier catalogues for rows whose barcode, code or supplier changed. */
async function runCatalogue() {
  if (catBusy || state.view !== "run") return;
  const todo = state.rows.filter(needsCatalogueCheck);
  if (!todo.length) return;
  catBusy = true;
  const keys = new Map(todo.map((r) => [r, catKeyOf(r)]));
  try {
    // Nothing to match on: clear without asking.
    const ask = todo.filter((r) => {
      if (analyzeBarcode(r.barcode).key || r.supplierCode?.trim()) return true;
      applyMatch(r, null);
      r.catKey = keys.get(r);
      return false;
    });
    const bySupplier = new Map();
    for (const r of ask) {
      const sup = (state.sources.find((s) => s.id === r.sourceId)?.supplier ?? "").trim();
      bySupplier.set(sup, [...(bySupplier.get(sup) ?? []), r]);
    }
    for (const [supplier, rows] of bySupplier) {
      for (let i = 0; i < rows.length; i += 300) {
        const batch = rows.slice(i, i + 300);
        const { matches } = await api.matchCatalogue(supplier, batch.map(({ id, barcode, supplierCode }) => ({ id, barcode, supplierCode })));
        for (const r of batch) {
          if (catKeyOf(r) !== keys.get(r)) continue; // edited again meanwhile
          applyMatch(r, matches[r.id] ?? null);
          r.catKey = keys.get(r);
        }
      }
    }
  } catch (err) {
    if (err instanceof SessionExpired) sessionExpired();
    for (const r of todo) r.catKey = keys.get(r); // don't keep asking; "Check again" or an edit retries
  } finally {
    catBusy = false;
    render();
  }
  // Photos Shopify is still processing: look again shortly.
  const waiting = state.rows.filter((r) => r.result?.status !== "created" && r.catalogue?.photos.some((p) => p.status === "processing"));
  if (waiting.length) {
    setTimeout(() => {
      for (const r of waiting) if ((r.catTries = (r.catTries ?? 0) + 1) < 20) r.catKey = "";
      scheduleCatalogue();
    }, 8000);
  }
}

function applyMatch(row, m) {
  if (!m) {
    row.catalogue = null;
    row.photos = [];
    return;
  }
  const usable = m.photos.filter((p) => p.status === "ready" || p.status === "processing").map((p) => p.fileId);
  const same = row.catalogue?.itemId === m.itemId;
  const auto = state.health?.settings?.cataloguePhotos !== false;
  if (!same) {
    // A catalogue entry showing several colours: staff pick the right photo.
    row.photos = m.mixed || !auto ? [] : usable;
    row.photosTouched = false;
    row.useDescription = state.health?.settings?.catalogueDescriptions !== false;
  } else if (!row.photosTouched && !m.mixed && auto) row.photos = usable;
  else row.photos = row.photos.filter((id) => usable.includes(id));
  row.catalogue = m;
}

function paintDrawerPhotos(row, lock) {
  const box = $("#dr-photos");
  const m = row.catalogue;
  box.hidden = !m;
  if (!m) return;
  const used = rowPhotos(row).length;
  $("#dr-photos-label").textContent = m.photos.length ? `Photos (${used} of ${m.photos.length} used)` : "Supplier catalogue";
  const note = $("#dr-photos-note");
  note.className = `dr-photos-note${m.mixed && !row.photos.length ? " is-warn" : ""}`;
  note.replaceChildren(
    `From the ${m.supplier} catalogue (${m.catalogue}), matched by ${m.by === "barcode" ? "barcode" : "supplier code"}. `,
    m.mixed
      ? "It shows several colours or styles, so pick the photo that matches this product."
      : m.photos.length
        ? "Ticked photos are added. Click one to add or leave it out; right-click it (or press and hold) to make it the main photo."
        : "It has no photos.",
  );
  $("#dr-photo-strip").replaceChildren(
    ...(m.photos.length
      ? [
          catalogues.photoPicker(m.photos, row.photos, (next) => {
            row.photos = next;
            row.photosTouched = true;
            render();
          }, lock),
        ]
      : []),
  );
  const desc = $("#dr-desc");
  desc.hidden = !m.description;
  if (m.description) {
    $("#dr-desc-text").textContent = m.description;
    const cb = $("#dr-desc-use");
    cb.checked = row.useDescription !== false;
    cb.disabled = lock;
  }
}

/* =============================================================== drawer */

let lastFocus = null;

function openDrawer(id, { fix = null, focus = null } = {}) {
  const row = state.rows.find((r) => r.id === id);
  if (!row) return;
  if (!state.drawer) lastFocus = document.activeElement;
  state.drawer = { id, fix: fix ?? state.drawer?.fix ?? null };
  const d = $("#drawer");
  d.hidden = false;
  $("#scrim").hidden = false;
  document.body.style.overflow = "hidden";

  $("#dr-name").value = row.title;
  $("#dr-barcode").value = row.barcode;
  $("#dr-code").value = row.supplierCode;
  render();

  const status = statusOf(row, firstIdsByKey());
  const target =
    focus ??
    (status === "notitle" ? "#dr-name" : ["invalid", "missing"].includes(status) && state.drawer.fix ? "#dr-barcode" : null);
  (target ? $(target) : $("#dr-close")).focus({ preventScroll: true });
  if (target === "#dr-barcode") $("#dr-barcode").select();
}

function closeDrawer() {
  if (!state.drawer) return;
  const id = state.drawer.id;
  normaliseBarcode();
  state.drawer = null;
  $("#drawer").hidden = true;
  $("#scrim").hidden = true;
  document.body.style.overflow = "";
  render();
  const item = $(`.item[data-id="${id}"]`);
  (item ?? (lastFocus?.isConnected ? lastFocus : null) ?? $("#main")).focus({ preventScroll: false });
}

function drawerRow() {
  return state.drawer ? state.rows.find((r) => r.id === state.drawer.id) : null;
}

/** Rows the up/down arrows step through: the fix list, or what's showing in the list. */
function navList(snap) {
  if (state.drawer?.fix) return state.drawer.fix.filter((id) => state.rows.some((r) => r.id === id));
  return visibleRows(snap.status).map((r) => r.id);
}

function paintDrawer(snap) {
  const row = drawerRow();
  if (!row) return closeDrawerSilently();
  const status = snap.status.get(row.id);
  const bc = analyzeBarcode(row.barcode);
  const lock = !!state.creating || status === "added" || status === "adding";

  // Header position
  const list = navList(snap);
  const i = list.indexOf(row.id);
  $("#dr-pos").textContent = state.drawer.fix
    ? `Fixing ${i + 1} of ${list.length}`
    : i >= 0
      ? `${fmt(i + 1)} of ${fmt(list.length)}`
      : "";
  $("#dr-prev").disabled = i <= 0;
  $("#dr-next").disabled = i < 0 || i >= list.length - 1;

  // Status
  const msg = {
    ready: "Ready to add. It isn't in your store yet.",
    adding: "Adding to Shopify…",
    added: "Added to Shopify on Point of Sale.",
    exists: "This barcode is already on a product in your store, so it won't be added again.",
    duplicate: "Another product in this list has the same barcode. Only the first one can be added.",
    invalid: "This barcode doesn't add up. Check it against the invoice, scan the product, or clear it.",
    notitle: "Give this product a title so staff can find it.",
    failed: `Shopify didn't accept it: ${row.result?.error ?? "unknown error"}`,
    checking: "Checking your store for this barcode…",
    unchecked: "Couldn't check your store for this barcode. It'll be checked again when you add it.",
    missing: "No barcode on the invoice. Scan or type one so it can be sold at the till, or add it without.",
  }[status];
  $("#dr-status").replaceChildren(badge(status), h("p", { class: "dr-status-msg" }, msg));

  // Fields
  for (const sel of ["#dr-name", "#dr-barcode", "#dr-code"]) $(sel).readOnly = lock;
  $("#dr-name").closest(".field").classList.toggle("is-bad", status === "notitle");
  $("#dr-barcode").closest(".field").classList.toggle("is-bad", status === "invalid");
  if (document.activeElement !== $("#dr-name") && $("#dr-name").value !== row.title) $("#dr-name").value = row.title;
  if (document.activeElement !== $("#dr-barcode") && $("#dr-barcode").value !== row.barcode) $("#dr-barcode").value = row.barcode;
  if (document.activeElement !== $("#dr-code") && $("#dr-code").value !== row.supplierCode) $("#dr-code").value = row.supplierCode;

  // Title alternatives: the invoice's own wording, and the AI's tidied version
  const alts = [];
  const cur = row.title.trim();
  if (row.invoiceTitle && row.invoiceTitle !== cur) alts.push(["On the invoice", row.invoiceTitle, "Use invoice wording"]);
  if (row.aiTitle && row.aiTitle !== cur) alts.push(["Tidied title", row.aiTitle, "Use tidied title"]);
  const catTitle = row.catalogue?.title?.trim();
  if (catTitle && catTitle.toLowerCase() !== cur.toLowerCase() && catTitle !== row.invoiceTitle) alts.push(["In the catalogue", catTitle, "Use catalogue name"]);
  $("#dr-alts").replaceChildren(
    ...alts.map(([label, text, action]) =>
      h(
        "p",
        { class: "alt" },
        h("span", { class: "alt-label" }, `${label}: `),
        h("span", { class: "alt-text" }, text),
        lock
          ? null
          : h(
              "button",
              {
                type: "button",
                class: "link alt-use",
                onclick: () => {
                  row.title = text;
                  $("#dr-name").value = text;
                  if (row.result?.status === "failed") row.result = null;
                  render();
                },
              },
              action,
            ),
      ),
    ),
  );

  paintDrawerPhotos(row, lock);

  // Big barcode
  const big = $("#dr-bars");
  big.className = "barcode-big";
  if (bc.status === "valid") {
    const svg = barsSvg(bc.digits);
    big.replaceChildren(...[svg, h("div", { class: "digits" }, bc.digits), row.barcodeNote ? h("div", { class: "bb-note" }, row.barcodeNote) : null].filter(Boolean));
  } else if (bc.status === "missing") {
    big.classList.add("is-empty");
    big.replaceChildren(h("div", { class: "bb-msg" }, "The barcode will be drawn here so you can compare it with the product."));
  } else {
    big.classList.add("is-bad");
    const why =
      bc.status === "invalid_check_digit"
        ? ["The last digit doesn't match the rest.", "One digit was probably misread from the invoice."]
        : /e\+?\d/i.test(row.barcode)
          ? ["A spreadsheet scrambled this number.", "Type the barcode from the product itself."]
          : [`${bc.digits?.length ?? 0} digits isn't a barcode length.`, "Barcodes have 8, 12, 13 or 14 digits."];
    big.replaceChildren(h("div", { class: "bb-msg" }, h("strong", {}, why[0]), why[1]));
  }

  // Store check
  const sc = $("#dr-store");
  sc.className = "store-check";
  const link = (id, text) => {
    const url = adminUrl(id);
    return url ? h("a", { href: url, target: "_blank", rel: "noopener" }, text, icon("external", 13)) : null;
  };
  let scIcon = "store";
  let scBody;
  switch (status) {
    case "exists":
      sc.classList.add("is-in");
      scBody = [h("strong", {}, "Already in your store"), `As “${row.inStore.title}”.`, h("br"), link(row.inStore.productId, "Open in Shopify")];
      break;
    case "added":
      sc.classList.add("is-ok");
      scIcon = "check";
      scBody = [h("strong", {}, "Added to Shopify"), "Set its price in the POS app.", h("br"), link(row.result.productId, "Open in Shopify")];
      break;
    case "duplicate": {
      const firstId = firstIdsByKey().get(bc.key);
      const first = state.rows.find((r) => r.id === firstId);
      scBody = [
        h("strong", {}, "Same barcode as another product here"),
        first ? h("button", { type: "button", class: "link", onclick: () => openDrawer(first.id) }, `Show “${first.title || "untitled"}”`) : null,
      ];
      break;
    }
    case "checking":
      scBody = [h("strong", {}, "Checking your store…")];
      break;
    case "unchecked":
      scBody = [h("strong", {}, "Couldn't check your store"), h("button", { type: "button", class: "link", onclick: () => { row.checked = false; render(); runLookup(); } }, "Try again")];
      break;
    case "invalid":
      scBody = [h("strong", {}, "Fix the barcode to check your store")];
      break;
    case "missing":
    case "notitle":
      if (bc.status === "missing") {
        scBody = [h("strong", {}, "Can't check without a barcode"), "Without one, it could be added again later by mistake."];
        break;
      }
    // falls through
    default:
      sc.classList.add("is-ok");
      scIcon = "check";
      scBody = [h("strong", {}, "Not in your store yet"), "It'll be added as a new product."];
  }
  sc.replaceChildren(h("span", { class: "sc-icon" }, icon(scIcon, 16)), h("div", {}, ...scBody.filter(Boolean)));

  // Include toggle
  const inc = $("#dr-include");
  const selectable = SELECTABLE.has(status) && !state.creating;
  inc.disabled = !selectable;
  inc.checked = selectable && row.selected;

  const src = state.sources.find((s) => s.id === row.sourceId);
  $("#dr-source").replaceChildren(
    ...(src
      ? [
          src.kind === "manual" ? "Added by hand" : `From ${src.name}`,
          src.supplier?.trim() ? `. Supplier: ${src.supplier.trim()}` : ". No supplier chosen yet",
          src.importId ? `. Import ID ${src.importId}` : "",
          ".",
        ]
      : []),
  );

  $("#dr-remove").disabled = lock;

  // Footer: fix mode steps through issues
  const fix = state.drawer.fix;
  $("#dr-skip").hidden = !fix;
  if (fix) {
    const rest = fix.slice(fix.indexOf(row.id) + 1).filter((id) => {
      const r = state.rows.find((x) => x.id === id);
      return r && GROUP[snap.status.get(id)] === "attention";
    });
    $("#dr-done").textContent = rest.length ? "Next" : "Finish";
    $("#dr-skip").hidden = !rest.length;
  } else {
    $("#dr-done").textContent = "Done";
  }
}

function closeDrawerSilently() {
  state.drawer = null;
  $("#drawer").hidden = true;
  $("#scrim").hidden = true;
  document.body.style.overflow = "";
  renderActionBar(snapshot());
}

function stepDrawer(dir) {
  const snap = snapshot();
  const list = navList(snap);
  const i = list.indexOf(state.drawer.id);
  const next = list[i + dir];
  if (!next) return;
  normaliseBarcode();
  openDrawer(next);
}

function nextIssue({ skip = false } = {}) {
  normaliseBarcode();
  const snap = snapshot();
  const fix = state.drawer.fix;
  const at = fix.indexOf(state.drawer.id);
  const next = fix.slice(at + 1).find((id) => GROUP[snap.status.get(id)] === "attention");
  if (next) return openDrawer(next, { fix });
  closeDrawer();
  const left = snapshot().counts.attention;
  if (!left) toast("ok", "Everything's sorted. Nothing needs a look now.");
  else if (!skip) toast("info", `${plural(left, "product still needs", "products still need")} a look.`);
}

function startFix() {
  const snap = snapshot();
  const ids = state.rows.filter((r) => GROUP[snap.status.get(r.id)] === "attention").map((r) => r.id);
  if (!ids.length) return;
  openDrawer(ids[0], { fix: ids });
}

/** Restore leading zeros once someone has finished typing a barcode. */
function normaliseBarcode() {
  const row = drawerRow();
  if (!row) return;
  const bc = analyzeBarcode(row.barcode);
  if (bc.repaired) {
    row.barcode = bc.digits;
    row.barcodeNote = "Leading zero restored.";
    $("#dr-barcode").value = bc.digits;
  }
}

function wireDrawer() {
  $("#dr-close").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  $("#dr-prev").addEventListener("click", () => stepDrawer(-1));
  $("#dr-next").addEventListener("click", () => stepDrawer(1));
  $("#dr-done").addEventListener("click", () => (state.drawer?.fix ? nextIssue() : closeDrawer()));
  $("#dr-skip").addEventListener("click", () => nextIssue({ skip: true }));
  $("#dr-remove").addEventListener("click", () => {
    const row = drawerRow();
    if (!row) return;
    const snap = snapshot();
    const list = navList(snap);
    const i = list.indexOf(row.id);
    const next = list[i + 1] ?? list[i - 1];
    state.rows = state.rows.filter((r) => r !== row);
    if (state.drawer.fix) state.drawer.fix = state.drawer.fix.filter((id) => id !== row.id);
    toast("info", `Removed “${row.title || "untitled product"}” from the list.`, {
      action: ["Undo", () => { state.rows.splice(Math.min(i < 0 ? state.rows.length : i, state.rows.length), 0, row); render(); }],
    });
    if (next && next !== row.id) openDrawer(next);
    else closeDrawer();
  });

  $("#dr-name").addEventListener("input", (e) => {
    const row = drawerRow();
    if (!row) return;
    row.title = e.target.value.replace(/\s*\n\s*/g, " ");
    if (row.result?.status === "failed") row.result = null;
    scheduleRender();
  });
  $("#dr-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#dr-barcode").focus();
    }
  });
  $("#dr-code").addEventListener("input", (e) => {
    const row = drawerRow();
    if (!row) return;
    row.supplierCode = e.target.value;
    scheduleRender();
  });
  $("#dr-barcode").addEventListener("input", (e) => {
    const row = drawerRow();
    if (!row) return;
    row.barcode = e.target.value.trim();
    row.barcodeNote = "";
    row.inStore = null;
    row.checked = analyzeBarcode(row.barcode).key ? false : true;
    if (row.result?.status === "failed") row.result = null;
    scheduleRender();
    scheduleLookup();
  });
  $("#dr-barcode").addEventListener("blur", () => {
    normaliseBarcode();
    scheduleRender();
  });
  $("#dr-barcode").addEventListener("keydown", (e) => {
    // Barcode scanners type the digits then press Enter.
    if (e.key !== "Enter") return;
    e.preventDefault();
    normaliseBarcode();
    if (state.drawer?.fix) nextIssue();
    else stepDrawer(1);
  });
  $("#dr-desc-use").addEventListener("change", (e) => {
    const row = drawerRow();
    if (row) row.useDescription = e.target.checked;
    render();
  });
  $("#dr-include").addEventListener("change", (e) => {
    const row = drawerRow();
    if (row) row.selected = e.target.checked;
    render();
  });

  $("#drawer").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
    }
    if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      stepDrawer(e.key === "ArrowDown" ? 1 : -1);
    }
    if (e.key === "Tab") {
      // Keep focus inside the panel.
      const f = $$("button:not([disabled]):not([hidden]), input:not([disabled]), textarea, a[href]", $("#drawer")).filter((x) => x.offsetParent !== null);
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

/* =============================================================== toasts */

function toast(kind, text, { action, sticky = false, id } = {}) {
  const box = $("#toasts");
  if (id) box.querySelector(`[data-toast="${id}"]`)?.remove();
  const close = () => el.remove();
  const el = h(
    "div",
    { class: `toast is-${kind}`, role: kind === "bad" ? "alert" : "status", "data-toast": id ?? "" },
    h("span", { class: "t-icon" }, icon(kind === "ok" ? "check" : kind === "bad" ? "alert" : "alert", 18)),
    h("p", {}, text),
    action ? h("button", { type: "button", onclick: () => { action[1](); close(); } }, action[0]) : null,
    h("button", { type: "button", class: "t-x", "aria-label": "Dismiss", onclick: close }, icon("x", 15)),
  );
  if (kind === "info") $(".t-icon", el).replaceChildren(icon("alert", 18));
  box.append(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  if (!sticky) setTimeout(close, action ? 8000 : 5000);
  return el;
}

function sessionExpired() {
  if (state.sessionExpired) return;
  state.sessionExpired = true;
  toast("bad", "Your sign-in has expired. Reload to sign in again. Your list is kept.", {
    sticky: true,
    id: "session",
    action: ["Reload", () => location.reload()],
  });
  render();
}

function errorText(err) {
  if (err instanceof SessionExpired) {
    sessionExpired();
    return "Sign in again first.";
  }
  if (err instanceof ApiError || err instanceof FileProblem) return err.message;
  console.error(err);
  return "Something went wrong. Try again.";
}

/* =============================================================== saving the run */

let saveTimer = 0;
let saving = false;
let lastSaved = ""; // JSON last stored on the server, to skip saves when nothing changed
let pending = "";

/** What gets saved: invoices and products, without in-flight details. */
function runDataJson() {
  return JSON.stringify({
    sources: state.sources.map(({ cancelled, supplierSaving, ...s }) => s),
    rows: state.rows.map((r) => ({ ...r, adding: false })),
    store: state.store,
  });
}

/** Called on every render: saves shortly after anything in the run changes. */
function saveDraft() {
  if (state.view !== "run" || !state.run || state.saveState === "conflict") return;
  const json = runDataJson();
  if (json === lastSaved || json === pending) return;
  pending = json;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
  setSaveState("saving");
}

async function flushSave({ keepalive = false } = {}) {
  clearTimeout(saveTimer);
  if (!state.run || saving || !pending || pending === lastSaved) return;
  const run = state.run;
  const json = pending;
  saving = true;
  try {
    const res = await api.saveRun(run.code, run.version, json, keepalive && json.length < 60_000);
    run.version = res.version;
    run.updatedAt = res.updatedAt;
    lastSaved = json;
    if (pending === json) pending = "";
    setSaveState(pending ? "saving" : "saved");
  } catch (err) {
    if (err instanceof SessionExpired) {
      setSaveState("error");
      sessionExpired();
    } else if (err instanceof ApiError && err.body?.code === "version_conflict") {
      setSaveState("conflict");
      toast("bad", "Someone else changed this run since you opened it, so your latest changes weren't saved. Reload to see their version.", {
        sticky: true,
        id: "conflict",
        action: ["Reload", () => location.reload()],
      });
    } else if (err instanceof ApiError && err.body?.code === "invoice_has_products") {
      toast("bad", err.message, { sticky: true, id: "save-refused" });
      setSaveState("error");
      openRun(run.code, { quiet: true }); // put back what the server has
    } else {
      setSaveState("error");
      setTimeout(() => flushSave(), 5000); // try again shortly
    }
  } finally {
    saving = false;
    if (pending && pending !== lastSaved && state.saveState === "saving") saveTimer = setTimeout(flushSave, 800);
  }
}

function setSaveState(s) {
  state.saveState = s;
  const el = $("#save-state");
  if (!el) return;
  el.dataset.state = s;
  el.textContent = { saved: "Saved", saving: "Saving…", error: "Not saved yet, retrying", conflict: "Not saved, changed elsewhere" }[s];
}

addEventListener("pagehide", () => flushSave({ keepalive: true }));

function hasUnsaved() {
  return state.saveState !== "saved" && state.saveState !== "conflict" && state.view === "run";
}

/** Empty working state (used when leaving a run). */
function resetAll() {
  for (const s of state.sources) s.cancelled = true;
  closeDrawerSilently();
  state.rows = [];
  state.sources = [];
  state.filter = "all";
  state.sourceFilter = null;
  state.query = "";
  state.store = null;
  $("#search").value = "";
  lastSaved = pending = "";
}

/* =============================================================== runs: pages and navigation */

const fmtWhen = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `today at ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday at ${time}`;
  const opts = { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) };
  return `${d.toLocaleDateString("en-AU", opts)}, ${time}`;
};
const person = (email) => (email && email === state.health?.user ? "you" : email === "dev@local" ? "local test mode" : email);

function currentRoute() {
  const p = location.pathname.replace(/\/+$/, "") || "/";
  if (p === "/runs") return { view: "runs" };
  if (p === "/catalogues") return { view: "catalogues" };
  if (p === "/settings") return { view: "settings" };
  const c = p.match(/^\/catalogues\/(C\d+)$/i);
  if (c) return { view: "catalogue", code: c[1].toUpperCase() };
  const m = p.match(/^\/runs\/(R\d+)$/i);
  if (m) return { view: "run", code: m[1].toUpperCase() };
  return { view: "home" };
}

function busyReading() {
  return state.sources.some((s) => s.state === "reading" || s.state === "queued");
}

async function navigate(path, { replace = false } = {}) {
  if (path === location.pathname && !replace) return route();
  const leavingRun = state.view === "run" && !path.startsWith(`/runs/${state.run?.code}`);
  if (leavingRun) {
    if (state.creating) return toast("info", "Wait until the products have been added.");
    if (busyReading() && !confirm("An invoice is still being read. Leave this run anyway? It will be stopped.")) return;
    await flushSave();
  }
  if (catalogues.busy() && !confirm("A catalogue is still being saved. Leave anyway? It will stop part way.")) return;
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  route();
}

async function route() {
  const r = currentRoute();
  if (r.view === "run") {
    if (state.run?.code === r.code && state.view === "run") return render();
    return openRun(r.code);
  }
  if (state.view === "run") resetAll();
  if (state.view === "catalogue" && r.view !== "catalogue") catalogues.leave();
  state.run = null;
  state.view = r.view;
  setSaveState("saved");
  render();
  if (r.view === "home") loadRecent();
  if (r.view === "runs") loadRuns({ reset: true });
  if (r.view === "catalogues") catalogues.loadList();
  if (r.view === "catalogue") catalogues.showUpload(r.code);
  if (r.view === "settings") settingsPage.show();
  $("#account-menu").hidden = true;
  $("#avatar").setAttribute("aria-expanded", "false");
  window.scrollTo(0, 0);
}

/** Open a saved run from the server. */
async function openRun(code, { quiet = false } = {}) {
  if (!quiet) {
    resetAll();
    state.view = "loading";
    $("#loading-text").textContent = `Opening run ${code}…`;
    render();
  }
  try {
    const { run } = await api.getRun(code);
    const data = run.data ?? {};
    resetAll();
    state.run = { ...run, data: undefined };
    state.sources = (data.sources ?? []).map((s) =>
      // A file that was mid-read when the run was last saved can't continue.
      s.state === "reading" || s.state === "queued" ? { ...s, state: "failed", message: "Interrupted. Add this file again." } : s,
    );
    state.rows = (data.rows ?? []).map((r) => makeRow({ ...r, adding: false }));
    // Photos Shopify was still processing when this run was saved: look them up again.
    for (const r of state.rows) if (r.catalogue?.photos?.some((p) => p.status === "processing")) r.catKey = "";
    state.store = data.store ?? null;
    state.view = "run";
    lastSaved = runDataJson();
    pending = "";
    setSaveState("saved");
    render();
    if (state.rows.some((r) => r.checked === false)) scheduleLookup();
  } catch (err) {
    if (err instanceof SessionExpired) return sessionExpired();
    toast("bad", err instanceof ApiError && err.status === 404 ? `Run ${code} wasn't found.` : `Couldn't open run ${code}. ${errorText(err)}`);
    history.replaceState({}, "", "/");
    route();
  }
}

/** Start a new run for this session if there isn't one open yet. */
async function ensureRun() {
  if (state.view === "run" && state.run) return true;
  if (state.health && !state.health.runs) {
    toast("bad", state.health.runsError, { sticky: true, id: "runs" });
    return false;
  }
  try {
    const { run } = await api.createRun();
    resetAll();
    state.run = { ...run, data: undefined };
    state.view = "run";
    lastSaved = runDataJson();
    history.pushState({}, "", `/runs/${run.code}`);
    setSaveState("saved");
    render();
    return true;
  } catch (err) {
    if (err instanceof SessionExpired) sessionExpired();
    else toast("bad", `Couldn't start a new run. ${errorText(err)}`);
    return false;
  }
}

function renderCrumbs() {
  const code = state.view === "run" || state.view === "loading" ? state.run?.code ?? currentRoute().code : null;
  const crumb = $("#crumb-run");
  crumb.hidden = !code;
  $(".crumb-run-sep").hidden = !code;
  crumb.textContent = code ? `Run ${code}` : "";
  $("#nav-runs").classList.toggle("is-current", state.view === "runs");
  $("#nav-catalogues").classList.toggle("is-current", state.view === "catalogues" || state.view === "catalogue");
  if (state.view === "catalogue") return; // its page sets the title once loaded
  document.title = code
    ? `Run ${code} | Invoice Import`
    : state.view === "runs"
      ? "Runs | Invoice Import"
      : state.view === "catalogues"
        ? "Catalogues | Invoice Import"
        : state.view === "settings"
          ? "Settings | Invoice Import"
          : "Invoice Import";
}

function renderRunBar(snap) {
  const run = state.run;
  if (!run) return;
  const line = $("#run-line");
  line.replaceChildren(
    h("strong", {}, `Run ${run.code}`),
    `, started by ${person(run.createdBy)} ${fmtWhen(run.createdAt)}`,
    run.updatedBy && run.updatedBy !== run.createdBy ? `. Last changed by ${person(run.updatedBy)}` : "",
    ".",
  );
  const anyLive = state.sources.some((s) => liveCount(s) > 0);
  $("#run-delete").hidden = anyLive || !!state.creating;
  setSaveState(state.saveState);
}

async function deleteRun() {
  const run = state.run;
  if (!run || state.sources.some((s) => liveCount(s) > 0)) return;
  const ok = await confirmDialog({
    title: `Delete run ${run.code}?`,
    ok: "Delete run",
    danger: true,
    facts: [
      fact("trash", "Removes this run and its list of products. ", "Nothing in Shopify is touched."),
      fact("alert", "This can't be undone.", "", true),
    ],
  });
  if (!ok) return;
  try {
    await api.deleteRun(run.code);
    resetAll();
    state.view = "home";
    toast("ok", `Deleted run ${run.code}.`);
    navigate("/", { replace: true });
  } catch (err) {
    toast("bad", errorText(err));
  }
}

function runItem(r, compact = false) {
  const names = r.invoiceNames.length ? r.invoiceNames.slice(0, 3).join(", ") + (r.invoiceNames.length > 3 ? ` and ${r.invoiceNames.length - 3} more` : "") : "No invoices";
  const status = r.liveProducts
    ? h("span", { class: "badge badge-ok" }, `${fmt(r.liveProducts)} in Shopify`)
    : h("span", { class: "badge" }, "Nothing added");
  return h(
    "li",
    {},
    h(
      "a",
      { class: `run-item${compact ? " is-compact" : ""}`, href: `/runs/${r.code}`, "data-nav": "" },
      h("span", { class: "run-code" }, r.code),
      h(
        "span",
        { class: "run-main" },
        h("span", { class: "run-names" }, names),
        h(
          "span",
          { class: "run-meta" },
          `${person(r.createdBy)}, ${fmtWhen(r.createdAt)}`,
          r.suppliers.length ? h("span", {}, r.suppliers.join(", ")) : null,
        ),
      ),
      h("span", { class: "run-counts" }, h("span", { class: "run-products" }, plural(r.productCount, "product")), status),
      h("span", { class: "run-go", "aria-hidden": "true" }, icon("right", 16)),
    ),
  );
}

async function loadRecent() {
  const box = $("#recent");
  if (state.health && !state.health.runs) return (box.hidden = true);
  try {
    const { runs } = await api.listRuns({ limit: 5 });
    if (state.view !== "home") return;
    box.hidden = runs.length === 0;
    $("#recent-list").replaceChildren(...runs.map((r) => runItem(r, true)));
  } catch (err) {
    if (err instanceof SessionExpired) return sessionExpired();
    box.hidden = true;
  }
}

const runsPage = { next: null, loading: false, seq: 0 };

async function loadRuns({ reset = false } = {}) {
  if (state.health && !state.health.runs) {
    $("#runs-list").replaceChildren();
    const empty = $("#runs-empty");
    empty.hidden = false;
    empty.replaceChildren(h("strong", {}, "Run history isn't set up yet"), state.health.runsError);
    return;
  }
  const seq = ++runsPage.seq;
  const q = $("#runs-q").value.trim();
  const mine = $("#runs-mine").checked;
  const list = $("#runs-list");
  if (reset) {
    runsPage.next = null;
    list.setAttribute("aria-busy", "true");
  }
  $("#runs-more").disabled = true;
  try {
    const res = await api.listRuns({ q, mine, before: reset ? null : runsPage.next, limit: 30 });
    if (seq !== runsPage.seq || state.view !== "runs") return; // a newer search replaced this one
    const items = res.runs.map((r) => runItem(r));
    if (reset) list.replaceChildren(...items);
    else list.append(...items);
    runsPage.next = res.next;
    $("#runs-more").hidden = !res.next;
    const empty = $("#runs-empty");
    empty.hidden = list.childElementCount > 0;
    if (!empty.hidden) {
      empty.replaceChildren(
        h("strong", {}, q || mine ? "No runs match" : "No runs yet"),
        q || mine ? "Try a different search, or turn off Only mine." : "Runs appear here once someone imports an invoice.",
      );
    }
  } catch (err) {
    if (err instanceof SessionExpired) return sessionExpired();
    toast("bad", `Couldn't load runs. ${errorText(err)}`);
  } finally {
    list.removeAttribute("aria-busy");
    $("#runs-more").disabled = false;
  }
}

/* =============================================================== invoices in */

async function addFiles(list) {
  const files = [...list];
  if (!files.length) return;
  if (state.sessionExpired) return sessionExpired();
  if (state.view === "catalogues") return catalogues.startUpload(files);
  if (state.view === "catalogue") return toast("info", "To add a catalogue, go to Catalogues and choose Add a catalogue.");
  if (state.view === "runs" || state.view === "loading") return toast("info", "Open a run, or start a new import from the home page, to add invoices.");
  if (!(await ensureRun())) return;
  for (const file of files) {
    const src = { id: uid("s"), name: file.name, kind: kindOf(file.name), state: "queued", message: "", supplier: "" };
    state.sources.push(src);
    // One at a time: stays inside the AI's free per-minute limit and keeps invoice order.
    state.queue = state.queue.then(() => readInvoice(file, src));
  }
  if (state.filter === "added" || state.filter === "store") state.filter = "all";
  render();
}

async function readInvoice(file, src) {
  if (src.cancelled) return;
  if (state.sessionExpired) {
    Object.assign(src, { state: "failed", message: "Not read. Sign in again first." });
    return render();
  }
  try {
    Object.assign(src, { state: "reading", message: "Preparing the file…" });
    render();
    const prepared = await prepare(file);
    if (src.cancelled) return;
    src.message = "Reading the invoice…";
    render();
    // Google's free tier is sometimes overloaded. Try up to 3 times; from the 2nd try the server
    // switches to the backup model, which usually has room.
    const WAITS = [0, 4000, 10000];
    let res;
    for (let attempt = 1; attempt <= WAITS.length; attempt++) {
      try {
        res =
          prepared.kind === "text"
            ? await api.extractText(file.name, prepared.text, attempt)
            : await api.extractFile(file.name, prepared.mimeType, prepared.base64, attempt);
        break;
      } catch (err) {
        const retry = err instanceof ApiError && err.body?.retryable && attempt < WAITS.length;
        if (!retry || src.cancelled) throw err;
        const secs = Math.round(WAITS[attempt] / 1000);
        src.message = `The AI is busy. Trying again in ${secs}s (try ${attempt + 1} of ${WAITS.length})…`;
        render();
        await new Promise((r) => setTimeout(r, WAITS[attempt]));
        src.message = `Reading the invoice (try ${attempt + 1} of ${WAITS.length})…`;
        render();
      }
    }

    if (src.cancelled) return; // removed from the list while it was being read
    for (const r of res.rows) {
      state.rows.push(
        makeRow({
          sourceId: src.id,
          title: r.title,
          aiTitle: r.invoiceTitle ? r.title : "",
          invoiceTitle: r.invoiceTitle ?? "",
          supplierCode: r.supplierCode ?? "",
          barcode: r.barcodeRepaired && r.barcode ? analyzeBarcode(r.barcode).digits : (r.barcode ?? ""),
          barcodeNote: r.barcodeRepaired ? `The invoice said ${r.barcode}. Leading zero restored.` : "",
          inStore: r.match === "exists" ? r.existing : null,
          selected: r.match === "new" && r.barcodeStatus === "valid",
        }),
      );
    }
    state.store = res.store;
    const fromInvoice = res.invoice?.supplierName ?? "";
    const matched = fromInvoice ? matchSupplier(fromInvoice, state.suppliers) : null;
    Object.assign(src, {
      state: "done",
      message: "",
      supplierFromInvoice: fromInvoice,
      invoiceNumber: res.invoice?.invoiceNumber ?? "",
    });
    if (!(src.supplier ?? "").trim() && matched) Object.assign(src, { supplier: matched, supplierAuto: true });
    if (!res.rows.length) {
      Object.assign(src, { state: "failed", message: "No products found in this file." });
      toast("bad", `No products found in ${file.name}. Check it's an invoice, or add products by hand.`);
    }
  } catch (err) {
    if (src.cancelled) return;
    const msg = errorText(err);
    Object.assign(src, { state: "failed", message: msg });
    if (!(err instanceof SessionExpired)) {
      toast("bad", `Couldn't read ${file.name}. ${msg}`, { action: ["Add by hand", addManual] });
    }
  }
  render();
}

async function addManual() {
  if (!(await ensureRun())) return;
  let src = state.sources.find((s) => s.id === "manual");
  if (!src) {
    src = { id: "manual", name: "Added by hand", kind: "manual", state: "done", message: "", supplier: "" };
    state.sources.push(src);
  }
  const row = makeRow({ sourceId: "manual" });
  state.rows.push(row);
  render();
  openDrawer(row.id, { focus: "#dr-name" });
}

/* =============================================================== store checks */

let lookupTimer = 0;
function scheduleLookup() {
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(runLookup, 450);
}

async function runLookup() {
  const pending = state.rows.filter((r) => r.checked === false && analyzeBarcode(r.barcode).key);
  for (let i = 0; i < pending.length; i += 50) {
    const batch = pending.slice(i, i + 50);
    const sent = new Map(batch.map((r) => [r.id, r.barcode]));
    try {
      const res = await api.lookup(batch.map(({ id, title, supplierCode, barcode }) => ({ id, title, supplierCode, barcode })));
      const byId = new Map(res.rows.map((r) => [r.id, r]));
      for (const row of batch) {
        const hit = byId.get(row.id);
        if (!hit || sent.get(row.id) !== row.barcode) continue; // changed again meanwhile
        row.inStore = hit.match === "exists" ? hit.existing : null;
        row.checked = true;
        if (!row.inStore && row.title.trim()) row.selected = true;
      }
    } catch (err) {
      if (err instanceof SessionExpired) return sessionExpired();
      for (const row of batch) if (row.checked === false) row.checked = "error";
    }
  }
  render();
}

async function recheck() {
  const rows = state.rows.filter((r) => r.result?.status !== "created");
  if (!rows.length) return;
  const btn = $("#recheck");
  btn.disabled = true;
  btn.classList.add("is-spinning");
  try {
    for (let i = 0; i < rows.length; i += 2000) {
      const batch = rows.slice(i, i + 2000);
      const res = await api.match(batch.map(({ id, title, supplierCode, barcode }) => ({ id, title, supplierCode, barcode })));
      const byId = new Map(res.rows.map((r) => [r.id, r]));
      for (const row of batch) {
        const hit = byId.get(row.id);
        if (!hit) continue;
        row.inStore = hit.match === "exists" ? hit.existing : null;
        row.checked = true;
      }
      state.store = res.store;
    }
    toast("ok", "Checked every product against your store again.");
  } catch (err) {
    toast("bad", errorText(err));
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-spinning");
    render();
  }
}

/* =============================================================== adding to Shopify */

function fact(iconName, strong, rest, warn = false) {
  return h("li", { class: warn ? "is-warn" : "" }, h("span", { class: "fact-icon" }, icon(iconName, 16)), h("span", {}, h("strong", {}, strong), rest));
}

function confirmDialog({ title, facts, ok, danger = false }) {
  const dlg = $("#confirm");
  $("#cf-title").textContent = title;
  const btn = $("#cf-ok");
  btn.textContent = ok;
  btn.className = `btn ${danger ? "btn-danger-solid" : "btn-brand"}`;
  $("#cf-facts").replaceChildren(...facts.filter(Boolean));
  dlg.returnValue = "";
  dlg.showModal();
  (danger ? $("#confirm .btn-secondary") : btn).focus();
  return new Promise((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok"), { once: true }));
}

function confirmAdd(count, noBarcode, groups, withPhotos = 0) {
  const what = count === 1 ? "1 product" : `${fmt(count)} products`;
  const supplierText = groups.map((g) => (groups.length > 1 ? `${g.supplier} (${g.count})` : g.supplier)).join(", ");
  return confirmDialog({
    title: `Add ${what} to Shopify?`,
    ok: `Add ${what}`,
    facts: [
      fact("store", "On Point of Sale straight away. ", "Not on your online store."),
      fact("alert", "Priced at $0.00. ", "Set prices in the POS app before selling."),
      fact("scan", "In-store only. ", "Not shippable, and stock isn't tracked."),
      fact("hand", `Supplier: ${supplierText}. `, groups.length > 1 ? "Each invoice gets its own import ID." : `Import ID ${groups[0].importId}.`),
      withPhotos ? fact("image", `${withPhotos === count ? (count === 1 ? "It gets" : "All get") : `${fmt(withPhotos)} get`} photos `, "from your supplier catalogues.") : null,
      noBarcode
        ? fact("alert", `${noBarcode === 1 ? "1 product has" : `${fmt(noBarcode)} products have`} no barcode, `, `so the till can't scan ${noBarcode === 1 ? "it" : "them"} yet.`, true)
        : null,
    ],
  });
}

async function addSelected() {
  if (state.creating) return;
  const snap = snapshot();
  const chosen = chosenRows(snap);
  if (!chosen.length) return;

  // Every invoice needs a supplier first: take staff straight to the box.
  const missing = sourcesMissingSupplier(chosen);
  if (missing.length) {
    state.sourceFilter = null;
    render();
    const input = $(`#sup-${CSS.escape(missing[0].id)}`);
    input?.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
    input?.focus();
    toast("info", `Choose who supplied ${missing[0].name} first.`);
    return;
  }

  // One import ID per invoice, made the first time its products are added.
  const groups = [];
  for (const src of state.sources) {
    const n = chosen.filter((r) => r.sourceId === src.id).length;
    if (!n) continue;
    src.importId ??= makeImportId(src.supplier, state.run.code);
    groups.push({ supplier: src.supplier.trim(), importId: src.importId, count: n });
  }
  const bySource = new Map(state.sources.map((s) => [s.id, s]));

  const noBarcode = chosen.filter((r) => snap.status.get(r.id) === "missing").length;
  const withPhotos = chosen.filter((r) => rowPhotos(r).length).length;
  if (!(await confirmAdd(chosen.length, noBarcode, groups, withPhotos))) return;

  closeDrawerSilently();
  const size = state.health?.maxCreateBatch ?? 15;
  state.creating = { done: 0, total: chosen.length };
  const tally = { created: 0, skipped: 0, failed: 0, notOnPos: 0, photos: 0, photoErrors: 0 };
  render();

  for (let i = 0; i < chosen.length; i += size) {
    const batch = chosen.slice(i, i + size);
    batch.forEach((r) => (r.adding = true));
    render();
    try {
      const res = await api.create(
        state.run.code,
        batch.map(({ id, title, supplierCode, barcode, sourceId, photos, catalogue, useDescription }) => ({
          id,
          title,
          supplierCode,
          barcode,
          photos: catalogue ? photos : [],
          description: catalogue?.description && useDescription !== false ? catalogue.description : null,
          invoiceId: sourceId,
          vendor: bySource.get(sourceId)?.supplier.trim() || null,
          importId: bySource.get(sourceId)?.importId ?? null,
        })),
      );
      const byId = new Map(res.results.map((r) => [r.id, r]));
      for (const row of batch) {
        const r = byId.get(row.id);
        row.adding = false;
        if (r?.status === "created") {
          row.result = { status: "created", productId: r.productId };
          row.selected = false;
          tally.created++;
          if (r.photos) tally.photos++;
          if (r.photoError) tally.photoErrors++;
          if (r.publishedToPos === false) tally.notOnPos++;
        } else if (r?.status === "skipped") {
          row.selected = false;
          if (r.existing) row.inStore = r.existing;
          tally.skipped++;
        } else {
          row.result = { status: "failed", error: r?.error ?? "No answer from Shopify. Check Shopify before trying again." };
          tally.failed++;
        }
      }
      if (res.ledgerError) toast("bad", res.ledgerError, { sticky: true, id: "ledger" });
      if (res.posChannelFound === false) {
        toast("bad", "The Point of Sale channel wasn't found, so new products aren't on POS yet. Make them available to Point of Sale in Shopify.", { sticky: true, id: "pos" });
      }
    } catch (err) {
      batch.forEach((r) => (r.adding = false));
      if (err instanceof SessionExpired) {
        sessionExpired();
        break;
      }
      const msg = errorText(err);
      for (const row of batch) {
        // A dropped connection may still have created some. "Check again" finds them before a retry.
        row.result = { status: "failed", error: `${msg} Use Check again before retrying, in case some were added.` };
        tally.failed++;
      }
    }
    state.creating.done = Math.min(chosen.length, i + batch.length);
    render();
  }

  state.creating = null;
  render();
  if (tally.photoErrors) {
    toast("bad", `${plural(tally.photoErrors, "product was", "products were")} added without photos because Shopify refused them. Add the photos in Shopify, or try Fill in missing photos on the Catalogues page.`, { sticky: true });
  }
  showDone(tally, groups);
}

/* =============================================================== undo an import */

async function undoImport(src) {
  const rows = sourceRows(src).filter((r) => r.result?.status === "created");
  if (!rows.length || !src.importId || state.undoing) return;
  const n = plural(rows.length, "product");
  const ok = await confirmDialog({
    title: `Undo import ${src.importId}?`,
    ok: `Delete ${n}`,
    danger: true,
    facts: [
      fact("trash", `Deletes the ${n} `, `added to Shopify from ${src.name}.`),
      fact("check", "Products that already have a price are kept, ", "so nobody's work is lost."),
      fact("alert", "Deleted products can't be brought back. ", "They stay in this list, so you can fix them and add them again.", true),
    ],
  });
  if (!ok) return;

  state.undoing = src.id;
  render();
  const size = state.health?.maxUndoBatch ?? 20;
  const tally = { deleted: 0, priced: 0, other: 0, failed: 0 };
  try {
    for (let i = 0; i < rows.length; i += size) {
      const batch = rows.slice(i, i + size);
      const res = await api.undo(src.importId, batch.map((r) => r.result.productId));
      const byId = new Map(res.results.map((r) => [r.id, r]));
      for (const row of batch) {
        const r = byId.get(row.result.productId);
        if (r?.status === "deleted" || (r?.status === "kept" && r.reason === "gone")) {
          // Back to "New", ready to be fixed and added again.
          Object.assign(row, { result: null, selected: false, inStore: null, checked: true });
          tally.deleted++;
        } else if (r?.status === "kept" && r.reason === "priced") tally.priced++;
        else if (r?.status === "kept") tally.other++;
        else tally.failed++;
      }
    }
  } catch (err) {
    toast("bad", `The undo stopped part way. ${errorText(err)} Press Undo import again to finish.`);
  } finally {
    state.undoing = null;
    if (state.run) {
      state.run.liveByInvoice = { ...state.run.liveByInvoice, [src.id]: sourceRows(src).filter((r) => r.result?.status === "created").length };
    }
    render();
  }
  const parts = [`Deleted ${plural(tally.deleted, "product")} from Shopify.`];
  if (tally.priced) parts.push(`${plural(tally.priced, "was", "were")} kept because ${tally.priced === 1 ? "it already has" : "they already have"} a price.`);
  if (tally.other) parts.push(`${plural(tally.other, "was", "were")} kept because ${tally.other === 1 ? "it no longer belongs" : "they no longer belong"} to this import.`);
  if (tally.failed) parts.push(`${plural(tally.failed, "couldn't", "couldn't")} be deleted. Try again.`);
  toast(tally.failed ? "bad" : "ok", parts.join(" "), { sticky: tally.priced + tally.other + tally.failed > 0 });
}

function showDone({ created, skipped, failed, notOnPos, photos = 0 }, groups = []) {
  const dlg = $("#done");
  const mark = $("#dn-mark");
  mark.className = `done-mark${failed || notOnPos ? " is-partial" : ""}`;
  mark.replaceChildren(icon(failed || notOnPos ? "alert" : "check", 30));
  $("#dn-title").textContent = created === 0 ? "Nothing was added" : created === 1 ? "1 product added" : `${fmt(created)} products added`;
  const bits = [];
  if (created && notOnPos < created) bits.push("They're on Point of Sale now. Set their prices in the POS app.");
  if (photos) bits.push(`${photos === created ? (created === 1 ? "It has" : "All have") : `${fmt(photos)} have`} photos from the catalogue.`);
  if (notOnPos) bits.push(`${plural(notOnPos, "was", "were")} created but couldn't be put on Point of Sale. In Shopify, open ${notOnPos === 1 ? "it" : "them"} and turn on the Point of Sale channel.`);
  if (skipped) bits.push(`${plural(skipped, "was", "were")} already in your store, so ${skipped === 1 ? "it was" : "they were"} skipped.`);
  if (failed) bits.push(`${plural(failed, "product", "products")} couldn't be added. ${failed === 1 ? "It's" : "They're"} under Needs a look.`);
  $("#dn-sub").textContent = bits.join(" ");
  $("#dn-ids").replaceChildren(
    ...(created
      ? groups.map((g) =>
          h(
            "button",
            { type: "button", class: "import-id", title: "Copy import ID", onclick: () => copyText(g.importId, "Import ID copied.") },
            h("span", { class: "import-id-label" }, g.supplier),
            h("span", { class: "mono" }, g.importId),
          ),
        )
      : []),
  );

  const newBtn = $("#dn-new");
  const reviewBtn = $("#dn-review");
  if (failed) {
    newBtn.textContent = "Review what's left";
    newBtn.value = "fix";
    reviewBtn.textContent = "Close";
    reviewBtn.value = "close";
  } else {
    newBtn.textContent = "Start a new import";
    newBtn.value = "new";
    reviewBtn.textContent = "See added products";
    reviewBtn.value = "added";
  }
  dlg.returnValue = "";
  dlg.showModal();
  dlg.addEventListener(
    "close",
    () => {
      const v = dlg.returnValue;
      if (v === "new") {
        navigate("/"); // this run stays saved and can be opened from Runs
      } else if (v === "fix") {
        state.filter = "attention";
        render();
        startFix();
      } else if (v === "added") {
        state.filter = "added";
        render();
      }
    },
    { once: true },
  );
}

/* =============================================================== start up */

const settingsPage = createSettings({ api, h, $, icon, toast, confirmDialog, fact, errorText, plural, state, SessionExpired, sessionExpired: () => sessionExpired() });

const catalogues = createCatalogues({
  api,
  h,
  $,
  icon,
  toast,
  confirmDialog,
  fact,
  errorText,
  plural,
  fmt,
  fmtWhen,
  person,
  findExisting,
  matchSupplier,
  state,
  SessionExpired,
  ApiError,
  sessionExpired: () => sessionExpired(),
});

async function checkHealth() {
  try {
    const hl = await api.health();
    state.health = hl;
    const email = hl.user && hl.user !== "dev@local" ? hl.user : null;
    $("#avatar").textContent = email ? email.split("@")[0].split(/[._-]/).map((p) => p[0]).join("").slice(0, 2).toUpperCase() : "T";
    $("#menu-email").textContent = email ? `Signed in as ${email}` : "Local test mode";
    if (!email) $("#signout").hidden = true;
    if (!hl.ai) toast("bad", "The invoice reader isn't set up, so files can't be read yet. You can still add products by hand.", { sticky: true, id: "ai" });
    if (!hl.runs) toast("bad", hl.runsError, { sticky: true, id: "runs" });
    if (!hl.shopify) {
      toast("bad", `Shopify isn't connected, so products can't be checked or added. ${hl.shopifyError ?? ""}`.trim(), { sticky: true, id: "shopify" });
    }
    else if (!hl.posChannel) toast("bad", "The Point of Sale channel wasn't found. New products would be created but not shown on POS.", { sticky: true, id: "pos" });
    if (state.view === "settings") settingsPage.renderToggles();
  } catch (err) {
    if (err instanceof SessionExpired) return sessionExpired();
    $("#conn").dataset.state = "bad";
    $(".conn-text").textContent = "Offline";
    // Show the server's own reason when there is one; only a real network failure gets the generic message.
    const msg = err instanceof ApiError && err.status ? err.message : "Can't reach the server. Check the internet connection, then reload.";
    toast("bad", msg, { sticky: true, action: ["Reload", () => location.reload()] });
  }
  render();
}

function wire() {
  for (const el of $$("[data-icon]")) {
    const size = el.classList.contains("dz-icon") ? 36 : el.closest(".btn-lg") ? 20 : el.closest(".btn-sm") ? 15 : 18;
    el.replaceChildren(icon(el.dataset.icon, size));
  }

  for (const id of ["#pick", "#pick-more"]) {
    const inp = $(id);
    inp.accept = ACCEPT;
    inp.addEventListener("change", () => {
      addFiles(inp.files);
      inp.value = "";
    });
  }
  const cam = $("#camera");
  cam.addEventListener("change", () => {
    addFiles(cam.files);
    cam.value = "";
  });

  // Whole-window drag and drop
  const dz = $("#dropzone");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    dz.hidden = false;
  });
  addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) dz.hidden = true;
  });
  addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dz.hidden = true;
    addFiles(e.dataTransfer.files);
  });

  // List interactions
  const body = $("#list-body");
  body.addEventListener("click", (e) => {
    const item = e.target.closest(".item[data-id]");
    if (!item) return;
    const row = state.rows.find((r) => r.id === item.dataset.id);
    if (!row) return;
    if (e.target.closest(".item-sel")) {
      const cb = $(".check", item);
      if (cb.disabled) return;
      row.selected = e.target === cb ? cb.checked : !row.selected;
      render();
      return;
    }
    if (e.target.closest("a")) return;
    openDrawer(row.id);
  });
  body.addEventListener("keydown", (e) => {
    const item = e.target.closest(".item[data-id]");
    if (!item) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const sib = e.key === "ArrowDown" ? item.nextElementSibling : item.previousElementSibling;
      if (sib?.dataset.id) sib.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      openDrawer(item.dataset.id);
    } else if (e.key === " ") {
      e.preventDefault();
      const row = state.rows.find((r) => r.id === item.dataset.id);
      const cb = $(".check", item);
      if (row && !cb.disabled) {
        row.selected = !row.selected;
        render();
      }
    }
  });

  $("#select-all").addEventListener("change", (e) => {
    const snap = snapshot();
    for (const r of visibleRows(snap.status)) if (SELECTABLE.has(snap.status.get(r.id))) r.selected = e.target.checked;
    render();
  });

  $("#filters").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = FILTERS.findIndex(([k]) => k === state.filter);
    const n = FILTERS[(i + (e.key === "ArrowRight" ? 1 : FILTERS.length - 1)) % FILTERS.length][0];
    setFilter(n);
  });

  let searchTimer = 0;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value;
      render();
    }, 120);
  });

  $("#recheck").addEventListener("click", recheck);
  $("#add-manual").addEventListener("click", addManual);
  $("#manual-start").addEventListener("click", addManual);
  $("#fix-start").addEventListener("click", startFix);
  $("#ab-add").addEventListener("click", addSelected);
  $("#ab-clear").addEventListener("click", () => {
    for (const r of state.rows) r.selected = false;
    render();
  });

  // Account menu
  const av = $("#avatar");
  const menu = $("#account-menu");
  const setMenu = (open) => {
    menu.hidden = !open;
    av.setAttribute("aria-expanded", String(open));
  };
  av.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenu(menu.hidden);
  });
  addEventListener("click", (e) => !menu.contains(e.target) && setMenu(false));
  addEventListener("keydown", (e) => e.key === "Escape" && !menu.hidden && (setMenu(false), av.focus()));

  // Ctrl/Cmd + Enter adds the selected products from anywhere.
  addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("#confirm").open && !$("#done").open) {
      e.preventDefault();
      addSelected();
    }
  });

  // In-app links (data-nav) change the page without reloading it.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-nav]");
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(new URL(a.href).pathname);
  });
  addEventListener("popstate", () => route());

  // Runs page
  let runsTimer = 0;
  $("#runs-q").addEventListener("input", () => {
    clearTimeout(runsTimer);
    runsTimer = setTimeout(() => loadRuns({ reset: true }), 250);
  });
  $("#runs-mine").addEventListener("change", () => loadRuns({ reset: true }));
  $("#runs-more").addEventListener("click", () => loadRuns());
  $("#run-delete").addEventListener("click", deleteRun);

  addEventListener("beforeunload", (e) => {
    if (hasUnsaved() || busyReading() || catalogues.busy()) {
      e.preventDefault();
      e.returnValue = "";
    }
    if (state.creating) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  wireDrawer();
  catalogues.wire();
  settingsPage.wire();
}

wire();
route();
checkHealth().then(() => {
  if (state.health?.shopify) loadSuppliers();
  if (state.rows.some((r) => r.checked === false)) scheduleLookup();
});
