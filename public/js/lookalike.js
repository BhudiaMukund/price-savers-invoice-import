// Finding look-alike photos: the same picture resized or saved again, from a newer export or another
// supplier. Everything is compared here in the browser; the server only stores fingerprints.
//  1. A loose check on the fingerprints picks the few stored photos worth a close look.
//  2. A 64 x 64 pixel-by-pixel comparison decides (see phash.js for how strict it is).

import { maybeSame, parseSignature, sameByThumb, signatureOf } from "./phash.js";

let fflate = null;
const FFLATE = "/vendor/fflate.min.js";
const lib = () => (fflate ??= import(/* @vite-ignore */ FFLATE)); // loaded only when needed

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Thumbnails are stored compressed (mostly white backgrounds: they shrink a lot). */
export async function packThumb(thumb) {
  const { deflateSync } = await lib();
  return toBase64(deflateSync(thumb, { level: 9 }));
}
export async function unpackThumb(b64) {
  const { inflateSync } = await lib();
  return inflateSync(fromBase64(b64));
}

/** Fingerprint of a photo's bytes. Null if the browser can't decode it. */
export async function describe(bytes, type) {
  try {
    const { sig, thumb, pixels } = await signatureOf(new Blob([bytes], { type }));
    return { sig, parsed: parseSignature(sig), thumb, pixels };
  } catch {
    return null;
  }
}

/** The photos already stored, with their fingerprints, for comparing new ones against. */
export async function loadLibrary(api) {
  const { files } = await api.photoSignatures();
  const stored = files.map((f) => ({ fileId: f.fileId, pixels: f.pixels ?? 0, parsed: parseSignature(f.sig) })).filter((f) => f.parsed);
  const thumbs = new Map();
  return {
    stored,
    /** Close-compare a photo with stored candidates; returns the best stored match or null. */
    async match(d, exclude = null) {
      if (!d?.parsed) return null;
      const cands = stored.filter((s) => s.fileId !== exclude && maybeSame(d.parsed, s.parsed)).slice(0, 40);
      const need = cands.map((c) => c.fileId).filter((id) => !thumbs.has(id));
      for (let i = 0; i < need.length; i += 200) {
        const res = await api.photoThumbs(need.slice(i, i + 200));
        for (const id of need.slice(i, i + 200)) thumbs.set(id, res.thumbs[id] ? await unpackThumb(res.thumbs[id]) : null);
      }
      return cands.find((c) => sameByThumb(d.thumb, thumbs.get(c.fileId))) ?? null;
    },
    add(fileId, d) {
      if (!d?.parsed) return;
      stored.push({ fileId, pixels: d.pixels, parsed: d.parsed });
      thumbs.set(fileId, d.thumb);
    },
  };
}

/** Which of two look-alikes to keep: the clearly sharper one (1.5x the pixels), otherwise the one stored first. */
export function keepOf(a, b) {
  if (a.pixels >= b.pixels * 1.5) return a;
  if (b.pixels >= a.pixels * 1.5) return b;
  const n = (x) => Number(String(x.fileId).split("/").pop()) || 0;
  return n(a) <= n(b) ? a : b;
}

/**
 * Tidy the stored photos in the background: fingerprint the ones that have none yet (photo links, and
 * photos stored before this check existed) from Shopify's copy, and merge any that turn out to be
 * look-alikes of one already stored. Runs a batch at a time; returns how many were merged.
 */
let tidying = null;
export function tidyLibrary(api) {
  tidying ??= (async () => {
    let merged = 0;
    try {
      for (let round = 0; round < 10; round++) {
        const { files } = await api.photosWithoutSignature();
        if (!files.length) break;
        const library = await loadLibrary(api);
        const fresh = [];
        for (const f of files) {
          let d = null;
          try {
            const res = await fetch(f.url, { mode: "cors", credentials: "omit" });
            if (res.ok) d = await describe(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type") ?? "image/jpeg");
          } catch {
            d = null;
          }
          if (!d) return merged; // Shopify's copies can't be read from this page: stop quietly
          fresh.push({ fileId: f.fileId, d });
        }
        await api.saveSignatures(await Promise.all(fresh.map(async (f) => ({ fileId: f.fileId, sig: f.d.sig, thumb: await packThumb(f.d.thumb), pixels: f.d.pixels }))));
        const pairs = [];
        for (const f of fresh) {
          const hit = await library.match(f.d, f.fileId);
          if (hit) {
            const keep = keepOf({ fileId: f.fileId, pixels: f.d.pixels }, hit);
            pairs.push(keep.fileId === f.fileId ? { from: hit.fileId, to: f.fileId } : { from: f.fileId, to: hit.fileId });
          }
          library.add(f.fileId, f.d);
        }
        for (let i = 0; i < pairs.length; i += 25) merged += (await api.mergePhotos(pairs.slice(i, i + 25))).merged;
        if (files.length < 50) break;
      }
    } catch (err) {
      console.warn("Photo tidy stopped:", err);
    } finally {
      tidying = null;
    }
    return merged;
  })();
  return tidying;
}
