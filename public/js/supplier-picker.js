// Supplier picker: a list of the existing suppliers that filters as you type. A new supplier is only
// created by choosing the clearly marked "Add new supplier" option, and never when the name is just a
// different spelling of one that exists ("ALPEN PTY LTD" is Alpen). The browser's own autofill is off.

import { supplierKey } from "./suppliers.js";

/** The existing supplier this name refers to: same name ignoring case/spacing, or the same name once
 *  "Pty Ltd", "Australia" and the like are ignored. */
export function sameSupplier(name, list) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!n) return null;
  const exact = list.find((s) => s.toLowerCase() === n);
  if (exact) return exact;
  const k = supplierKey(name);
  return k ? (list.find((s) => supplierKey(s) === k) ?? null) : null;
}

/** Suppliers matching what's typed: names starting with it first, then names containing it. */
export function filterSuppliers(query, list) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!q) return [...list];
  const k = supplierKey(q);
  const starts = [];
  const contains = [];
  for (const s of list) {
    const low = s.toLowerCase();
    const sk = supplierKey(s);
    if (low.startsWith(q) || (k && sk.startsWith(k))) starts.push(s);
    else if (low.includes(q) || (k && k.length >= 3 && (sk.includes(k) || k.includes(sk)))) contains.push(s);
  }
  return [...starts, ...contains];
}

let seq = 0;

/**
 * Build a picker. onCommit(name, isNew) is called when a supplier is chosen.
 * Returns { el, input, setValue(name), setDisabled(bool), get value() }.
 */
export function supplierPicker({ id, value = "", placeholder = "Choose a supplier", getSuppliers, onCommit, h, icon, label }) {
  const listId = `sp-list-${++seq}`;
  let committed = value ?? "";
  let open = false;
  let active = 0;
  let options = []; // { kind: "existing" | "new", name }

  const input = h("input", {
    id,
    class: "sup-input sp-input",
    type: "text",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "words",
    spellcheck: "false",
    "data-lpignore": "true", // password managers
    "data-1p-ignore": "true",
    "data-form-type": "other",
    placeholder,
    maxlength: "100",
    ...(label ? { "aria-label": label } : {}),
  });
  input.value = committed;
  const chevron = h("span", { class: "sp-chevron", "aria-hidden": "true" }, icon("down", 15));
  const list = h("ul", { class: "sp-list", id: listId, role: "listbox", hidden: true });
  const el = h("div", { class: "sp" }, input, chevron, list);

  function build() {
    const all = getSuppliers();
    const typed = input.value.replace(/\s+/g, " ").trim();
    const same = sameSupplier(typed, all);
    const matches = filterSuppliers(input.value === committed ? "" : typed, all);
    if (same && !matches.includes(same)) matches.unshift(same);
    options = matches.map((name) => ({ kind: "existing", name }));
    // Only offer "new" when the typed name isn't an existing supplier under any spelling.
    if (typed && !same && input.value !== committed) options.push({ kind: "new", name: typed });
    if (active >= options.length) active = Math.max(0, options.length - 1);
    const sameIdx = same ? options.findIndex((o) => o.name === same) : -1;
    if (sameIdx >= 0 && input.value !== committed) active = sameIdx;
  }

  function paint() {
    if (!open) return;
    const typed = input.value.replace(/\s+/g, " ").trim();
    list.replaceChildren(
      ...options.map((o, i) =>
        h(
          "li",
          {
            id: `${listId}-${i}`,
            role: "option",
            class: `sp-opt${o.kind === "new" ? " is-new" : ""}${i === active ? " is-active" : ""}${o.name === committed ? " is-current" : ""}`,
            "aria-selected": String(i === active),
            onmousedown: (e) => e.preventDefault(), // keep focus in the box
            onclick: () => choose(o),
          },
          o.kind === "new"
            ? [h("span", { class: "sp-new-icon" }, icon("plus", 14)), h("span", { class: "sp-new-text" }, h("strong", {}, `Add “${o.name}”`), h("small", {}, "as a new supplier"))]
            : [h("span", { class: "sp-name" }, highlight(o.name, typed)), o.name === committed ? h("span", { class: "sp-tick" }, icon("check", 14)) : null],
        ),
      ),
    );
    if (!options.length) list.append(h("li", { class: "sp-empty" }, "No suppliers yet. Type a name to add one."));
    input.setAttribute("aria-activedescendant", options.length ? `${listId}-${active}` : "");
    list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
    place();
  }

  function highlight(name, typed) {
    const q = typed.toLowerCase();
    const at = q ? name.toLowerCase().indexOf(q) : -1;
    if (at < 0) return name;
    return [name.slice(0, at), h("mark", {}, name.slice(at, at + q.length)), name.slice(at + q.length)];
  }

  /** The list floats above everything (the invoice list scrolls, so it can't sit inside it). */
  function place() {
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    list.style.cssText = `left:${r.left}px;width:${Math.max(r.width, 220)}px;${below < 240 && r.top > below ? `bottom:${window.innerHeight - r.top + 4}px` : `top:${r.bottom + 4}px`}`;
  }

  function show() {
    if (input.readOnly || open) return;
    open = true;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    el.classList.add("is-open");
    active = Math.max(0, getSuppliers().indexOf(committed));
    build();
    paint();
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
  }

  function hide() {
    if (!open) return;
    open = false;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    el.classList.remove("is-open");
    removeEventListener("scroll", place, true);
    removeEventListener("resize", place);
  }

  function choose(o) {
    hide();
    committed = o.name;
    input.value = o.name;
    onCommit(o.name, o.kind === "new");
  }

  /** Leaving the box without choosing: a recognised name counts; anything else goes back to what it was. */
  function settle() {
    const typed = input.value.replace(/\s+/g, " ").trim();
    hide();
    if (typed === committed) return;
    if (!typed) {
      committed = "";
      onCommit("", false);
      return;
    }
    const same = sameSupplier(typed, getSuppliers());
    if (same) choose({ kind: "existing", name: same });
    else {
      input.value = committed;
      el.classList.add("is-reverted");
      setTimeout(() => el.classList.remove("is-reverted"), 1200);
    }
  }

  input.addEventListener("focus", show);
  input.addEventListener("click", show);
  input.addEventListener("input", () => {
    if (!open) show();
    active = 0;
    build();
    paint();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      const n = options.length;
      if (n) active = (active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && options[active]) choose(options[active]);
      else settle();
    } else if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      input.value = committed;
      hide();
    } else if (e.key === "Tab") settle();
  });
  input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && settle(), 0));
  chevron.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (open) hide();
    else input.focus();
  });

  return {
    el,
    input,
    get value() {
      return committed;
    },
    setValue(v) {
      committed = v ?? "";
      if (document.activeElement !== input) input.value = committed;
    },
    setDisabled(d) {
      input.readOnly = d;
      el.classList.toggle("is-locked", d);
      if (d) hide();
    },
  };
}
