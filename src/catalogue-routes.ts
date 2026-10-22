import { namedPhotos } from "./photo-names";
import type { Hono } from "hono";
import type { Env } from "./types";
import { CatalogueStore, FILE_ID_RE, MAX_PHOTOS_PER_ITEM, type CatalogueItemIn, type CatalogueMatch, type PhotoInfo } from "./catalogue";
import { upgradePhotoLinks } from "./photo-upgrade";
import { addPhotosToProduct, createFiles, deleteFiles, fileStatuses, IMAGE_TYPES, MAX_IMAGE_BYTES, productsByIds, productsWithoutPhotos, uploadImage } from "./files";
import { mapColumns } from "./catalogue-map";
import { ExtractionError } from "./extract";
import { ShopifyError } from "./shopify";
import { StoreError } from "./store";
import { CATALOGUE_LIMITS as L } from "./limits";

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
      const products = await productsWithoutPhotos(c.env);
      // Products whose photos were removed with a catalogue: always checked, even if they have other photos.
      const stripped = await store.strippedProducts();
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
      return c.json({ checked: products.length, found, waiting });
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
