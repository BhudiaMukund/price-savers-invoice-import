/**
 * File names and alt text for the photo copies on products.
 * Keep slug() and imageExt() in step with public/js/photo-names.js (test/photo-names.test.ts checks they agree).
 */

const EXT_RE = /\.(jpe?g|png|gif|webp)$/i;

/** Lower-case words joined by dashes, accents dropped, cut at a word boundary. */
export function slug(text: string | null | undefined, max = 60): string {
  const s = String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf("-");
  return (at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).replace(/-+$/, "");
}

/** The image extension of a file name or link, or "" when it has none. */
export function imageExt(nameOrUrl: string | null | undefined): string {
  let path = String(nameOrUrl ?? "");
  try {
    if (/^https?:/i.test(path)) path = decodeURIComponent(new URL(path).pathname);
  } catch {
    /* not a link */
  }
  const m = EXT_RE.exec(path);
  if (!m) return "";
  const ext = m[1]!.toLowerCase();
  return `.${ext === "jpeg" ? "jpg" : ext}`;
}

/**
 * Name for photo `index` (0 = main) of a product, from its title: "black-skull-candle-holder-12cm.jpg",
 * then "-2", "-3". Undefined when there's nothing to name it from (Shopify then keeps the source's name).
 */
export function productPhotoFileName(title: string, index: number, sourceUrl: string): string | undefined {
  const ext = imageExt(sourceUrl);
  const base = slug(title, 70);
  if (!ext || !base) return undefined;
  return `${base}${index > 0 ? `-${index + 1}` : ""}${ext}`;
}

/**
 * Alt text for photo `index` of `count`: the product title on the main photo, and the title with
 * "photo 2 of 3" on the others, so a screen reader (and Google) can tell them apart.
 */
export function productPhotoAlt(title: string, index: number, count: number): string {
  const t = title.trim().replace(/\s+/g, " ");
  return (count > 1 && index > 0 ? `${t}, photo ${index + 1} of ${count}` : t).slice(0, 500);
}

/** The photos for a product, each with its alt text and file name. */
export function namedPhotos(title: string, urls: string[]): { url: string; alt: string; filename?: string }[] {
  return urls.map((url, i) => {
    const filename = productPhotoFileName(title, i, url);
    return { url, alt: productPhotoAlt(title, i, urls.length), ...(filename ? { filename } : {}) };
  });
}
