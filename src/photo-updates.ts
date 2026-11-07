/**
 * Better photos from newer catalogues, for products already in the store.
 *
 * The server finds products whose main photo might be improved (a catalogue item matches them by barcode, or by
 * supplier code for the same supplier, and has a ready photo the product doesn't already have). The browser then
 * compares the two pictures by their visual fingerprints and says which case it is:
 *  - "sharper": the same picture, clearly bigger. The product's photo is swapped for the bigger copy.
 *  - "new": a different picture, from a catalogue saved after the current photo. It goes in front as the main photo
 *    and the old one stays on as the second photo, so nothing is lost; it's listed for someone to look at.
 *  - "none": nothing better. Remembered, so the pair isn't looked at again.
 * Every change is logged in photo_updates. A "new" one can be put back, kept with both photos, or finished by
 * taking the old photo off.
 */
import { analyzeBarcode } from "./barcode";
import { CatalogueStore, type CatalogueMatch } from "./catalogue";
import { addPhotosToProduct, deleteFiles } from "./files";
import { namedPhotos } from "./photo-names";
import { findVariantsByBarcodes, gql } from "./shopify";
import type { Env } from "./types";

export interface StoreProduct {
  productId: string;
  title: string;
  vendor: string;
  barcode: string;
  sku: string;
  featured: { mediaId: string; url: string; width: number; height: number; createdAt: string } | null;
}

export interface Candidate {
  productId: string;
  title: string;
  current: { mediaId: string; url: string; width: number; height: number; createdAt: string; sig: string | null };
  next: { fileId: string; url: string; width: number; height: number; createdAt: string; sig: string | null; catalogue: string; supplier: string };
}

const PRODUCT_FIELDS = `id title vendor
  variants(first: 1) { nodes { barcode sku } }
  featuredMedia { id ... on MediaImage { createdAt image { url width height } } }`;

type ProductNode = {
  id: string;
  title: string;
  vendor: string | null;
  variants: { nodes: { barcode: string | null; sku: string | null }[] };
  featuredMedia: { id: string; createdAt?: string; image?: { url: string; width: number; height: number } | null } | null;
};

const toProduct = (n: ProductNode): StoreProduct => {
  const v = n.variants.nodes[0];
  const m = n.featuredMedia;
  return {
    productId: n.id,
    title: n.title,
    vendor: n.vendor ?? "",
    barcode: v?.barcode ?? "",
    sku: v?.sku ?? "",
    featured: m?.image?.url ? { mediaId: m.id, url: m.image.url, width: m.image.width ?? 0, height: m.image.height ?? 0, createdAt: m.createdAt ?? "" } : null,
  };
};

/** Store products with a photo, newest first, `pages` × 100 from a Shopify cursor ("" for the start). */
export async function productsWithPhotos(env: Env, after = "", pages = 5): Promise<{ products: StoreProduct[]; scanned: number; next: string | null }> {
  type R = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ProductNode[] } };
  const out: StoreProduct[] = [];
  let cursor: string | null = after || null;
  let scanned = 0;
  for (let page = 0; page < pages; page++) {
    const data: R = await gql<R>(
      env,
      `query PP($cursor: String) { products(first: 100, after: $cursor, sortKey: ID, reverse: true) { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`,
      { cursor },
    );
    scanned += data.products.nodes.length;
    for (const n of data.products.nodes) {
      const p = toProduct(n);
      if (p.featured) out.push(p);
    }
    if (!data.products.pageInfo.hasNextPage) return { products: out, scanned, next: null };
    cursor = data.products.pageInfo.endCursor;
  }
  return { products: out, scanned, next: cursor };
}

/** These store products, with their main photo. */
export async function productsById(env: Env, ids: string[]): Promise<StoreProduct[]> {
  const out: StoreProduct[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await gql<{ nodes: (ProductNode | null)[] }>(env, `query PI($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } } }`, { ids: ids.slice(i, i + 100) });
    for (const n of data.nodes) if (n?.id) out.push(toProduct(n));
  }
  return out;
}

