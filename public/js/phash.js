// Visual fingerprints for photos, so a picture that was resized or saved again (a supplier's new export,
// the same manufacturer photo from two suppliers) is recognised as one already stored.
//
// A fingerprint has three parts, and two photos only count as the same when all three agree:
//  - shape: a 16 x 16 "difference hash" of the brightness (256 bits). Survives resizing and re-compression,
//    but tells a "1" from a "2" on a number balloon.
//  - colour: the average colour of a 4 x 4 grid. Tells the gold banner from the silver one, which have the
//    same shape.
//  - proportions: width / height.
// Pure functions on RGBA pixels, so the tests run them without a browser.

const SIDE = 16;

/** Shrink RGBA pixels to w x h by averaging the source pixels that fall in each cell. */
function boxResize(data, sw, sh, w, h) {
  const out = new Float64Array(w * h * 3);
  const count = new Float64Array(w * h);
  for (let y = 0; y < sh; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / sh));
    for (let x = 0; x < sw; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / sw));
      const i = (y * sw + x) * 4;
      const a = data[i + 3] / 255;
      // Transparent pixels count as white (how a product photo on a transparent background looks on a page).
      const t = ty * w + tx;
      out[t * 3] += data[i] * a + 255 * (1 - a);
      out[t * 3 + 1] += data[i + 1] * a + 255 * (1 - a);
      out[t * 3 + 2] += data[i + 2] * a + 255 * (1 - a);
      count[t]++;
    }
  }
  for (let t = 0; t < w * h; t++) for (let c = 0; c < 3; c++) out[t * 3 + c] /= count[t] || 1;
  return out;
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Fingerprint of RGBA pixels: "v1.<shape hex>.<colour hex>.<proportions x1000>". */
export function signatureFromRGBA(data, width, height) {
  // Shape: brightness on a 17 x 16 grid, then whether each cell is brighter than its right-hand neighbour.
  const g = boxResize(data, width, height, SIDE + 1, SIDE);
  const lum = (i) => 0.299 * g[i * 3] + 0.587 * g[i * 3 + 1] + 0.114 * g[i * 3 + 2];
  const bits = new Uint8Array((SIDE * SIDE) / 8);
  let n = 0;
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++, n++) {
      if (lum(y * (SIDE + 1) + x) > lum(y * (SIDE + 1) + x + 1)) bits[n >> 3] |= 1 << (n & 7);
    }
  }
  // Colour: average of a 4 x 4 grid, one byte per channel.
  const c = boxResize(data, width, height, 4, 4);
  const colour = new Uint8Array(48);
  for (let i = 0; i < 48; i++) colour[i] = Math.round(c[i]);
  return `v1.${hex(bits)}.${hex(colour)}.${Math.round((width / height) * 1000)}`;
}

/** Parsed once per fingerprint, so comparing thousands is quick. */
export function parseSignature(sig) {
  const m = /^v1\.([0-9a-f]{64})\.([0-9a-f]{96})\.(\d+)$/.exec(sig ?? "");
  if (!m) return null;
  const shape = new Uint32Array(8);
  for (let i = 0; i < 8; i++) shape[i] = parseInt(m[1].slice(i * 8, i * 8 + 8), 16);
  const colour = new Uint8Array(48);
  for (let i = 0; i < 48; i++) colour[i] = parseInt(m[2].slice(i * 2, i * 2 + 2), 16);
  return { shape, colour, ratio: Number(m[3]) / 1000 };
}

function popcount(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** How far apart two fingerprints are: shape bits that differ (of 256), and the average colour gap (0-255). */
export function distance(a, b) {
  let bits = 0;
  for (let i = 0; i < 8; i++) bits += popcount(a.shape[i] ^ b.shape[i]);
  let col = 0;
  for (let i = 0; i < 48; i++) col += Math.abs(a.colour[i] - b.colour[i]);
  return { bits, colour: col / 48, ratio: Math.abs(a.ratio - b.ratio) / Math.max(a.ratio, b.ratio) };
}

export const LIMITS = { ratio: 0.03 };

/** Browser only: fingerprint of an image (Blob, or an <img> that has loaded). */
export async function signatureOf(source) {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const w0 = bmp.naturalWidth ?? bmp.width;
  const h0 = bmp.naturalHeight ?? bmp.height;
  // Work from a copy no bigger than 256 px: plenty for a 16 x 16 fingerprint, and quick.
  const scale = Math.min(1, 256 / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  if (source instanceof Blob) bmp.close?.();
  const { data } = ctx.getImageData(0, 0, w, h); // throws if the image is from a site that doesn't allow it
  return { sig: signatureFromRGBA(data, w, h), thumb: thumbFromRGBA(data, w, h), pixels: w0 * h0 };
}

/* ---------------------------------------------------------------- close comparison */

export const THUMB = 64;

/** A 64 x 64 colour thumbnail (always square: proportions are checked separately). 12,288 bytes before compression. */
export function thumbFromRGBA(data, width, height) {
  const t = boxResize(data, width, height, THUMB, THUMB);
  const out = new Uint8Array(THUMB * THUMB * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(t[i]);
  return out;
}

/**
 * Compare two thumbnails pixel by pixel: how many pixels differ clearly in colour or brightness.
 * A re-saved or resized copy only differs slightly along edges; "30th" vs "40th" or gold vs silver
 * differ clearly in a patch of pixels.
 */
export function compareThumbs(a, b) {
  if (!a || !b || a.length !== b.length) return { clear: 1, mean: 255 };
  let clear = 0;
  let sum = 0;
  const n = THUMB * THUMB;
  for (let p = 0; p < n; p++) {
    const d = Math.abs(a[p * 3] - b[p * 3]) + Math.abs(a[p * 3 + 1] - b[p * 3 + 1]) + Math.abs(a[p * 3 + 2] - b[p * 3 + 2]);
    sum += d;
    if (d > 90) clear++;
  }
  return { clear, mean: sum / n / 3 };
}

/**
 * The final say. Measured on test pairs: re-saved, resized, sharpened or brightened copies differ clearly in
 * 0 pixels; "Happy 30th" vs "40th", "Item 1" vs "Item 7" in small print, gold vs silver differ in 4 or more.
 */
export function sameByThumb(a, b) {
  const c = compareThumbs(a, b);
  return c.clear <= 1 && c.mean <= 6;
}

/**
 * Loose first pass, to pick the few stored photos worth a close look (the shape check alone isn't
 * reliable on flat graphics, so it's only used to rule photos out).
 */
export function maybeSame(a, b) {
  if (!a || !b) return false;
  const d = distance(a, b);
  return d.ratio <= LIMITS.ratio && d.colour <= 12 && d.bits <= 80;
}
