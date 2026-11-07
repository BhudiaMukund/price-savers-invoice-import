/** What a downloaded file really is, from its first bytes (the link's extension and Content-Type can both be wrong). */
export type Sniffed = { ok: true; mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; ext: "jpg" | "png" | "gif" | "webp" } | { ok: false; what: string };

export function sniffImage(b: Uint8Array): Sniffed {
  const tag = (i: number, s: string) => b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (!b.length) return { ok: false, what: "an empty file" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ok: true, mime: "image/jpeg", ext: "jpg" };
  if (b.length > 8 && b[0] === 0x89 && tag(1, "PNG")) return { ok: true, mime: "image/png", ext: "png" };
  if (tag(0, "GIF8")) return { ok: true, mime: "image/gif", ext: "gif" };
  if (tag(0, "RIFF") && tag(8, "WEBP")) return { ok: true, mime: "image/webp", ext: "webp" };
  if (tag(4, "ftyp")) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (/^(avif|avis)$/.test(brand)) return { ok: false, what: "an AVIF image" };
    if (/^(heic|heix|hevc|mif1|msf1)/.test(brand)) return { ok: false, what: "a HEIC image" };
    return { ok: false, what: `a video or other file (${brand.trim()})` };
  }
  if (tag(0, "BM")) return { ok: false, what: "a BMP image" };
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return { ok: false, what: "a TIFF image" };
  if (tag(0, "%PDF")) return { ok: false, what: "a PDF" };
  const head = new TextDecoder().decode(b.slice(0, 200)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { ok: false, what: "an SVG drawing" };
  if (head.startsWith("<?xml") && /error|blob|code/.test(head)) return { ok: false, what: "an error message from the server, not a picture" };
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return { ok: false, what: "a web page, not a picture" };
  return { ok: false, what: "a file that isn't a recognised picture" };
}
