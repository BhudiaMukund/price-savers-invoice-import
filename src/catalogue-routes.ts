import { namedPhotos } from "./photo-names";
import type { Hono } from "hono";
import type { Env } from "./types";
import { CatalogueStore, FILE_ID_RE, MAX_PHOTOS_PER_ITEM, type CatalogueItemIn, type CatalogueMatch, type PhotoInfo } from "./catalogue";
import { upgradePhotoLinks } from "./photo-upgrade";
import { sniffImage } from "./sniff";
// The same naming the page uses when it first sends a photo, so a photo sent again gets the same kind of name.
// @ts-expect-error plain JS module shared with the browser
import { catalogueAlt, catalogueFileName } from "../public/js/photo-names.js";
import { safeFileName } from "./files";
import { addPhotosToProduct, createFiles, deleteFiles, fileStatuses, IMAGE_TYPES, MAX_IMAGE_BYTES, productsByIds, productsWithoutPhotos, uploadImage } from "./files";
import { mapColumns } from "./catalogue-map";
import { ExtractionError } from "./extract";
import { ShopifyError } from "./shopify";
import { StoreError } from "./store";
import { CATALOGUE_LIMITS as L } from "./limits";
import { applyUpdate, candidatesFor, decideUpdate, productsById, productsForUpload, productsWithPhotos, type ApplyItem } from "./photo-updates";

export type AppEnv = { Bindings: Env; Variables: { user: string } };

const NO_DB = "Catalogues need the D1 database. Create it with npx wrangler d1 create invoice-import-db, put its database_id in wrangler.toml, and deploy again.";

const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : typeof v === "number" ? String(v) : "");

