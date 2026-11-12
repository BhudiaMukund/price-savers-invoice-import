// Set prices: the products this tool added, each with a price box. One page per run (/runs/R2/prices) and one for
// everything still at $0.00 across all runs (/prices). Prices include GST. Saving only changes prices.
//
// Built for speed on a phone as much as at a desk: big photos (tap to zoom), a price box that saves on its own when
// you press Enter or move on, search by title, code or barcode, and a one-at-a-time view with the number keypad up.

/** "4.5" → "4.50"; null when it isn't a price above $0. Mirrors the server's check. */
export function parsePrice(v) {
  const s = String(v ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n.toFixed(2) : null;
}

/** Prices pasted from a spreadsheet column: one per line (or tab), blank lines kept as "skip this product". */
export function splitPasted(text) {
  const parts = String(text ?? "").replace(/\r/g, "").split(/\n|\t/);
  while (parts.length && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.map((p) => p.trim());
}

/** Does a product match what was typed in the search box? Title words, supplier code, or barcode digits. */
export function matchesQuery(p, q) {
  const s = String(q ?? "").trim().toLowerCase();
  if (!s) return true;
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 6 && /^[\d\s-]+$/.test(s)) return String(p.barcode ?? "").replace(/\D/g, "").includes(digits);
  const hay = `${p.title ?? ""} ${p.sku ?? ""} ${p.barcode ?? ""} ${p.vendor ?? ""}`.toLowerCase();
  return s.split(/\s+/).every((w) => hay.includes(w));
}

const MAX_ROWS = 2000;
const BATCH = 40;
const SAVE_DELAY = 700;
const VIEW_KEY = "price-view";

export function createPricing(ctx) {
  const { api, h, $, icon, toast, errorText, plural, state, SessionExpired, sessionExpired } = ctx;
  const fmt = (n) => Number(n).toLocaleString("en-AU");
  let scope = { run: "" }; // run code, or "" for every run
  /** { p, value, status: "" | "queued" | "saving" | "saved" | "error", error, el, input } */
  let rows = [];
  let showPriced = false;
  let query = "";
  let view = "list";
  let loading = false;
  let seq = 0;
  const queue = new Set();
  let flushTimer = 0;
  let flushing = false;
  const balloons = { online: 0, repriced: 0, errors: [] };
  let quick = null; // the one-at-a-time view's elements, made once so the keypad stays up between products
  let quickAt = null; // the row on show there

  const isUnpriced = (r) => r.p.price === "0.00";
  const editable = (r) => r.p.price !== null; // one variant only
  const busy = () => queue.size > 0 || flushing;
  const dirty = busy;

  function readView() {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === "list" || v === "quick") return v;
    } catch {
      /* private window: fall through */
    }
    return matchMedia("(max-width: 640px)").matches ? "quick" : "list";
  }

  async function show(opts) {
    scope = { run: opts?.run ?? "" };
    showPriced = false;
    query = "";
    rows = [];
    quickAt = null;
    history = [];
    view = readView();
    $("#price-show-priced").checked = false;
    $("#price-search").value = "";
    const run = scope.run;
    $("#price-title").textContent = run ? `Prices for run ${run}` : "Unpriced products";
    $("#price-sub").textContent = run
      ? "Every product this run added. Prices include GST and save as you go. Anything left blank stays at $0.00."
      : "Everything this tool added that is still at $0.00, newest run first. Prices include GST and save as you go.";
    const back = $("#price-back");
    back.href = run ? `/runs/${run}` : "/runs";
    back.querySelector(".back-text").textContent = run ? `Back to run ${run}` : "All runs";
    $("#price-priced-label").hidden = !run;
    document.title = run ? `Prices for ${run} | Invoice Import` : "Unpriced products | Invoice Import";
    await load();
  }

  async function load() {
    const my = ++seq;
    loading = true;
    renderAll();
    let after = 0;
    try {
      for (let page = 0; page < 60 && rows.length < MAX_ROWS; page++) {
        const res = await api.pricing({ run: scope.run, after });
        if (my !== seq) return;
        for (const p of res.products) {
          if (!scope.run && p.price !== "0.00") continue; // the all-runs page is only the unpriced ones
          rows.push({ p, value: "", status: "", error: "" });
        }
        renderAll();
        if (res.next == null) break;
        after = res.next;
      }
      loading = false;
      $("#price-error").hidden = true;
    } catch (err) {
      if (my !== seq) return;
      loading = false;
      if (err instanceof SessionExpired) return sessionExpired();
      $("#price-error").hidden = false;
      $("#price-error").textContent = errorText(err);
    }
    renderAll();
  }

  const runNo = (r) => Number(String(r.p.run ?? "").replace(/\D/g, "")) || 0;

  /** The rows on show, in order: on the all-runs page grouped by run, newest run first. */
  function visible() {
    const vis = rows.filter((r) => (showPriced || isUnpriced(r) || r.status) && matchesQuery(r.p, query));
    return scope.run ? vis : vis.map((r, i) => [r, i]).sort((a, b) => runNo(b[0]) - runNo(a[0]) || a[1] - b[1]).map(([r]) => r);
  }

  /** Still to price, in the order shown: what Enter and the one-at-a-time view step through. */
  const todo = () => visible().filter((r) => editable(r) && (showPriced || (isUnpriced(r) && r.status !== "saved" && r.status !== "saving" && r.status !== "queued")));

  /* ------------------------------------------------------------ saving as you go */

  /** Take a typed price for a row: save it shortly, together with any others typed meanwhile. */
  function commit(r, raw) {
    r.draft = undefined;
    const text = String(raw ?? "").trim();
    if (text === "") {
      if (r.status === "error") setStatus(r, "", "");
      r.value = "";
      return true;
    }
    const v = parsePrice(text);
    if (!v) {
      r.value = text;
      setStatus(r, "error", "Enter a price like 4.95.");
      return false;
    }
    if (v === r.value && (r.status === "queued" || r.status === "saving")) return true; // already on its way
    r.value = v;
    if (v === r.p.price && r.status !== "error") return true; // no change
    queue.add(r);
    setStatus(r, "queued", "");
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, queue.size >= BATCH ? 0 : SAVE_DELAY);
    return true;
  }

  async function flush() {
    if (flushing || !queue.size) return;
    flushing = true;
    const batch = [...queue].slice(0, BATCH);
    for (const r of batch) {
      queue.delete(r);
      setStatus(r, "saving", "");
    }
    updateStatus();
    try {
      const res = await api.setPrices(batch.map((r) => ({ productId: r.p.productId, price: r.value })));
      const by = new Map(res.results.map((x) => [x.productId, x]));
      for (const r of batch) {
        if (queue.has(r)) continue; // typed again while saving: the newer price goes next
        const x = by.get(r.p.productId);
        if (x?.ok) {
          r.p = { ...r.p, price: x.price };
          setStatus(r, "saved", "");
        } else setStatus(r, "error", x?.error ?? "Not saved. Try again.");
      }
      if (res.balloons) {
        balloons.online += res.balloons.online ?? 0;
        balloons.repriced += res.balloons.repriced ?? 0;
        balloons.errors.push(...(res.balloons.errors ?? []), ...(res.balloons.error ? [res.balloons.error] : []));
      }
    } catch (err) {
      if (err instanceof SessionExpired) {
        flushing = false;
        return sessionExpired();
      }
      for (const r of batch) if (!queue.has(r)) setStatus(r, "error", `Not saved: ${errorText(err)}`);
    } finally {
      flushing = false;
    }
    if (queue.size) flush();
    updateStatus();
    updateProgress();
  }

  function setStatus(r, status, error) {
    r.status = status;
    r.error = error;
    if (r.el) paintRow(r);
    if (quickAt === r) paintQuickState();
  }

  /** The bar at the bottom: saving, saved, or what needs fixing. */
  function updateStatus() {
    const el = $("#price-status");
    const saving = rows.filter((r) => r.status === "saving" || r.status === "queued").length;
    const errors = rows.filter((r) => r.status === "error").length;
    const saved = rows.filter((r) => r.status === "saved").length;
    el.hidden = !saving && !errors && !saved;
    el.className = `price-status${errors ? " is-bad" : saving ? " is-busy" : " is-ok"}`;
    const extra = [balloons.repriced ? plural(balloons.repriced, "helium bundle") + " priced" : "", balloons.online ? plural(balloons.online, "foil balloon") + " now online" : ""].filter(Boolean).join(", ");
    el.replaceChildren(
      saving ? h("span", { class: "spinner" }) : icon(errors ? "alert" : "check", 16),
      h(
        "span",
        {},
        saving
          ? `Saving ${plural(saving, "price")}…`
          : errors
            ? `${plural(errors, "price")} not saved. The reason is under ${errors === 1 ? "it" : "each one"}.`
            : `${plural(saved, "price")} saved${extra ? `. ${extra[0].toUpperCase()}${extra.slice(1)}` : ""}.`,
      ),
    );
    if (balloons.errors.length) {
      toast("bad", `Some helium bundles weren't updated: ${balloons.errors[0]} Open Helium bundles below and press Update.`, { sticky: true, id: "balloons" });
      balloons.errors = [];
    }
  }

  function updateProgress() {
    const total = rows.length;
    const priced = rows.filter((r) => !isUnpriced(r)).length;
    const box = $("#price-progress");
    box.hidden = !total && !loading;
    const sum = $("#price-summary");
    if (loading && !total) sum.textContent = "Loading products…";
    else if (scope.run) sum.replaceChildren(h("strong", {}, fmt(priced)), ` of ${plural(total, "product")} priced${loading ? ", loading more…" : ""}`);
    else sum.replaceChildren(h("strong", {}, fmt(total - priced)), ` still at $0.00${priced ? `, ${fmt(priced)} priced here` : ""}${loading ? ", loading more…" : ""}`);
    $("#price-meter-fill").style.width = total ? `${Math.round((priced / total) * 100)}%` : "0";
  }

  /* ------------------------------------------------------------ the list */

  function renderAll() {
    $("#price-page").classList.toggle("is-quick", view === "quick");
    $("#price-view-list").setAttribute("aria-pressed", String(view === "list"));
    $("#price-view-quick").setAttribute("aria-pressed", String(view === "quick"));
    $("#price-list-view").hidden = view !== "list";
    $("#price-quick").hidden = view !== "quick";
    const vis = visible();
    if (view === "list") renderList(vis);
    else renderQuick();
    updateProgress();
    updateStatus();
    const empty = $("#price-empty");
    const errorShown = !$("#price-error").hidden;
    empty.hidden = loading || errorShown || (view === "list" ? vis.length > 0 : true);
    if (!empty.hidden) {
      empty.textContent = query
        ? `Nothing matches “${query}”.`
        : rows.length === 0
          ? scope.run
            ? "This run hasn't added any products to the store yet."
            : "Nothing to price. No products added by this tool are at $0.00."
          : "Every product here has a price. Tick Show priced to change one.";
    }
  }

  function renderList(vis) {
    const list = $("#price-list");
    if (scope.run) return list.replaceChildren(...vis.map(rowEl));
    const out = [];
    let current = null;
    let group = [];
    const flushGroup = () => current !== null && out.splice(out.length - group.length, 0, groupHead(current, group));
    for (const r of vis) {
      if (r.p.run !== current) {
        flushGroup();
        current = r.p.run;
        group = [];
      }
      group.push(r);
      out.push(rowEl(r));
    }
    flushGroup();
    list.replaceChildren(...out);
  }

  /** A heading for each run on the all-runs page, with a link to price just that run. */
  function groupHead(run, list) {
    const vendors = [...new Set(list.map((r) => r.p.vendor).filter(Boolean))];
    const left = list.filter((r) => isUnpriced(r)).length;
    return h(
      "li",
      { class: "price-group" },
      h("h2", {}, `Run ${run}`),
      vendors.length ? h("span", { class: "price-group-who" }, vendors.join(", ")) : null,
      h("span", { class: "price-group-count" }, `${fmt(left)} to price`),
      h("a", { class: "link", href: `/runs/${run}/prices`, "data-nav": "" }, "Just this run"),
    );
  }

  const chips = (p, withRun) =>
    h(
      "span",
      { class: "price-chips" },
      p.sku ? h("span", { class: "price-chip mono", title: "Supplier code" }, p.sku) : null,
      p.barcode ? h("span", { class: "price-chip mono", title: "Barcode" }, p.barcode) : null,
      p.vendor ? h("span", { class: "price-chip is-plain" }, p.vendor) : null,
      withRun && p.run ? h("span", { class: "price-chip is-plain" }, `Run ${p.run}`) : null,
    );

  /**
   * The product photo. Three states that must never look alike: a photo still loading (a soft pulse), a product
   * with no photo at all (a labelled "No photo" panel), and a photo that failed to load (says so).
   */
  function noPhoto(size, failed = false) {
    const big = size === "is-big";
    return h(
      "span",
      { class: `price-photo is-blank ${size}${failed ? " is-failed" : ""}`, role: "img", "aria-label": failed ? "The photo didn't load" : "No photo yet" },
      h("span", { class: "no-photo-icon" }, icon(failed ? "alert" : "noImage", big ? 34 : 22)),
      h("span", { class: "no-photo-label" }, failed ? (big ? "The photo didn't load" : "Didn't load") : big ? "No photo yet" : "No photo"),
      big && !failed ? h("span", { class: "no-photo-hint" }, "Add one from a supplier catalogue: Catalogues, then Fill in missing photos.") : null,
    );
  }

  function photoButton(r, size) {
    const p = r.p;
    if (!p.image) return noPhoto(size);
    const img = h("img", { src: size === "is-big" ? p.imageLarge || p.image : p.image, alt: "", loading: size === "is-big" ? "eager" : "lazy", decoding: "async" });
    const btn = h("button", { type: "button", class: `price-photo is-loading ${size}`, "aria-label": `Show a bigger photo of ${p.title}`, onclick: () => zoom(r) }, img);
    img.addEventListener("load", () => btn.classList.remove("is-loading"));
    img.addEventListener("error", () => btn.replaceWith(noPhoto(size, true)));
    if (img.complete && img.naturalWidth) btn.classList.remove("is-loading");
    return btn;
  }

  function rowEl(r) {
    const p = r.p;
    const input = priceInput(r, `Price for ${p.title}`);
    r.input = input;
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (commit(r, input.value)) focusNext(r, e.shiftKey ? -1 : 1);
    });
    input.addEventListener("change", () => commit(r, input.value));
    input.addEventListener("paste", (e) => {
      const parts = splitPasted(e.clipboardData?.getData("text") ?? "");
      if (parts.length < 2) return; // a single value pastes as normal
      e.preventDefault();
      fillFrom(r, parts);
    });
    const state = h("span", { class: "price-state" });
    r.stateEl = state;
    const li = h(
      "li",
      { class: "price-card" },
      photoButton(r, "is-small"),
      h("div", { class: "price-info" }, h("p", { class: "price-name" }, p.title), chips(p, false)),
      h("div", { class: "price-entry" }, ticket(input), state),
    );
    r.el = li;
    paintRow(r);
    return li;
  }

  /** The price box, shaped like a shelf ticket. */
  function priceInput(r, label) {
    const input = h("input", {
      class: "price-input",
      type: "text",
      inputmode: "decimal",
      enterkeyhint: "next",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "Add price",
      "aria-label": label,
      value: r.draft ?? (r.value || (isUnpriced(r) ? "" : r.p.price ?? "")),
      disabled: !editable(r),
    });
    input.addEventListener("focus", () => input.select());
    input.addEventListener("input", () => {
      r.draft = input.value;
      if (r.status === "error") setStatus(r, "", "");
    });
    return input;
  }
  const ticket = (input, big = false) => h("label", { class: `price-ticket${big ? " is-big" : ""}` }, h("span", { class: "price-ticket-dollar", "aria-hidden": "true" }, "$"), input);

  function paintRow(r) {
    const li = r.el;
    if (!li) return;
    li.dataset.state = !editable(r) ? "locked" : r.status || (isUnpriced(r) ? "todo" : "priced");
    if (r.input && document.activeElement !== r.input && r.status !== "error") r.input.value = r.value || (isUnpriced(r) ? "" : r.p.price ?? "");
    const s = r.stateEl;
    if (!s) return;
    if (!editable(r)) s.replaceChildren("Several variants: price it in Shopify");
    else if (r.status === "error") s.replaceChildren(icon("alert", 14), r.error);
    else if (r.status === "saving" || r.status === "queued") s.replaceChildren(h("span", { class: "spinner" }), "Saving");
    else if (r.status === "saved") s.replaceChildren(icon("check", 14), "Saved");
    else s.replaceChildren();
  }

  function focusNext(r, dir) {
    const list = visible().filter((x) => editable(x));
    let i = list.indexOf(r) + dir;
    // Skip ones already priced (unless showing priced ones on purpose).
    while (list[i] && !showPriced && !isUnpriced(list[i]) && list[i].status !== "error") i += dir;
    const next = list[i];
    if (next?.input) {
      next.input.focus();
      next.input.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    } else if (dir > 0) r.input?.blur();
  }

  /** Pasted prices fill this row and the ones below it, in the order shown. A blank line skips a product. */
  function fillFrom(r, parts) {
    const list = visible().filter((x) => editable(x));
    const start = list.indexOf(r);
    let bad = 0;
    parts.forEach((txt, k) => {
      const row = list[start + k];
      if (!row || txt === "") return;
      if (row.input) row.input.value = txt;
      if (!commit(row, txt)) bad++;
    });
    const left = parts.slice(list.length - start).filter(Boolean).length;
    if (left) toast("info", `Only ${plural(list.length - start, "product")} from this one down, so the last ${plural(left, "price")} weren't used.`);
    if (bad) toast("bad", `${plural(bad, "pasted value")} isn't a price. ${bad === 1 ? "It's" : "They're"} marked in red.`);
  }

  /* ------------------------------------------------------------ one at a time */

  function buildQuick() {
    const photo = h("div", { class: "quick-photo" });
    const name = h("h2", { class: "quick-name" });
    const meta = h("div", { class: "quick-meta" });
    const count = h("p", { class: "quick-count" });
    const back = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => goBack() }, icon("left", 16), "Back");
    const skip = h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => goNext() }, "Next");
    const input = h("input", {
      class: "price-input",
      type: "text",
      inputmode: "decimal",
      enterkeyhint: "next",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "Add price",
      "aria-label": "Price, GST included",
    });
    input.addEventListener("input", () => {
      if (!quickAt) return;
      quickAt.draft = input.value; // kept when moving on, swiping or switching to the list
      if (quickAt.status === "error") setStatus(quickAt, "", "");
    });
    const stateLine = h("p", { class: "quick-state", "aria-live": "polite" });
    const save = h("button", { type: "submit", class: "btn btn-brand quick-save" }, "Save and next");
    const form = h("form", { class: "quick-form" }, ticket(input, true), save);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const r = quickAt;
      if (!r) return;
      if (input.value.trim() !== "" && !commit(r, input.value)) return; // not a price: stay and say so
      r.draft = undefined;
      goNext({ kept: true });
    });
    const done = h("div", { class: "quick-done", hidden: true });
    const card = h(
      "div",
      { class: "quick-card" },
      h("div", { class: "quick-top" }, back, count, skip),
      photo,
      h("div", { class: "quick-body" }, name, meta, form, stateLine),
    );
    $("#price-quick").replaceChildren(card, done);
    quick = { card, photo, name, meta, count, input, stateLine, done, back };
    wireSwipe(card);
  }

  /** Swipe left for the next product, right for the one before (phones). Not when starting on the price box. */
  function wireSwipe(card) {
    let start = null;
    card.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        start = e.touches.length === 1 && !e.target.closest("input, select") ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
      },
      { passive: true },
    );
    card.addEventListener(
      "touchend",
      (e) => {
        if (!start) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        const quickEnough = Date.now() - start.at < 700;
        start = null;
        if (!quickEnough || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        if (dx < 0) goNext({ swipe: "left" });
        else goBack({ swipe: "right" });
      },
      { passive: true },
    );
  }

  /** A price typed but not yet saved on the product on show: save it rather than lose it. */
  function keepQuickDraft() {
    const r = quickAt;
    if (!r || !quick) return;
    const text = quick.input.value.trim();
    if (text !== "" && parsePrice(text) !== r.p.price) commit(r, text);
    r.draft = undefined;
  }

  /** Products seen in this visit, so Back (or a swipe right) returns to them, priced or not. */
  let history = [];

  function goNext({ kept = false, swipe = "" } = {}) {
    if (!kept) keepQuickDraft();
    const list = todo();
    const all = visible();
    const pos = all.indexOf(quickAt);
    let next = list.find((r) => r !== quickAt && all.indexOf(r) > pos);
    if (!next) next = list.find((r) => r !== quickAt); // past the end: back to the first one still to price
    if (quickAt && next) history.push(quickAt);
    if (!next && !list.includes(quickAt)) {
      if (quickAt) history.push(quickAt);
      quickAt = null; // all done
    } else if (next) quickAt = next;
    paintQuick(swipe || "left");
  }

  function goBack({ swipe = "" } = {}) {
    keepQuickDraft();
    let prev = history.pop();
    while (prev && !rows.includes(prev)) prev = history.pop();
    if (!prev) return;
    quickAt = prev;
    paintQuick(swipe || "right");
  }

  function renderQuick() {
    if (!quick) buildQuick();
    // Stay on the product on show (even once priced) when coming back from the list.
    if (!quickAt || !visible().includes(quickAt)) quickAt = todo()[0] ?? null;
    paintQuick();
  }

  function paintQuick(slide = "") {
    if (!quick) return;
    const list = todo();
    const r = quickAt;
    quick.card.hidden = !r;
    quick.done.hidden = !!r || loading;
    if (!r) {
      const total = rows.length;
      quick.done.replaceChildren(
        h("span", { class: "quick-done-mark" }, icon("check", 28)),
        h("h2", {}, query ? "Nothing left that matches" : total ? "All priced" : loading ? "Loading…" : "Nothing to price"),
        h("p", {}, query ? "Clear the search to see the rest." : total ? "Every product here has a price. Nice work." : "No products added by this tool are waiting for a price."),
        query ? h("button", { type: "button", class: "btn btn-secondary", onclick: () => setQuery("") }, "Clear search") : null,
      );
      return;
    }
    const p = r.p;
    const pos = list.indexOf(r);
    quick.count.replaceChildren(h("strong", {}, fmt(list.length)), showPriced ? ` ${list.length === 1 ? "product" : "products"}` : " left");
    quick.back.disabled = !history.length;
    if (slide && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      quick.card.classList.remove("slide-left", "slide-right");
      void quick.card.offsetWidth; // restart the animation
      quick.card.classList.add(`slide-${slide}`);
    }
    const img = photoButton(r, "is-big");
    quick.photo.replaceChildren(img);
    quick.name.textContent = p.title;
    quick.meta.replaceChildren(chips(p, !scope.run));
    quick.input.value = r.draft ?? (r.status === "error" || r.status === "queued" || r.status === "saving" ? r.value : isUnpriced(r) ? "" : p.price ?? "");
    paintQuickState();
    // The next photo, ready before it's needed.
    const next = list[pos + 1] ?? list[0];
    if (next?.p.imageLarge || next?.p.image) new Image().src = next.p.imageLarge || next.p.image;
    if (view === "quick" && !matchMedia("(hover: none)").matches) quick.input.focus();
    else if (view === "quick" && document.activeElement !== quick.input && quickTyping) quick.input.focus();
  }
  let quickTyping = false;

  function paintQuickState() {
    if (!quick || !quickAt) return;
    const r = quickAt;
    const s = quick.stateLine;
    s.className = `quick-state${r.status === "error" ? " is-bad" : ""}`;
    if (r.status === "error") s.replaceChildren(icon("alert", 14), r.error);
    else if (r.status === "saved") s.replaceChildren(icon("check", 14), `Saved at $${r.p.price}`);
    else if (r.status === "queued" || r.status === "saving") s.replaceChildren(h("span", { class: "spinner" }), "Saving");
    else if (!isUnpriced(r)) s.replaceChildren(`Priced at $${r.p.price}. Type a new price to change it.`);
    else s.replaceChildren(matchMedia("(hover: none)").matches ? "Price customers pay, GST included. Swipe to move between products." : "Price customers pay, GST included.");
  }

  /* ------------------------------------------------------------ photo zoom */

  function zoom(r) {
    const dlg = $("#price-zoom");
    $("#price-zoom-img").src = r.p.imageLarge || r.p.image;
    $("#price-zoom-img").alt = r.p.title;
    $("#price-zoom-title").textContent = r.p.title;
    if (!dlg.open) dlg.showModal();
  }

  /* ------------------------------------------------------------ helium bundles */

  /**
   * Bring every helium bundle in the store up to date: first the balloons this tool added (priced ones go online,
   * their bundles go live), then every bundle in the store, whoever made it, priced at the sum of its parts.
   */
  async function syncBalloons() {
    const btn = $("#balloon-sync");
    const note = $("#balloon-sync-note");
    if (btn.disabled) return;
    btn.disabled = true;
    const t = { checked: 0, online: 0, repriced: 0, waiting: 0, gone: 0, errors: [] };
    const b = { checked: 0, repriced: 0, waiting: 0, noParts: 0, unshippable: 0 };
    try {
      let after = 0;
      for (let guard = 0; guard < 200; guard++) {
        note.textContent = `Checking balloons added here… ${fmt(t.checked)} so far.`;
        const r = await api.syncBalloons(after);
        for (const k of ["checked", "online", "repriced", "waiting", "gone"]) t[k] += r[k] ?? 0;
        t.errors.push(...(r.errors ?? []));
        if (r.next == null) break;
        after = r.next;
      }
      let cursor = "";
      for (let guard = 0; guard < 400; guard++) {
        note.textContent = `Checking every helium bundle in the store… ${fmt(b.checked)} so far, ${fmt(b.repriced)} repriced.`;
        const r = await api.repriceBundles(cursor);
        for (const k of ["checked", "repriced", "waiting", "noParts", "unshippable"]) b[k] += r[k] ?? 0;
        t.errors.push(...(r.errors ?? []));
        if (!r.next) break;
        cursor = r.next;
      }
      const parts = [
        `${fmt(b.checked)} helium bundles checked, ${fmt(b.repriced + t.repriced)} repriced to balloon + inflation`,
        t.online ? `${fmt(t.online)} foil balloons put online` : "",
        b.unshippable ? `${fmt(b.unshippable)} set to collect in store only (they were set up to be posted)` : "",
        b.waiting ? `${fmt(b.waiting)} left alone because their balloon is still at $0.00` : "",
        b.noParts ? `${fmt(b.noParts)} aren't set up as bundles (no parts), so they keep their price` : "",
      ].filter(Boolean);
      note.textContent = `${parts.join(". ")}.${t.errors.length ? ` Problem: ${t.errors[0]}` : ""}`;
      toast(t.errors.length ? "bad" : "ok", `Helium bundles: ${fmt(b.repriced + t.repriced)} repriced.`);
    } catch (err) {
      if (err instanceof SessionExpired) return sessionExpired();
      note.textContent = `Stopped part way: ${errorText(err)} Press the button again to carry on.`;
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------ wiring */

  function setQuery(q) {
    keepQuickDraft();
    history = [];
    query = q;
    $("#price-search").value = q;
    quickAt = null;
    renderAll();
  }

  function setView(v) {
    if (v === view) return;
    if (view === "quick") keepQuickDraft(); // a price typed one by one isn't lost
    else document.activeElement?.blur?.(); // the list box saves on leaving it
    view = v;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* not kept: fine */
    }
    renderAll();
    if (v === "quick") quick?.input.focus();
  }

  function wire() {
    let t = 0;
    $("#price-search").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => setQuery(e.target.value), 150);
    });
    $("#price-search").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      clearTimeout(t);
      setQuery(e.target.value);
      // A scanned or typed barcode with one match: straight to its price box.
      const vis = visible().filter(editable);
      if (vis.length === 1) {
        if (view === "list") vis[0].input?.focus();
        else quick?.input.focus();
      }
    });
    $("#price-view-list").addEventListener("click", () => setView("list"));
    $("#price-view-quick").addEventListener("click", () => setView("quick"));
    $("#price-show-priced").addEventListener("change", (e) => {
      keepQuickDraft();
      history = [];
      showPriced = e.target.checked;
      quickAt = null;
      renderAll();
    });
    $("#price-zoom").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.close(); // the dark area round the photo
    });
    $("#balloon-sync").addEventListener("click", syncBalloons);
    document.addEventListener("focusin", (e) => (quickTyping = !!quick && e.target === quick.input));
    addEventListener("beforeunload", (e) => {
      if (state.view === "prices" && dirty()) {
        flush();
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  function leave() {
    clearTimeout(flushTimer);
    flush(); // anything typed still gets saved
    seq += 1;
    rows = [];
    quickAt = null;
  }

  return { show, wire, dirty, leave };
}
