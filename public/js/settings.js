// Settings page (from the profile menu): shared defaults for new products, and the supplier list, where a
// supplier no product or catalogue uses can be deleted.

const TOGGLES = [
  {
    key: "importTags",
    title: "Tag new products with their import and run",
    text: "Adds tags like import-20261007-R42-ALPEN-K3F9 and run-R42, so you can find an import or a whole run in Shopify admin by searching the tag. The import ID is always saved in Import source either way.",
  },
  {
    key: "cataloguePhotos",
    title: "Use catalogue photos automatically",
    text: "When an invoice line is in a supplier catalogue, its photos are ticked for you. Turn off to have staff tick the photos they want.",
  },
  {
    key: "catalogueDescriptions",
    title: "Use catalogue descriptions automatically",
    text: "New products get the description from the supplier catalogue. Turn off to have staff switch it on per product.",
  },
];

export function createSettings(ctx) {
  const { api, h, $, icon, toast, confirmDialog, fact, errorText, plural, state, SessionExpired } = ctx;
  let suppliers = null; // [{ name, saved, products, catalogues }]
  let onlyUnused = false;

  async function show() {
    renderToggles();
    loadSuppliers();
  }

  function locked() {
    return !state.health?.canManage;
  }

  function renderToggles() {
    const s = state.health?.settings;
    $("#set-who").textContent = locked()
      ? "Only managers can change these settings. You can see them."
      : "Shared by everyone who uses the site. Changes save straight away.";
    $("#set-toggles").replaceChildren(
      ...TOGGLES.map((t) => {
        const input = h("input", { type: "checkbox", class: "switch-input", id: `set-${t.key}`, role: "switch", disabled: locked() || !s });
        input.checked = Boolean(s?.[t.key]);
        input.addEventListener("change", () => save(t.key, input.checked, input));
        return h(
          "li",
          { class: "set-row" },
          h("div", { class: "set-text" }, h("label", { for: `set-${t.key}`, class: "set-title" }, t.title), h("p", {}, t.text)),
          h("span", { class: "switch" }, input, h("span", { class: "switch-track", "aria-hidden": "true" }, h("span", { class: "switch-thumb" }))),
        );
      }),
    );
  }

  async function save(key, value, input) {
    input.disabled = true;
    try {
      const res = await api.saveSettings({ [key]: value });
      state.health.settings = res.settings;
      toast("ok", "Saved.");
    } catch (err) {
      input.checked = !value;
      toast("bad", `Couldn't save. ${errorText(err)}`);
    } finally {
      input.disabled = locked();
    }
  }

  async function loadSuppliers() {
    const list = $("#set-suppliers");
    list.setAttribute("aria-busy", "true");
    try {
      const res = await api.supplierDetails();
      suppliers = res.suppliers;
      renderSuppliers();
    } catch (err) {
      if (err instanceof SessionExpired) return ctx.sessionExpired();
      list.replaceChildren(h("li", { class: "set-empty" }, `Couldn't load suppliers. ${errorText(err)}`));
    } finally {
      list.removeAttribute("aria-busy");
    }
  }

  const unused = (s) => s.products === 0 && s.catalogues === 0;

  function renderSuppliers() {
    if (!suppliers) return;
    const q = $("#set-sup-q").value.trim().toLowerCase();
    const shown = suppliers.filter((s) => (!q || s.name.toLowerCase().includes(q)) && (!onlyUnused || unused(s)));
    const free = suppliers.filter(unused).length;
    $("#set-sup-sum").textContent = `${plural(suppliers.length, "supplier")}. ${free ? `${plural(free, "isn't", "aren't")} used by any product or catalogue.` : "All are in use."}`;
    $("#set-suppliers").replaceChildren(
      ...(shown.length
        ? shown.map((s) => {
            const tags = [];
            if (s.products) tags.push(h("span", { class: "badge badge-ok" }, `${plural(s.products, "product")} in store`));
            if (s.catalogues) tags.push(h("span", { class: "badge" }, plural(s.catalogues, "catalogue")));
            if (unused(s)) tags.push(h("span", { class: "badge badge-warn" }, "Not used"));
            const why = s.products
              ? `Used as the vendor on ${plural(s.products, "product")}. Change their vendor in Shopify first.`
              : s.catalogues
                ? "Has a supplier catalogue. Undo it on the Catalogues page first."
                : locked()
                  ? "Only managers can delete suppliers."
                  : `Delete ${s.name}`;
            const can = unused(s) && s.saved && !locked();
            return h(
              "li",
              { class: "set-sup" },
              h("span", { class: "set-sup-name" }, s.name),
              h("span", { class: "set-sup-tags" }, ...tags),
              h(
                "button",
                { type: "button", class: "btn btn-sm btn-ghost btn-danger", disabled: !can, title: why, "aria-label": can ? `Delete ${s.name}` : `${s.name} can't be deleted: ${why}`, onclick: () => remove(s) },
                icon("trash", 15),
                "Delete",
              ),
            );
          })
        : [h("li", { class: "set-empty" }, q || onlyUnused ? "No suppliers match." : "No suppliers yet.")]),
    );
  }

  async function remove(s) {
    const ok = await confirmDialog({
      title: `Delete ${s.name}?`,
      ok: "Delete supplier",
      danger: true,
      facts: [
        fact("hand", "It's removed from the supplier list ", "staff choose from. No product or catalogue uses it."),
        fact("check", "Past runs keep the name ", "on their invoices, as a record."),
      ],
    });
    if (!ok) return;
    try {
      const res = await api.deleteSupplier(s.name);
      state.suppliers = res.suppliers;
      suppliers = suppliers.filter((x) => x !== s);
      renderSuppliers();
      toast("ok", `Deleted ${s.name}.`);
    } catch (err) {
      toast("bad", errorText(err), { sticky: true });
      loadSuppliers(); // something changed in the store: show the latest
    }
  }

  function wire() {
    let t = 0;
    $("#set-sup-q").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(renderSuppliers, 120);
    });
    $("#set-sup-unused").addEventListener("change", (e) => {
      onlyUnused = e.target.checked;
      renderSuppliers();
    });
    $("#set-sup-refresh").addEventListener("click", loadSuppliers);
  }

  return { show, wire, renderToggles };
}