function fail(e: unknown) {
  if (e instanceof StoreError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  if (e instanceof ShopifyError) return Response.json({ error: e.message }, { status: 502 });
  throw e;
}

/** Ask Shopify about photos it's still processing, and remember the answers. */
async function refreshPhotos(env: Env, store: CatalogueStore, ids: string[]) {
  const ask = ids.slice(0, 100);
  if (!ask.length) return new Map<string, PhotoInfo>();
  const now = await fileStatuses(env, ask);
  await store.setFileStatuses(now.map((f) => ({ fileId: f.fileId, status: f.status, url: f.url, error: f.error ?? null })));
  return new Map(now.map((f) => [f.fileId, f]));
}

async function freshMatches(env: Env, store: CatalogueStore, matches: Record<string, CatalogueMatch>) {
  const waiting = [...new Set(Object.values(matches).flatMap((m) => m.photos.filter((p) => p.status === "processing").map((p) => p.fileId)))];
  if (!waiting.length) return matches;
  let fresh: Map<string, PhotoInfo>;
  try {
    fresh = await refreshPhotos(env, store, waiting);
  } catch {
    return matches; // shown as "processing"; asked again next time
  }
  for (const m of Object.values(matches)) {
    m.photos = m.photos.map((p) => fresh.get(p.fileId) ?? p).filter((p) => p.status !== "deleted" && p.status !== "failed");
  }
  return matches;
}

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function catalogueRoutes(app: Hono<AppEnv>) {
  const storeOf = (env: Env) => (env.DB ? new CatalogueStore(env.DB) : null);

  /* ------------------------------------------------------------ uploads */

  app.get("/api/catalogues", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    return c.json(await store.list({ q: (c.req.query("q") ?? "").slice(0, 100), before: Number(c.req.query("before")) || undefined, limit: Number(c.req.query("limit")) || 30 }));
  });

  app.post("/api/catalogues", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ supplier?: unknown; fileNames?: unknown }>().catch(() => null);
    const names = Array.isArray(body?.fileNames) ? body.fileNames.map((f) => str(f, 200)).filter(Boolean) : [];
    try {
      return c.json({ upload: await store.create(str(body?.supplier, 100), names, c.get("user")) }, 201);
    } catch (e) {
      return fail(e);
    }
  });

  app.get("/api/catalogues/:code", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const code = c.req.param("code");
    const first = await store.get(code);
    if (!first) return c.json({ error: "Catalogue upload not found." }, 404);
    if (!first.undoneAt && first.photos.processing) {
      try {
        const up = await store.open(code);
        await refreshPhotos(c.env, store, await store.processingFiles(100, up.id));
      } catch (e) {
        console.error("refresh photos", e);
      }
    }
    return c.json({ upload: await store.get(code) });
  });

  app.get("/api/catalogues/:code/items", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    try {
      return c.json(await store.items(c.req.param("code"), { q: (c.req.query("q") ?? "").slice(0, 100), offset: Number(c.req.query("offset")) || 0, limit: 50 }));
    } catch (e) {
      return fail(e);
    }
  });

  /** Which of these photo fingerprints are already in Shopify Files (so they're not uploaded twice). */
  app.post("/api/catalogues/:code/known", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ fingerprints?: unknown }>().catch(() => null);
    const fps = Array.isArray(body?.fingerprints) ? body.fingerprints.filter((f): f is string => typeof f === "string" && /^[a-f0-9]{64}$/.test(f)) : [];
    if (fps.length > L.knownBatch) return c.json({ error: `Send at most ${L.knownBatch} at a time.` }, 400);
    try {
      await store.open(c.req.param("code"));
      return c.json({ known: await store.knownFiles(fps) });
    } catch (e) {
      return fail(e);
    }
  });

  /**
   * One photo's bytes (from inside an Excel file, a ZIP or picked image files), streamed on to Shopify Files.
   * Headers: Content-Type (image/*), Content-Length, X-File-Name and X-Alt (URI-encoded), X-Fingerprint (SHA-256).
   */
  app.post("/api/catalogues/:code/photo", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const mimeType = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    const size = Number(c.req.header("Content-Length") ?? NaN);
    const fileName = decodeURIComponent(c.req.header("X-File-Name") ?? "").slice(0, 200) || "photo";
    const alt = decodeURIComponent(c.req.header("X-Alt") ?? "").slice(0, 500);
    const fingerprint = (c.req.header("X-Fingerprint") ?? "").toLowerCase();
    if (!IMAGE_TYPES.has(mimeType)) return c.json({ error: "Only JPG, PNG, GIF and WebP photos can go into Shopify." }, 415);
    if (!Number.isFinite(size) || size <= 0) return c.json({ error: "The photo is empty." }, 411);
    if (size > MAX_IMAGE_BYTES) return c.json({ error: "This photo is over Shopify's 20 MB limit." }, 413);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) return c.json({ error: "Missing photo fingerprint." }, 400);
    const stream = c.req.raw.body;
    if (!stream) return c.json({ error: "The photo is empty." }, 400);
    try {
      const up = await store.open(c.req.param("code"));
      const known = (await store.knownFiles([fingerprint]))[fingerprint];
      if (known && known.status !== "failed") {
        await stream.cancel().catch(() => {});
        return c.json({ photo: known, reused: true });
      }
      try {
        const photo = await uploadImage(c.env, { fileName, mimeType, size, stream, alt });
        try {
          await store.addFile({ ...photo, fingerprint, uploadId: up.id, source: fileName });
        } catch (e) {
          // It's in Shopify Files but couldn't be recorded here: remove it, so nothing is left behind unused.
          await deleteFiles(c.env, [photo.fileId]).catch(() => {});
          throw e;
        }
        return c.json({ photo });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await store.addFailedSource(up.id, fileName, msg).catch(() => {});
        return c.json({ error: msg }, 502);
      }
    } catch (e) {
      return fail(e);
    }
  });

  /**
   * Ask Shopify what really happened to photos still listed as processing. A page of 300 at a time (send `after`
   * from the last reply until `next` is null). Photos Shopify finished become ready. Photos it has no record of,
   * or has been "processing" for over 3 hours, are marked failed with the reason, so they can be tried again.
   */
  app.post("/api/catalogues/:code/check-photos", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ after?: unknown }>().catch(() => null);
    const after = Math.max(0, Math.floor(Number(body?.after ?? 0)) || 0);
    try {
      const up = await store.open(c.req.param("code"));
      const page = await store.processingPage(up.id, after, 301);
      const batch = page.slice(0, 300);
      const next = page.length > 300 ? batch[batch.length - 1]!.rid : null;
      const out = { checked: batch.length, ready: 0, failed: 0, gone: 0, waiting: 0, next };
      if (batch.length) {
        const now = await fileStatuses(c.env, batch.map((f) => f.fileId));
        const age = new Map(batch.map((f) => [f.fileId, Date.parse(f.createdAt)]));
        const cutoff = Date.now() - 3 * 3600_000;
        const gone: string[] = [];
        const stuck: string[] = [];
        const keep: typeof now = [];
        for (const f of now) {
          if (f.status === "deleted") gone.push(f.fileId);
          else if (f.status === "processing" && (age.get(f.fileId) ?? Date.now()) < cutoff) stuck.push(f.fileId);
          else keep.push(f);
        }
        await store.setFileStatuses(keep.map((f) => ({ fileId: f.fileId, status: f.status, url: f.url, error: f.error ?? null })));
        await store.failFiles(gone, "Shopify has no record of this photo. It was never saved there.");
        await store.failFiles(stuck, "Shopify was still processing this photo hours later, so it likely never downloaded it.");
        for (const f of keep) {
          if (f.status === "ready") out.ready++;
          else if (f.status === "failed") out.failed++;
          else out.waiting++;
        }
        out.gone = gone.length;
        out.failed += stuck.length;
      }
      return c.json(out);
    } catch (e) {
      return fail(e);
    }
  });

  /**
   * Try failed photos again by downloading each one here and uploading its bytes to Shopify, with the type found
   * from the bytes themselves. This fixes links whose server says the wrong type (or none), and says plainly what
   * any other failure is (a missing file, a web page, an AVIF or HEIC picture). Products that used the failed
   * photo switch to the new one. A page of 8 at a time: send `after` from the last reply until `next` is null.
   */
  app.post("/api/catalogues/:code/retry-failed", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ after?: unknown; size?: unknown; skip?: unknown }>().catch(() => null);
    const after = Math.max(0, Math.floor(Number(body?.after ?? 0)) || 0);
    // Photos per call. Big photos take the free Workers plan past its limits per call, so the browser asks for
    // fewer when a call is cut off, and as a last resort skips the one photo that can't be done (`skip`).
    const size = Math.min(20, Math.max(1, Math.floor(Number(body?.size ?? 3)) || 3));
    try {
      const up = await store.open(c.req.param("code"));
      if (body?.skip === true) {
        const [f] = await store.failedLinkFiles(up.id, after, 1);
        if (!f) return c.json({ fixed: 0, notFixed: 0, reasons: {}, next: null });
        const reason = "This photo is too big to process here on the free Cloudflare plan. Upload it to the product by hand.";
        await store.setFailedReason(f.fileId, reason).catch(() => {});
        const more = await store.failedLinkFiles(up.id, f.rid, 1);
        return c.json({ fixed: 0, notFixed: 1, reasons: { [reason]: 1 }, next: more.length ? f.rid : null });
      }
      const page = await store.failedLinkFiles(up.id, after, size + 1);
      const batch = page.slice(0, size);
      const next = page.length > size ? batch[batch.length - 1]!.rid : null;
      const out = { fixed: 0, notFixed: 0, reasons: {} as Record<string, number> };
      const replaced: string[] = [];
      for (const f of batch) {
        let reason = "";
        try {
          const res = await fetch(f.source, { headers: { Accept: "image/*,*/*;q=0.5", "User-Agent": "Mozilla/5.0 (compatible; PriceSaversImport)" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
          if (!res.ok) reason = `The supplier's server answered ${res.status} for this link.`;
          else {
            const len = Number(res.headers.get("content-length") ?? NaN);
            if (Number.isFinite(len) && len > MAX_IMAGE_BYTES) reason = "This photo is over Shopify's 20 MB limit.";
            else {
              const buf = new Uint8Array(await res.arrayBuffer());
              if (buf.byteLength > MAX_IMAGE_BYTES) reason = "This photo is over Shopify's 20 MB limit.";
              else {
                const kind = sniffImage(buf);
                if (!kind.ok) reason = `The link gives ${kind.what}, which Shopify can't use.`;
                else {
                  const stem = decodeURIComponent(new URL(f.source).pathname).split("/").pop()?.replace(/\.[A-Za-z0-9]{2,5}$/, "") || "photo";
                  // Named after the product (its title and code), like the photo was the first time.
                  const item = await store.itemForFile(f.fileId);
                  const generic = `${stem}.${kind.ext}`;
                  const named = item ? (catalogueFileName(item, item.position, generic) as string) : "";
                  const photo = await uploadImage(c.env, {
                    fileName: safeFileName(named && named !== generic ? named : generic, kind.ext),
                    mimeType: kind.mime,
                    size: buf.byteLength,
                    stream: new Blob([buf]).stream(),
                    alt: item ? (catalogueAlt(item, item.position, item.count) as string) : "",
                  });
                  await store.addFile({ ...photo, fingerprint: await sha256Hex(`url:${f.source}`), uploadId: up.id, source: f.source });
                  await store.mergeFiles([{ from: f.fileId, to: photo.fileId }]);
                  replaced.push(f.fileId);
                  out.fixed++;
                  continue;
                }
              }
            }
          }
        } catch (e) {
          reason = e instanceof Error ? e.message : String(e);
        }
        out.notFixed++;
        out.reasons[reason] = (out.reasons[reason] ?? 0) + 1;
        await store.setFailedReason(f.fileId, reason).catch(() => {});
      }
      if (replaced.length) await deleteFiles(c.env, replaced).catch(() => {}); // the failed copies left in Shopify Files
      return c.json({ ...out, next });
    } catch (e) {
      return fail(e);
    }
  });

  /** Photo links from the export. Shopify downloads each one now, so it doesn't matter if the links expire later. */
  app.post("/api/catalogues/:code/links", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ links?: unknown }>().catch(() => null);
    const raw = Array.isArray(body?.links) ? body.links : [];
    if (!raw.length || raw.length > L.linkBatch) return c.json({ error: `Send between 1 and ${L.linkBatch} links at a time.` }, 400);
    const links = raw.map((l) => {
      const r = (l ?? {}) as Record<string, unknown>;
      const url = typeof r.url === "string" ? r.url.trim() : "";
      return { url, ok: /^https?:\/\/[^\s]+$/i.test(url) && url.length < 2000, alt: str(r.alt, 500), name: str(r.name, 120) };
    });
    try {
      const up = await store.open(c.req.param("code"));
      const fps = await Promise.all(links.map((l) => sha256Hex(`url:${l.url}`)));
      const known = await store.knownFiles(fps);
      const results: { url: string; photo?: PhotoInfo; error?: string }[] = links.map((l) => ({ url: l.url }));
      const todo: number[] = [];
      links.forEach((l, i) => {
        if (!l.ok) results[i]!.error = "Not a web link.";
        else if (known[fps[i]!] && known[fps[i]!]!.status !== "failed") results[i]!.photo = known[fps[i]!];
        else todo.push(i);
      });
      // Thumbnails ("..._200x200.jpg") are swapped for a bigger version of the same picture when the server really
      // has one. The link as given stays the record of where the photo came from, and is the fallback.
      const bigger = c.env.PHOTO_UPGRADE === "false" ? todo.map(() => null) : await upgradePhotoLinks(todo.map((i) => links[i]!.url));
      const made = await createFiles(
        c.env,
        todo.map((i, k) => ({ source: bigger[k] ?? links[i]!.url, alt: links[i]!.alt, fileName: links[i]!.name || undefined })),
      );
      // If Shopify refuses a bigger link, use the original one for that photo.
      const refused = todo.map((_, k) => k).filter((k) => bigger[k] && !("fileId" in made[k]!));
      if (refused.length) {
        const again = await createFiles(
          c.env,
          refused.map((k) => ({ source: links[todo[k]!]!.url, alt: links[todo[k]!]!.alt, fileName: links[todo[k]!]!.name || undefined })),
        );
        refused.forEach((k, n) => (made[k] = again[n]!));
      }
      // Save everything in a couple of database calls: the new files, and the links Shopify couldn't take.
      const toSave: Parameters<typeof store.addFile>[0][] = [];
      const saveFor: number[] = []; // which link each file belongs to
      for (let k = 0; k < todo.length; k++) {
        const i = todo[k]!;
        const m = made[k];
        if (!m || !("fileId" in m)) {
          results[i]!.error = m?.error ?? "Shopify couldn't fetch this link.";
          toSave.push({ fileId: `failed:${up.id}:${crypto.randomUUID()}`, fingerprint: null, uploadId: up.id, status: "failed", url: null, source: links[i]!.url, error: results[i]!.error! });
          saveFor.push(-1);
          continue;
        }
        toSave.push({ fileId: m.fileId, fingerprint: fps[i]!, uploadId: up.id, status: m.status, url: m.url, source: links[i]!.url, error: m.error ?? null });
        saveFor.push(i);
      }
      const notSaved = await store.addFiles(toSave);
      const orphans: string[] = [];
      saveFor.forEach((i, n) => {
        if (i < 0) return;
        const m = made[todo.indexOf(i)] as PhotoInfo & { error?: string };
        if (notSaved.has(n)) {
          orphans.push(m.fileId);
          results[i]!.error = notSaved.get(n)!;
        } else if (m.status === "failed") results[i]!.error = m.error ?? "Shopify couldn't fetch this link.";
        else results[i]!.photo = { fileId: m.fileId, status: m.status, url: m.url };
      });
      if (orphans.length) await deleteFiles(c.env, orphans).catch(() => {});
      return c.json({ results });
    } catch (e) {
      return fail(e);
    }
  });

  app.post("/api/catalogues/:code/items", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ items?: unknown }>().catch(() => null);
    const raw = Array.isArray(body?.items) ? body.items : null;
    if (!raw || raw.length > L.itemBatch) return c.json({ error: `Send at most ${L.itemBatch} products at a time.` }, 400);
    const items: CatalogueItemIn[] = raw.map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      return {
        barcode: str(r.barcode, 64) || null,
        code: str(r.code, 64) || null,
        title: str(r.title, 255) || null,
        description: typeof r.description === "string" ? r.description.trim().slice(0, 5000) || null : null,
        photos: Array.isArray(r.photos) ? r.photos.filter((p): p is string => typeof p === "string" && FILE_ID_RE.test(p)).slice(0, MAX_PHOTOS_PER_ITEM) : [],
        mixed: r.mixed === true,
      };
    });
    try {
      return c.json({ added: await store.addItems(c.req.param("code"), items) });
    } catch (e) {
      return fail(e);
    }
  });

  app.post("/api/catalogues/:code/finish", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    try {
      return c.json({ upload: await store.finish(c.req.param("code")) });
    } catch (e) {
      return fail(e);
    }
  });

  /**
   * Remove, step 1: the upload stops matching at once. Returns how many photos are left to delete.
   * If products in the store use its photos, this is refused unless `confirm` is the catalogue's code
   * (typed in by the person), because those products lose the photos too.
   */
  app.post("/api/catalogues/:code/undo", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const code = c.req.param("code");
    const body = await c.req.json<{ confirm?: unknown }>().catch(() => null);
    try {
      const impact = await store.removalImpact(code);
      if (impact.products && String(body?.confirm ?? "").trim().toUpperCase() !== code.toUpperCase()) {
        return c.json(
          {
            error: `${impact.products === 1 ? "1 product" : `${impact.products} products`} in your store ${impact.products === 1 ? "uses" : "use"} photos from ${code}. Type ${code} to remove it anyway.`,
            code: "has_products",
            ...impact,
          },
          409,
        );
      }
      return c.json({ remaining: await store.startUndo(code, c.get("user")), products: impact.products });
    } catch (e) {
      return fail(e);
    }
  });

  /** Undo, step 2 (repeated by the page): delete the next photos from Shopify Files. */
  app.post("/api/catalogues/:code/undo-step", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    try {
      const code = c.req.param("code");
      const { uploadId, fileIds } = await store.undoBatch(code, L.undoBatch);
      // Products that got copies of these photos lose them too (this was confirmed in step 1).
      const copies = await store.attachmentsFor(fileIds);
      const mediaIds = copies.map((a) => a.mediaId).filter((m): m is string => !!m && FILE_ID_RE.test(m));
      for (let i = 0; i < mediaIds.length; i += 100) await deleteFiles(c.env, mediaIds.slice(i, i + 100));
      await store.markAttachmentsRemoved(copies.map((a) => a.id), code, c.get("user"));
      const deleted = await deleteFiles(c.env, fileIds);
      await store.markFilesDeleted(deleted);
      const remaining = await store.undoRemaining(uploadId);
      const stuck = fileIds.length - deleted.length;
      return c.json({ remaining, ...(stuck ? { error: `Shopify didn't delete ${stuck} photo${stuck === 1 ? "" : "s"}. Try again.` } : {}) });
    } catch (e) {
      return fail(e);
    }
  });

  /** Remove step 3: take the (undone, photo-free) upload off the list. */
  app.delete("/api/catalogues/:code", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    try {
      await store.removeUpload(c.req.param("code"));
      return c.json({ ok: true });
    } catch (e) {
      return fail(e);
    }
  });

  /* ------------------------------------------------------------ using the catalogue */

  /** Catalogue entries (with photos) for invoice lines. */
  app.post("/api/catalogue/match", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ matches: {} });
    const body = await c.req.json<{ supplier?: unknown; items?: unknown }>().catch(() => null);
    const raw = Array.isArray(body?.items) ? body.items : null;
    if (!raw || raw.length > L.matchBatch) return c.json({ error: `Send at most ${L.matchBatch} rows at a time.` }, 400);
    const lines = raw.map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      return { id: str(r.id, 64), barcode: str(r.barcode, 64) || null, code: str(r.supplierCode, 64) || null };
    });
    const matches = await store.match(lines.filter((l) => l.id), str(body?.supplier, 100) || null);
    return c.json({ matches: await freshMatches(c.env, store, matches) });
  });

  /** Products already in the store with no photo, that a catalogue has photos for. */
  app.get("/api/catalogue/missing-photos", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    try {
      // A page of the store at a time (send `after` from the last reply until `next` is null).
      const after = (c.req.query("after") ?? "").slice(0, 500);
      const page = await productsWithoutPhotos(c.env, after, 10);
      const products = page.products;
      // Products whose photos were removed with a catalogue: always checked (on the first page), even if they have other photos.
      const stripped = after ? [] : await store.strippedProducts();
      const strippedInfo = new Map(stripped.map((s) => [s.productId, s]));
      const known = new Set(products.map((p) => p.productId));
      const extra = await productsByIds(c.env, stripped.map((s) => s.productId).filter((id) => !known.has(id)));
      const all = [...products, ...[...extra.values()].filter((p): p is NonNullable<typeof p> => !!p)];
      const matches = await freshMatches(c.env, store, await store.matchStoreProducts(all));
      const tag = (p: (typeof all)[number]) => {
        const s = strippedInfo.get(p.productId);
        return s ? { catalogue: s.catalogue, removedAt: s.removedAt } : null;
      };
      const found = all
        // Photos Shopify is still processing count too (they're shown as "processing" and become ready shortly).
        .filter((p) => matches[p.productId]?.photos.some((ph) => ph.status === "ready" || ph.status === "processing"))
        .sort((a, b) => Number(!!strippedInfo.get(b.productId)) - Number(!!strippedInfo.get(a.productId)))
        .slice(0, 500)
        .map((p) => ({ product: p, match: matches[p.productId]!, stripped: tag(p) }));
      // Lost their photos, and no catalogue has new ones yet: they show up here once one does.
      const waiting = all
        .filter((p) => strippedInfo.has(p.productId) && !found.some((f) => f.product.productId === p.productId))
        .map((p) => ({ product: p, stripped: tag(p) }));
      return c.json({ checked: products.length, scanned: page.scanned, found, waiting, next: page.next });
    } catch (e) {
      return fail(e);
    }
  });

  /** How many products that lost their photos a catalogue could give photos to now (for the done screen). */
  app.get("/api/catalogue/stripped", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ products: 0, matched: 0 });
    const stripped = await store.strippedProducts();
    if (!stripped.length) return c.json({ products: 0, matched: 0 });
    const live = [...(await productsByIds(c.env, stripped.map((s) => s.productId))).values()].filter((p): p is NonNullable<typeof p> => !!p);
    const matches = await store.matchStoreProducts(live);
    return c.json({ products: live.length, matched: live.filter((p) => matches[p.productId]?.photos.length).length });
  });

  /** Give existing products copies of catalogue photos. */
  app.post("/api/catalogue/attach", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ items?: unknown }>().catch(() => null);
    const raw = Array.isArray(body?.items) ? body.items : [];
    if (!raw.length || raw.length > L.attachBatch) return c.json({ error: `Send between 1 and ${L.attachBatch} products at a time.` }, 400);
    const items = raw.map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      return {
        productId: typeof r.productId === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(r.productId) ? r.productId : "",
        title: str(r.title, 255),
        fileIds: Array.isArray(r.fileIds) ? r.fileIds.filter((p): p is string => typeof p === "string" && FILE_ID_RE.test(p)).slice(0, MAX_PHOTOS_PER_ITEM) : [],
      };
    });
    const files = await store.filesById(items.flatMap((i) => i.fileIds));
    const results = [];
    for (const it of items) {
      const photos = it.fileIds.map((id) => files.get(id)).filter((f): f is PhotoInfo => !!f && f.status === "ready" && !!f.url);
      if (!it.productId || !photos.length) {
        results.push({ productId: it.productId, ok: false, error: "No ready photos for this product." });
        continue;
      }
      const res = await addPhotosToProduct(c.env, it.productId, namedPhotos(it.title, photos.map((p) => p.url!)));
      if (res.error) {
        // Shopify can add the photos and still answer with an error (a timeout, a warning). Look before saying "Not added".
        const now = await productsByIds(c.env, [it.productId]).then((m) => m.get(it.productId)).catch(() => null);
        if (!now?.hasPhotos) {
          results.push({ productId: it.productId, ok: false, error: res.error });
          continue;
        }
        results.push({ productId: it.productId, ok: true, photos: photos.length });
        continue;
      }
      await store
        .recordAttachments(photos.map((p, k) => ({ productId: it.productId, title: it.title, mediaId: res.mediaIds[k] ?? null, fileId: p.fileId, source: "fill" as const })), c.get("user"))
        .catch((e) => console.error("record attachments", e));
      results.push({ productId: it.productId, ok: true, photos: photos.length });
    }
    return c.json({ results });
  });

  /* ------------------------------------------------------------ better photos from newer catalogues */

  /**
   * Products whose photo a catalogue might improve, for the browser to compare. `mode`:
   *  - "all": the whole store, newest first, a few hundred products per call (send `after` until `next` is null);
   *  - "upload": the products carrying one catalogue's barcodes (`code`, then `after` as a number);
   *  - "products": just these product IDs (from an invoice).
   */
  app.post("/api/photo-updates/candidates", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown; after?: unknown; code?: unknown; productIds?: unknown } | null;
    const mode = body?.mode;
    try {
      if (mode === "all") {
        const page = await productsWithPhotos(c.env, typeof body?.after === "string" ? body.after.slice(0, 500) : "");
        return c.json({ candidates: await candidatesFor(c.env, store, page.products), scanned: page.scanned, next: page.next });
      }
      if (mode === "upload") {
        const code = str(body?.code, 20);
        const offset = Math.max(0, Math.floor(Number(body?.after ?? 0)) || 0);
        const page = await productsForUpload(c.env, store, code, offset);
        const products = await productsById(c.env, page.ids);
        return c.json({ candidates: await candidatesFor(c.env, store, products), scanned: page.items, next: page.next });
      }
      if (mode === "products") {
        const ids = (Array.isArray(body?.productIds) ? body!.productIds : []).filter((x): x is string => typeof x === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(x)).slice(0, 200);
        const products = await productsById(c.env, ids);
        return c.json({ candidates: await candidatesFor(c.env, store, products), scanned: products.length, next: null });
      }
      return c.json({ error: "Say which products to check." }, 400);
    } catch (e) {
      return fail(e);
    }
  });

  /**
   * A small copy of a Shopify photo, for the browser to fingerprint (the page may only fetch from this site).
   * Shopify's own image addresses only.
   */
  app.get("/api/photo-updates/image", async (c) => {
    let u: URL;
    try {
      u = new URL(c.req.query("url") ?? "");
    } catch {
      return c.json({ error: "Not a photo address." }, 400);
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || !(host === "cdn.shopify.com" || host.endsWith(".myshopify.com") || host.endsWith(".shopifycdn.com") || host.endsWith(".shopifycdn.net"))) {
      return c.json({ error: "Only Shopify's photos can be fetched here." }, 400);
    }
    u.searchParams.set("width", "256");
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) return c.json({ error: "The photo couldn't be fetched." }, 502);
    const type = res.headers.get("content-type") ?? "image/jpeg";
    if (!type.startsWith("image/")) return c.json({ error: "That isn't a photo." }, 502);
    return new Response(res.body, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" } });
  });

  /** Carry out the browser's decisions (up to 10 at a time). */
  app.post("/api/photo-updates/apply", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
    const raw = Array.isArray(body?.items) ? (body!.items as Record<string, unknown>[]) : [];
    if (!raw.length || raw.length > 10) return c.json({ error: "Send between 1 and 10 at a time." }, 400);
    const results = [];
    for (const r of raw) {
      const old = (r?.old ?? {}) as Record<string, unknown>;
      const it: ApplyItem = {
        productId: typeof r?.productId === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(r.productId) ? r.productId : "",
        title: str(r?.title, 255),
        fileId: typeof r?.fileId === "string" && FILE_ID_RE.test(r.fileId) ? r.fileId : "",
        kind: r?.kind === "sharper" || r?.kind === "new" ? r.kind : "none",
        old: { mediaId: str(old.mediaId, 100), url: str(old.url, 1000), width: Number(old.width) || 0, height: Number(old.height) || 0 },
      };
      if (!it.productId || !it.fileId || !/^gid:\/\/shopify\/MediaImage\/\d+$/.test(it.old.mediaId)) {
        results.push({ productId: it.productId, ok: false, error: "Not a product photo this can change." });
        continue;
      }
      try {
        results.push({ productId: it.productId, kind: it.kind, ...(await applyUpdate(c.env, store, it, c.get("user"))) });
      } catch (e) {
        results.push({ productId: it.productId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return c.json({ results });
  });

  /** The changes made: to review (new photos put in front) or everything recent. */
  app.get("/api/photo-updates", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ rows: [], next: null, counts: { review: 0, sharper: 0, newer: 0 } });
    const view = c.req.query("view") === "recent" ? "recent" : "review";
    const before = Math.max(0, Number(c.req.query("before")) || 0);
    const products = (c.req.query("products") ?? "").split(",").filter((x) => /^gid:\/\/shopify\/Product\/\d+$/.test(x)).slice(0, 200);
    const page = await store.photoUpdates(view, before, 50, products.length ? products : undefined);
    return c.json({ ...page, counts: await store.photoUpdateCounts() });
  });

  app.post("/api/photo-updates/:id/decide", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = (await c.req.json().catch(() => null)) as { action?: unknown } | null;
    const action = body?.action;
    if (action !== "use-new" && action !== "keep-both" && action !== "put-back") return c.json({ error: "Choose what to do with the photo." }, 400);
    const res = await decideUpdate(c.env, store, Number(c.req.param("id")) || 0, action, c.get("user"));
    return c.json(res, res.ok ? 200 : 409);
  });

  /* ------------------------------------------------------------ look-alike photos */

  app.get("/api/catalogue/signatures", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ files: [], next: null, missing: 0 });
    const after = Math.max(0, Number(c.req.query("after")) || 0);
    const page = await store.signatures(after, L.signaturePage);
    return c.json({ ...page, missing: after ? 0 : await store.countMissingSignatures() });
  });

  app.get("/api/catalogue/signatures/missing", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ files: [] });
    const files = await store.missingSignatures(L.signatureBatch);
    const siblings = await store.siblingsOf(files.map((f) => f.fileId));
    return c.json({ files: files.map((f) => ({ ...f, siblings: (siblings[f.fileId] ?? []).slice(0, 20) })) });
  });

  app.post("/api/catalogue/signatures", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ items?: unknown }>().catch(() => null);
    const raw = Array.isArray(body?.items) ? body.items : [];
    if (raw.length > L.signatureBatch) return c.json({ error: `Send at most ${L.signatureBatch} at a time.` }, 400);
    const items = raw
      .map((x) => (x ?? {}) as Record<string, unknown>)
      .filter(
        (r) =>
          typeof r.fileId === "string" &&
          FILE_ID_RE.test(r.fileId) &&
          typeof r.sig === "string" &&
          /^v1\.[0-9a-f]{64}\.[0-9a-f]{96}\.\d{1,6}$/.test(r.sig) &&
          typeof r.thumb === "string" &&
          r.thumb.length <= 24_000 &&
          /^[A-Za-z0-9+/=]+$/.test(r.thumb),
      )
      .map((r) => ({ fileId: r.fileId as string, sig: r.sig as string, thumb: r.thumb as string, pixels: Math.max(0, Math.min(1e9, Number(r.pixels) || 0)) }));
    await store.setSignatures(items);
    return c.json({ saved: items.length });
  });

  app.post("/api/catalogue/thumbs", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ thumbs: {} });
    const body = await c.req.json<{ fileIds?: unknown }>().catch(() => null);
    const ids = Array.isArray(body?.fileIds) ? body.fileIds.filter((x): x is string => typeof x === "string" && FILE_ID_RE.test(x)) : [];
    if (ids.length > L.thumbBatch) return c.json({ error: `Ask for at most ${L.thumbBatch} at a time.` }, 400);
    return c.json({ thumbs: await store.thumbs(ids) });
  });

  /** Merge look-alike photos (found by the page), deleting the extra copies from Shopify Files. */
  app.post("/api/catalogue/merge", async (c) => {
    const store = storeOf(c.env);
    if (!store) return c.json({ error: NO_DB }, 503);
    const body = await c.req.json<{ pairs?: unknown }>().catch(() => null);
    const raw = Array.isArray(body?.pairs) ? body.pairs : [];
    if (!raw.length || raw.length > L.mergeBatch) return c.json({ error: `Send between 1 and ${L.mergeBatch} pairs.` }, 400);
    const pairs = raw
      .map((x) => (x ?? {}) as Record<string, unknown>)
      .filter((r) => typeof r.from === "string" && typeof r.to === "string" && FILE_ID_RE.test(r.from) && FILE_ID_RE.test(r.to))
      .map((r) => ({ from: r.from as string, to: r.to as string }));
    const merged = await store.mergeFiles(pairs);
    let deleted: string[] = [];
    try {
      deleted = await deleteFiles(c.env, merged);
    } catch (e) {
      console.error("merge: delete", e); // the catalogue no longer uses them either way
    }
    return c.json({ merged: merged.length, deleted: deleted.length });
  });

  /** Work out a catalogue spreadsheet's columns from its first rows. */
  app.post("/api/catalogue/map", async (c) => {
    const body = await c.req.json<{ sample?: unknown }>().catch(() => null);
    const sample = typeof body?.sample === "string" ? body.sample : "";
    if (!sample.trim()) return c.json({ error: "The spreadsheet is empty." }, 400);
    if (sample.length > 80_000) return c.json({ error: "Send only the first rows." }, 413);
    const attempt = Math.min(5, Math.max(1, Number.parseInt(c.req.header("X-AI-Attempt") ?? "1", 10) || 1));
    try {
      return c.json(await mapColumns(c.env, sample, attempt));
    } catch (e) {
      if (e instanceof ExtractionError) return c.json({ error: e.message, retryable: e.retryable }, 422);
      throw e;
    }
  });
}
