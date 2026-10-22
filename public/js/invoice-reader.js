// Reading invoices of any length, without staff ever splitting a file:
//  - Spreadsheets: the AI says which column is which (from the first rows); every row is read here.
//    Layouts that aren't a table go to the AI in parts instead.
//  - Long PDFs: read a few pages at a time when they don't fit in one AI reply.
//  - Titles from spreadsheets are tidied in checked batches (see src/titles.ts). Anything the AI can't
//    tidy reliably keeps a rule-based tidy and is flagged, so a file never fails because of titles.
// No DOM here: app.js passes in the API and shows progress.

import { buildInvoiceSample, checkInvoiceMap, findInvoiceNumber, partText, readInvoiceRows, splitPiece, textParts } from "./sheet-read.js";
import { basicTitle } from "./titles.js";

export const MAX_ROWS_PER_RUN = 2000;
const MATCH_BATCH = 1000;
const TITLE_BATCH = 100;
const RETRY_BATCH = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createReader({ api, ApiError, SessionExpired }) {
  const tooLong = (err) => err instanceof ApiError && err.body?.code === "too_long";

  /**
   * One AI call with retries: busy, overloaded or rate-limited answers wait and try again (the server
   * switches to the backup model from the 2nd try). Other errors are thrown straight away.
   */
  // Google's free tier is often "overloaded" (503) for a few minutes: five tries over about a minute and a
  // half, switching between the main and backup models.
  async function withRetries(fn, { waits = [0, 5000, 15000, 25000, 45000], onWait, isCancelled } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        const retry = err instanceof ApiError && err.body?.retryable && attempt < waits.length;
        if (!retry || isCancelled?.()) throw err;
        onWait?.(Math.round(waits[attempt] / 1000), attempt + 1, waits.length);
        await sleep(waits[attempt]);
        if (isCancelled?.()) throw err;
      }
    }
  }

  /** Check rows against the store, in batches the server accepts. Returns the server's rows, in order. */
  async function matchAll(items) {
    const out = [];
    let store = null;
    for (let i = 0; i < items.length; i += MATCH_BATCH) {
      const res = await api.match(items.slice(i, i + MATCH_BATCH));
      out.push(...res.rows);
      store = res.store;
    }
    return { rows: out, store };
  }

  /* -------------------------------------------------------------- spreadsheets */

  /**
   * Work out a spreadsheet's columns. Returns { map, trusted, aiMap, aiError }.
   * The AI's answer is checked against the data; without the AI (down, out of quota) our own guess is used.
   */
  async function mapSheets(sheets, opts) {
    let aiMap = null;
    let aiError = null;
    try {
      aiMap = (await withRetries((attempt) => api.mapInvoice(buildInvoiceSample(sheets), attempt), opts)).map;
    } catch (err) {
      if (err instanceof SessionExpired) throw err;
      aiError = err;
    }
    return { ...checkInvoiceMap(sheets, aiMap), aiMap, aiError };
  }

  /**
   * Read every product line of a spreadsheet by its columns.
   * Returns { items: [{ id, invoiceTitle, title, supplierCode, barcode }], invoice, skipped }.
   */
  function readByColumns(sheets, map, aiMap) {
    const { items, skipped } = readInvoiceRows(sheets, map);
    return {
      items: items.map((it, i) => ({
        id: `x${i}`,
        invoiceTitle: it.invoiceTitle,
        title: it.invoiceTitle ? basicTitle(it.invoiceTitle, { code: it.supplierCode ?? "", barcode: it.barcode ?? "" }) : "",
        supplierCode: it.supplierCode,
        barcode: it.barcode,
        quantity: it.quantity ?? null,
        unit: it.unit ?? "",
        unitsPer: it.unitsPer ?? null,
      })),
      invoice: { supplierName: aiMap?.supplierName ?? null, invoiceNumber: aiMap?.invoiceNumber ?? findInvoiceNumber(sheets) },
      skipped,
    };
  }

  /**
   * A spreadsheet that isn't a simple table: the AI reads it, in parts when it's long. A part that's still
   * too long is halved. Returns { rows (matched), invoice, store }.
   */
  async function readSheetsWithAi(fileName, sheets, opts) {
    const queue = textParts(sheets, 120);
    const rows = [];
    let invoice = null;
    let store = null;
    let done = 0;
    while (queue.length) {
      if (opts.isCancelled?.()) return null;
      const piece = queue.shift();
      const n = done + queue.length + 1;
      const { text, part } = partText(piece, done, n);
      opts.onStatus?.(n > 1 ? `Reading part ${done + 1} of ${n}…` : "Reading the invoice…");
      try {
        const res = await withRetries((attempt) => api.extractText(fileName, text, attempt, part), opts);
        rows.push(...res.rows);
        invoice ??= res.invoice?.supplierName || res.invoice?.invoiceNumber ? res.invoice : null;
        store = res.store;
        done++;
      } catch (err) {
        if (!tooLong(err)) throw err;
        const halves = splitPiece(piece);
        if (!halves) throw new ApiError("Part of this file has more lines close together than the AI can read at once.", 422, { code: "too_long" });
        queue.unshift(...halves);
      }
    }
    return { rows: dedupeById(rows), invoice: invoice ?? { supplierName: null, invoiceNumber: null }, store };
  }

  function dedupeById(rows) {
    // Server rows from different parts may reuse ids like row-0: give them new ones.
    return rows.map((r, i) => ({ ...r, id: `a${i}` }));
  }

  /* -------------------------------------------------------------- PDFs and photos */

  /**
   * A PDF too long for one AI reply, read a few pages at a time. Returns { rows, invoice, store, skippedPages }.
   * The number of pages comes from the first answer; without it, reading stops after two empty parts.
   */
  async function readPdfByPages(fileName, mimeType, base64, opts) {
    const rows = [];
    let invoice = null;
    let store = null;
    const hint = opts.pageHint > 0 ? opts.pageHint : null; // counted from the file itself
    let total = hint;
    let from = 1;
    let size = 3;
    let empty = 0;
    let lastHadRows = false;
    let checkedPast = false;
    const skippedPages = [];
    const seen = new Map(); // line -> how many times read so far
    let last = null;
    while (from <= 300) {
      if (total !== null && from > total) {
        // The count may be too low (the AI's guess, or a PDF that hides it): one more look past the end.
        if (checkedPast || !lastHadRows) break;
        checkedPast = true;
      }
      if (opts.isCancelled?.()) return null;
      const to = total && from <= total ? Math.min(total, from + size - 1) : from + size - 1;
      opts.onStatus?.(total && from <= total ? `Reading pages ${from}–${to} of ${total}…` : `Reading pages ${from}–${to}…`);
      let res;
      try {
        res = await withRetries((attempt) => api.extractFile(fileName, mimeType, base64, attempt, { from, to }), opts);
      } catch (err) {
        if (!tooLong(err)) throw err;
        if (size > 1) {
          size = Math.max(1, Math.floor(size / 2));
          continue;
        }
        skippedPages.push(from); // one page with more lines than one AI reply: very rare
        from++;
        continue;
      }
      if (total === null || (res.pageCount && res.pageCount > total && !hint)) total = res.pageCount ?? total;
      invoice ??= res.invoice?.supplierName || res.invoice?.invoiceNumber ? res.invoice : null;
      store = res.store ?? store;
      let got = res.rows.filter((r, k) => !(k === 0 && last && sameLine(last, r))); // repeated across a page break
      // Mostly lines already read (or the look past the end): the AI didn't keep to these pages. Keep only new lines.
      const repeats = got.filter((r) => (seen.get(lineKey(r)) ?? 0) > 0).length;
      if (checkedPast || (got.length >= 2 && repeats > got.length / 2)) got = got.filter((r) => !seen.get(lineKey(r)));
      for (const r of got) seen.set(lineKey(r), (seen.get(lineKey(r)) ?? 0) + 1);
      rows.push(...got);
      if (got.length) last = got[got.length - 1];
      lastHadRows = got.length > 0;
      if (checkedPast) {
        if (!got.length) break;
        total = null; // there were more pages after all: carry on until two empty parts
        checkedPast = false;
      }
      empty = got.length ? 0 : empty + 1;
      if (total === null && empty >= 2) break;
      from = to + 1;
    }
    return { rows: dedupeById(rows), invoice: invoice ?? { supplierName: null, invoiceNumber: null }, store, skippedPages };
  }

  const lineKey = (r) => `${r.barcode ?? ""}|${r.supplierCode ?? ""}|${(r.invoiceTitle || r.title || "").toLowerCase()}`;

  const sameLine = (a, b) =>
    (a.barcode ?? "") === (b.barcode ?? "") && (a.supplierCode ?? "") === (b.supplierCode ?? "") && (a.invoiceTitle ?? a.title) === (b.invoiceTitle ?? b.title);

  /* -------------------------------------------------------------- titles */

  /**
   * Tidy titles in checked batches. jobs: [{ key, text }] (one per distinct description).
   * Calls onResult(key, title) for each accepted title and onFail(key) for each one left as it is.
   * Throws only SessionExpired. Returns { tidied, failed, stoppedBy } (stoppedBy: why the AI stopped helping).
   */
  async function tidyTitles(jobs, supplier, { onResult, onFail, onProgress, isCancelled, onWait, waits = [0, 5000, 15000, 30000, 60000] } = {}) {
    let tidied = 0;
    let failed = 0;
    let stoppedBy = null;
    const total = jobs.length;
    const fail = (list) => {
      for (const j of list) {
        failed++;
        onFail?.(j.key);
      }
      onProgress?.(tidied + failed, total);
    };
    let queue = [];
    for (let i = 0; i < jobs.length; i += TITLE_BATCH) queue.push({ jobs: jobs.slice(i, i + TITLE_BATCH), second: false });
    const again = [];
    while (queue.length || again.length) {
      if (isCancelled?.()) return { tidied, failed, stoppedBy: "cancelled" };
      if (!queue.length) {
        // Second chance for lines the checks turned down, a few at a time.
        const list = again.splice(0);
        for (let i = 0; i < list.length; i += RETRY_BATCH) queue.push({ jobs: list.slice(i, i + RETRY_BATCH), second: true });
      }
      const batch = queue.shift();
      if (stoppedBy) {
        fail(batch.jobs);
        continue;
      }
      const ids = new Map(batch.jobs.map((j, k) => [`t${k}`, j]));
      let res;
      try {
        res = await withRetries((attempt) => api.tidyTitles([...ids].map(([id, j]) => ({ id, text: j.text })), supplier, attempt), { waits, onWait, isCancelled });
      } catch (err) {
        if (err instanceof SessionExpired) throw err;
        if (tooLong(err) && batch.jobs.length > 1) {
          const mid = Math.ceil(batch.jobs.length / 2);
          queue.unshift({ jobs: batch.jobs.slice(0, mid), second: batch.second }, { jobs: batch.jobs.slice(mid), second: batch.second });
          continue;
        }
        // Still busy after every retry, out of quota, or not set up: keep the simple tidy for the rest.
        stoppedBy = err instanceof ApiError ? err.message : "The AI couldn't be reached.";
        fail(batch.jobs);
        continue;
      }
      for (const t of res.titles ?? []) {
        const j = ids.get(t.id);
        if (!j) continue;
        ids.delete(t.id);
        tidied++;
        onResult?.(j.key, t.title);
      }
      // Whatever wasn't accepted: once more in a small batch, then left with the simple tidy.
      const left = [...ids.values()];
      if (batch.second) fail(left);
      else again.push(...left);
      onProgress?.(tidied + failed, total);
    }
    return { tidied, failed, stoppedBy };
  }

  return { withRetries, matchAll, mapSheets, readByColumns, readSheetsWithAi, readPdfByPages, tidyTitles, tooLong };
}

/** The key two descriptions share when they'd get the same tidy title. */
export const titleKey = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