/** Store products that carry the barcodes of one catalogue's items (a page of items at a time). */
export async function productsForUpload(env: Env, store: CatalogueStore, code: string, offset: number, limit = 150): Promise<{ ids: string[]; next: number | null; items: number }> {
  const page = await store.items(code, { offset, limit });
  const barcodes = page.items.map((i) => i.barcode).filter((b): b is string => !!b && !!analyzeBarcode(b).key);
  const found = barcodes.length ? await findVariantsByBarcodes(env, barcodes) : [];
  return { ids: [...new Set(found.map((f) => f.productId))], next: page.more ? offset + limit : null, items: page.items.length };
}

/** Which products could get a better photo, with what's needed to compare the two pictures. */
export async function candidatesFor(env: Env, store: CatalogueStore, products: StoreProduct[]): Promise<Candidate[]> {
  const withPhoto = products.filter((p) => p.featured);
  if (!withPhoto.length) return [];
  const matches: Record<string, CatalogueMatch> = await store.matchStoreProducts(withPhoto);
  const ids = withPhoto.map((p) => p.productId);
  const [have, seen] = await Promise.all([store.photosOnProducts(ids), store.photoPairsSeen(ids)]);
  const picks: { p: StoreProduct; fileId: string; m: CatalogueMatch }[] = [];
  for (const p of withPhoto) {
    const m = matches[p.productId];
    if (!m || m.mixed) continue; // a photo of several colours isn't this product's own photo
    const photo = m.photos.find((ph) => ph.status === "ready" && ph.url);
    if (!photo) continue;
    if (have.files.get(p.productId)?.has(photo.fileId)) continue; // already on the product
    if (have.mediaFile.get(p.featured!.mediaId) === photo.fileId) continue;
    if (seen.has(`${p.productId}|${photo.fileId}`)) continue; // looked at before
    picks.push({ p, fileId: photo.fileId, m });
  }
  if (!picks.length) return [];
  // The catalogue photos' own sizes and dates, from Shopify (they're files there), and their fingerprints.
  const fileIds = [...new Set(picks.map((x) => x.fileId))];
  const currentFiles = [...new Set(picks.map((x) => have.mediaFile.get(x.p.featured!.mediaId)).filter((f): f is string => !!f))];
  const details = await store.fileDetails([...fileIds, ...currentFiles]);
  const dims = new Map<string, { url: string; width: number; height: number; createdAt: string }>();
  for (let i = 0; i < fileIds.length; i += 100) {
    const data = await gql<{ nodes: ({ id: string; createdAt?: string; image?: { url: string; width: number; height: number } | null } | null)[] }>(
      env,
      `query FI($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id createdAt image { url width height } } } }`,
      { ids: fileIds.slice(i, i + 100) },
    );
    for (const n of data.nodes) if (n?.id && n.image?.url) dims.set(n.id, { url: n.image.url, width: n.image.width ?? 0, height: n.image.height ?? 0, createdAt: n.createdAt ?? "" });
  }
  const out: Candidate[] = [];
  for (const { p, fileId, m } of picks) {
    const d = dims.get(fileId);
    if (!d) continue; // gone from Shopify Files
    const f = details.get(fileId);
    const curFile = have.mediaFile.get(p.featured!.mediaId);
    out.push({
      productId: p.productId,
      title: p.title,
      current: { ...p.featured!, sig: curFile ? (details.get(curFile)?.sig ?? null) : null },
      next: { fileId, url: d.url, width: d.width, height: d.height, createdAt: f?.createdAt || d.createdAt, sig: f?.sig ?? null, catalogue: m.catalogue, supplier: m.supplier },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ changing photos */

/** Put a product's media in this order position (0 is the main photo). Shopify does it in the background. */
async function moveMedia(env: Env, productId: string, mediaId: string, position: number): Promise<string | null> {
  try {
    const res = await gql<{ productReorderMedia: { userErrors: { message: string }[] } }>(
      env,
      `mutation Move($id: ID!, $moves: [MoveInput!]!) { productReorderMedia(id: $id, moves: $moves) { job { id } userErrors { field message } } }`,
      { id: productId, moves: [{ id: mediaId, newPosition: String(position) }] },
    );
    const e = res.productReorderMedia.userErrors;
    return e.length ? e.map((x) => x.message).join("; ") : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export interface ApplyItem {
  productId: string;
  title: string;
  fileId: string;
  kind: "sharper" | "new" | "none";
  old: { mediaId: string; url: string; width: number; height: number };
}

/**
 * Carry out what the browser decided. "sharper": the bigger copy goes in as the main photo and the old copy comes
 * off. "new": it goes in as the main photo and the old one stays second. "none": just remembered.
 */
export async function applyUpdate(env: Env, store: CatalogueStore, it: ApplyItem, user: string): Promise<{ ok: boolean; error?: string; id?: number | null }> {
  const base = { productId: it.productId, title: it.title, fileId: it.fileId, kind: it.kind, oldMediaId: it.old.mediaId, oldUrl: it.old.url, oldSize: `${it.old.width}x${it.old.height}` };
  if (it.kind === "none") return { ok: true, id: await store.addPhotoUpdate({ ...base, status: "none" }, user) };
  const files = await store.filesById([it.fileId]);
  const f = files.get(it.fileId);
  if (!f || f.status !== "ready" || !f.url) return { ok: false, error: "That catalogue photo isn't ready in Shopify." };
  const details = (await store.fileDetails([it.fileId])).get(it.fileId);
  const added = await addPhotosToProduct(env, it.productId, namedPhotos(it.title, [f.url]));
  const mediaId = added.mediaIds[0];
  if (added.error || !mediaId) {
    await store.addPhotoUpdate({ ...base, status: "failed", error: added.error ?? "Shopify didn't add the photo." }, user);
    return { ok: false, error: added.error ?? "Shopify didn't add the photo." };
  }
  await store.recordAttachments([{ productId: it.productId, title: it.title, mediaId, fileId: it.fileId, source: "update" }], user).catch(() => {});
  const moveError = await moveMedia(env, it.productId, mediaId, 0);
  let error = moveError ? `The new photo was added but couldn't be made the main photo: ${moveError}` : null;
  if (it.kind === "sharper" && !moveError) {
    // The same picture, so the smaller copy has nothing left to give.
    const gone = await deleteFiles(env, [it.old.mediaId]).catch(() => []);
    if (gone.length) await store.markMediaRemoved([it.old.mediaId], "replaced_sharper", user).catch(() => {});
    else error = "The sharper photo is now the main photo, but the old copy couldn't be removed.";
  }
  const id = await store.addPhotoUpdate({ ...base, status: "applied", newMediaId: mediaId, newUrl: f.url, newSize: details?.pixels ? String(details.pixels) : null, catalogue: details?.catalogue ?? null, error }, user);
  return { ok: true, id, ...(error ? { error } : {}) };
}

/**
 * A decision on a new photo: "use-new" takes the old photo off, "keep-both" leaves both, "put-back" makes the old
 * photo the main one again and takes the new one off. Sharper swaps can't be put back (it was the same picture).
 */
export async function decideUpdate(env: Env, store: CatalogueStore, id: number, action: "use-new" | "keep-both" | "put-back", user: string): Promise<{ ok: boolean; error?: string; status?: string }> {
  const u = await store.photoUpdate(id);
  if (!u) return { ok: false, error: "That photo change wasn't found." };
  if (u.kind !== "new" || u.status !== "applied") return { ok: false, error: "This photo change has already been dealt with." };
  if (action === "keep-both") {
    await store.setPhotoUpdateStatus(id, "kept_both", user);
    return { ok: true, status: "kept_both" };
  }
  if (action === "use-new") {
    if (u.oldMediaId) {
      const gone = await deleteFiles(env, [u.oldMediaId]).catch(() => []);
      if (!gone.length) return { ok: false, error: "The old photo couldn't be removed. Try again." };
      await store.markMediaRemoved([u.oldMediaId], "replaced_new", user).catch(() => {});
    }
    await store.setPhotoUpdateStatus(id, "kept_new", user);
    return { ok: true, status: "kept_new" };
  }
  // Put back: the old one first again, then the new one off.
  if (u.oldMediaId) {
    const e = await moveMedia(env, u.productId, u.oldMediaId, 0);
    if (e) return { ok: false, error: `The old photo couldn't be put back: ${e}` };
  }
  if (u.newMediaId) {
    await deleteFiles(env, [u.newMediaId]).catch(() => []);
    await store.markMediaRemoved([u.newMediaId], "put_back", user).catch(() => {});
  }
  await store.setPhotoUpdateStatus(id, "undone", user);
  return { ok: true, status: "undone" };
}
