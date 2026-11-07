// Better photos for products already in the store. The server lists products a catalogue might improve; here the
// two pictures are compared by their visual fingerprints (phash.js) and the server is told what to do:
//   sharper: the same picture, clearly bigger: swapped in;
//   new:     a different picture from a catalogue saved after the current photo: put in front, the old one kept second;
//   none:    nothing better (remembered, so it isn't looked at again).
// Every change goes in a log, and new pictures wait in a review list where they can be put back.

import { maybeSameProduct, parseSignature, sameByThumb, signatureOf } from "./phash.js";

/** A picture must be at least this much bigger (in pixels) to count as sharper. */
export const SHARPER = 1.4;

/** Decide from two fingerprints and the two sizes. Pure, so it can be tested. */
export function decideKind(cur, next, same) {
  const curPx = (cur.width || 0) * (cur.height || 0);
  const newPx = (next.width || 0) * (next.height || 0);
  if (same) return curPx > 0 && newPx >= curPx * SHARPER ? "sharper" : "none";
  const newer = Date.parse(next.createdAt) > Date.parse(cur.createdAt);
  return newer ? "new" : "none";
}

async function look(url) {
  const res = await fetch(`/api/photo-updates/image?url=${encodeURIComponent(url)}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error("photo not fetched");
  const { sig, thumb } = await signatureOf(await res.blob());
  return { parsed: parseSignature(sig), thumb };
}

/** Same picture or not, from the two photos themselves. Null when one couldn't be read. */
export async function samePicture(cand) {
  try {
    const [a, b] = await Promise.all([look(cand.current.url), look(cand.next.url)]);
    if (!a.parsed || !b.parsed) return null;
    return maybeSameProduct(a.parsed, b.parsed) && sameByThumb(a.thumb, b.thumb);
  } catch {
    return null;
  }
}

/**
 * Check products and make the changes. `scope`: { mode: "all" } | { mode: "upload", code } | { mode: "products", productIds }.
 * `progress(t)` is called as it goes; `stop()` returning true ends it early. Returns the tally, and what happened to each
 * product (`byProduct`: productId -> { kind, id, error }).
 */
export async function runPhotoCheck(api, scope, { progress = () => {}, stop = () => false } = {}) {
  const t = { scanned: 0, compared: 0, sharper: 0, newer: 0, none: 0, failed: 0, unreadable: 0, byProduct: new Map() };
  let after = scope.mode === "upload" ? 0 : "";
  for (let guard = 0; guard < 500 && !stop(); guard++) {
    const page = await api.photoCandidates({ ...scope, after });
    t.scanned += page.scanned ?? 0;
    const decided = [];
    // A few at a time: each comparison loads two small photos.
    for (let i = 0; i < page.candidates.length && !stop(); i += 6) {
      const group = page.candidates.slice(i, i + 6);
      const res = await Promise.all(
        group.map(async (c) => {
          const same = await samePicture(c);
          if (same === null) {
            t.unreadable++;
            return null;
          }
          return { c, kind: decideKind(c.current, c.next, same) };
        }),
      );
      for (const r of res) if (r) decided.push(r);
      t.compared += group.length;
      progress(t);
    }
    for (let i = 0; i < decided.length; i += 10) {
      const batch = decided.slice(i, i + 10);
      const out = await api.applyPhotoUpdates(
        batch.map(({ c, kind }) => ({ productId: c.productId, title: c.title, fileId: c.next.fileId, kind, old: { mediaId: c.current.mediaId, url: c.current.url, width: c.current.width, height: c.current.height } })),
      );
      out.results.forEach((r, k) => {
        const kind = batch[k].kind;
        if (!r.ok) t.failed++;
        else if (kind === "sharper") t.sharper++;
        else if (kind === "new") t.newer++;
        else t.none++;
        if (kind !== "none") t.byProduct.set(batch[k].c.productId, { kind, id: r.id ?? null, error: r.ok ? (r.error ?? null) : r.error });
      });
      progress(t);
    }
    if (page.next == null) break;
    after = page.next;
  }
  return t;
}

/** One line about a finished check, for a note or a toast. */
export function checkSummary(t, plural) {
  const bits = [];
  if (t.sharper) bits.push(`${plural(t.sharper, "sharper photo")} swapped in`);
  if (t.newer) bits.push(`${plural(t.newer, "newer photo")} added in front (to review)`);
  if (t.failed) bits.push(`${plural(t.failed, "change")} failed`);
  return bits.length ? `${bits.join(", ")}.` : "No better photos found.";
}

/**
 * The review list on the Catalogues page: each new photo next to the one it replaced as the main photo, with
 * Use new (take the old one off), Keep both, and Put back.
 */
export function createPhotoReview(ctx) {
  const { api, h, $, icon, toast, errorText, plural, fmtWhen, SessionExpired } = ctx;
  let rows = [];
  let next = null;
  let counts = { review: 0, sharper: 0, newer: 0 };
  let busy = false;
  let view = "review"; // "review": new photos waiting; "recent": every change made

  function paintButton() {
    const btn = $("#cat-better-review");
    btn.hidden = false;
    btn.textContent = counts.review ? `Review ${plural(counts.review, "new photo")}` : "See photo changes";
    btn.classList.toggle("btn-secondary", !!counts.review);
    btn.classList.toggle("btn-ghost", !counts.review);
  }

  async function refreshCounts() {
    try {
      const res = await api.photoUpdates({ view });
      counts = res.counts;
      rows = res.rows;
      next = res.next;
    } catch {
      return;
    }
    paintButton();
    if (!$("#photo-review").hidden) render();
  }

  async function open(which) {
    view = which ?? (counts.review ? "review" : "recent");
    await refreshCounts();
    $("#photo-review").hidden = false;
    render();
    $("#photo-review").scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function close() {
    $("#photo-review").hidden = true;
  }

  async function decide(row, action) {
    try {
      await api.decidePhotoUpdate(row.id, action);
      if (view === "review") rows = rows.filter((r) => r !== row);
      else row.status = action === "put-back" ? "undone" : action === "use-new" ? "kept_new" : "kept_both";
      counts.review = Math.max(0, counts.review - 1);
      render();
      paintButton();
    } catch (err) {
      if (err instanceof SessionExpired) return ctx.sessionExpired();
      toast("bad", `${row.title}: ${errorText(err)}`);
    }
  }

  async function all(action) {
    if (busy) return;
    busy = true;
    render();
    let done = 0;
    try {
      // Everything waiting, not just what's loaded.
      for (let guard = 0; guard < 100; guard++) {
        const page = await api.photoUpdates({ view: "review" });
        if (!page.rows.length) break;
        for (const r of page.rows) {
          await api.decidePhotoUpdate(r.id, action).catch(() => {});
          done++;
          $("#photo-review-progress").textContent = `${done} done…`;
        }
      }
    } catch (err) {
      if (err instanceof SessionExpired) return ctx.sessionExpired();
      toast("bad", errorText(err));
    } finally {
      busy = false;
    }
    toast("ok", action === "put-back" ? `${plural(done, "old photo")} put back.` : `${plural(done, "new photo")} kept, old ones removed.`);
    await refreshCounts();
    render();
  }

  function pic(url, label) {
    // A photo taken off the product may no longer load: say so rather than show a broken picture.
    const gone = () => h("span", { class: "pr-gone" }, "Removed");
    const img = url ? h("img", { src: url, alt: "", loading: "lazy" }) : null;
    img?.addEventListener("error", () => img.replaceWith(gone()));
    return h("figure", { class: "pr-pic" }, img ?? gone(), h("figcaption", {}, label));
  }

  const STATUS = {
    applied: "Waiting for review",
    kept_new: "New photo kept, old one removed",
    kept_both: "Both photos kept",
    undone: "Old photo put back",
    failed: "Couldn't be changed",
  };

  function tabs() {
    const tab = (v, label) =>
      h("button", { type: "button", class: "price-view-btn", "aria-pressed": String(view === v), onclick: () => ((view = v), refreshCounts()) }, label);
    return h("div", { class: "price-view pr-tabs", role: "group", "aria-label": "Which photo changes" }, tab("review", `To review (${counts.review})`), tab("recent", `All changes (${counts.sharper + counts.newer})`));
  }

  function render() {
    const box = $("#photo-review");
    const reviewing = view === "review";
    const parts = [
      h(
        "div",
        { class: "wiz-head" },
        h("h2", { id: "photo-review-title" }, "Photo changes"),
        h(
          "p",
          {},
          reviewing
            ? rows.length
              ? "These products got a newer photo from a catalogue. It's now the main photo, and the old one is still on the product, second. Keep it that way, take the old one off, or put the old one back."
              : "Nothing waiting. Newer photos from catalogues show up here as soon as they're added."
            : rows.length
              ? "Every photo this tool has changed, newest first. Sharper copies replace the same picture, so there's nothing to review for those."
              : "No photos have been changed yet. They change after a catalogue is saved, after an invoice adds stock to products already in the store, or with Check all products.",
        ),
      ),
      tabs(),
      reviewing && rows.length
        ? h(
            "div",
            { class: "pr-bulk" },
            h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: busy, onclick: () => all("use-new") }, "Use new for all"),
            h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: busy, onclick: () => all("put-back") }, "Put all back"),
            h("span", { class: "pr-progress", id: "photo-review-progress", "aria-live": "polite" }),
          )
        : null,
      h(
        "ul",
        { class: "pr-list" },
        ...rows.map((r) =>
          h(
            "li",
            { class: "pr-row" },
            h("div", { class: "pr-pics" }, pic(r.oldUrl, "Before"), h("span", { class: "pr-arrow", "aria-hidden": "true" }, icon("right", 18)), pic(r.newUrl, `New${r.catalogue ? `, from ${r.catalogue}` : ""}`)),
            h(
              "div",
              { class: "pr-info" },
              h("p", { class: "pr-title" }, r.title),
              h("p", { class: "pr-when" }, `${r.kind === "sharper" ? "Sharper copy swapped in" : "Newer photo added"} ${fmtWhen(r.createdAt)}${r.kind === "new" && r.status !== "applied" ? `. ${STATUS[r.status] ?? r.status}` : r.status === "failed" ? `. ${STATUS.failed}: ${r.error ?? ""}` : ""}`),
              r.kind !== "new" || r.status !== "applied" ? null : h(
                "div",
                { class: "pr-actions" },
                h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: busy, onclick: () => decide(r, "use-new") }, "Use new"),
                h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: busy, onclick: () => decide(r, "keep-both") }, "Keep both"),
                h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: busy, onclick: () => decide(r, "put-back") }, "Put back"),
              ),
            ),
          ),
        ),
      ),
      next ? h("p", { class: "map-hint" }, "Showing the 50 newest. Deal with these to see more.") : null,
      h("div", { class: "wiz-actions" }, h("button", { type: "button", class: "btn btn-ghost", onclick: close }, "Close")),
    ];
    box.replaceChildren(...parts.filter(Boolean)); // (replaceChildren would print "null")
  }

  return { open, close, refreshCounts };
}
