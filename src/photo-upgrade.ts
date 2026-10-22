/**
 * Bigger copies of catalogue photos. Suppliers' exports often link to a thumbnail
 * (".../74422371_1_200x200.jpg?ft=1") when the same picture exists in a larger size at a nearby address.
 * For each link this works out likely addresses for a bigger version (the same link without its size, then
 * larger sizes), asks the server for the start of each one, and only uses it when it really is a bigger
 * picture. Anything else keeps the link exactly as the supplier gave it, so no photo is ever lost.
 *
 * Costs one outbound request per link per attempt, so a budget keeps a batch inside the Workers free-plan
 * limit of 50 outbound requests per invocation (see CATALOGUE_LIMITS.linkBatch).
 */
import { MAX_IMAGE_BYTES } from "./files";

export interface Candidate {
  url: string;
  /** Which rule made it, for remembering what works on a host. */
  rule: string;
  /** The picture must be at least this many pixels on its longest side to count as an upgrade. */
  minSide: number;
}

const TOKEN_IN_PATH = /([-_.])(\d{2,4})x(\d{0,4})(?=\.[A-Za-z0-9]{2,5}$)/;
const WORD_IN_PATH = /[-_.](thumb|thumbnail|small|icon|pico|compact|medium)(?=\.[A-Za-z0-9]{2,5}$)/i;
const SIZE_PARAM = /^(w|width|maxwidth|max_width|h|height|maxheight|max_height|size)$/i;
const FACTORS = [5, 3] as const;
const TOP_SIDE = 2400;
/** A thumbnail is only "upgraded" when the new picture is clearly bigger. */
const GAIN = 1.4;
const MAX_CANDIDATES = 3;

/** Links worth probing: plain web addresses on a public host name. */
function publicHttp(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false; // IP addresses
  return true;
}

/** Likely addresses of bigger versions of this photo, best first. Empty when the link doesn't look like a thumbnail. */
export function candidatesFor(link: string): Candidate[] {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return [];
  }
  if (!publicHttp(u)) return [];
  const out: Candidate[] = [];
  const add = (next: URL, rule: string, minSide: number) => {
    const url = next.toString();
    if (url !== link && !out.some((c) => c.url === url)) out.push({ url, rule, minSide });
  };
  const withPath = (path: string) => {
    const n = new URL(u);
    n.pathname = path;
    return n;
  };

  // 1. A size in the file name: name_200x200.jpg, name-150x150.png, name_200x.jpg
  const path = decodeURIComponent(u.pathname);
  const tok = TOKEN_IN_PATH.exec(path);
  if (tok) {
    const [whole, sep, w, h] = tok as unknown as [string, string, string, string];
    const side = Math.max(Number(w), Number(h || 0));
    const minSide = Math.round(side * GAIN);
    add(withPath(path.replace(whole, "")), "strip-size", minSide);
    for (const f of FACTORS) {
      const big = side * f;
      if (big > TOP_SIDE) continue;
      add(withPath(path.replace(whole, `${sep}${Number(w) * f}x${h ? Number(h) * f : ""}`)), `size-x${f}`, minSide);
    }
  } else if (WORD_IN_PATH.test(path)) {
    // 2. A size word: name_thumb.jpg, name_small.jpg. No size to compare with, so it must be a decent picture.
    add(withPath(path.replace(WORD_IN_PATH, "")), "strip-word", 400);
  }

  // 3. A size in the query: ?width=200, ?w=150&h=150
  const sized = [...u.searchParams.entries()].filter(([k, v]) => SIZE_PARAM.test(k) && /^\d{2,4}$/.test(v) && Number(v) < 700);
  if (sized.length && !tok) {
    const side = Math.max(...sized.map(([, v]) => Number(v)));
    const minSide = Math.round(side * GAIN);
    const stripped = new URL(u);
    for (const [k] of sized) stripped.searchParams.delete(k);
    add(stripped, "strip-query", minSide);
    for (const f of FACTORS) {
      if (side * f > TOP_SIDE) continue;
      const bigger = new URL(u);
      for (const [k, v] of sized) bigger.searchParams.set(k, String(Number(v) * f));
      add(bigger, `query-x${f}`, minSide);
    }
  }
  return out.slice(0, MAX_CANDIDATES);
}

/** Width and height from the first bytes of a JPEG, PNG, GIF or WebP, or null when they can't be read. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const be32 = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  const tag = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 24 && b[0] === 0x89 && tag(1, "PNG")) return { width: be32(16), height: be32(20) };
  if (b.length >= 10 && tag(0, "GIF")) return { width: le16(6), height: le16(8) };
  if (b.length >= 30 && tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8 ")) return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (tag(12, "VP8L")) return { width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
    if (tag(12, "VP8X")) return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: be16(i + 5), width: be16(i + 7) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

const HEAD_BYTES = 65536;

export type Probe = (url: string) => Promise<{ width: number; height: number } | null>;

/** Fetch the start of a link and read how big the picture is. Null unless it's a real, reasonably sized image. */
export const probeImage: Probe = async (url) => {
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}`, Accept: "image/*" }, redirect: "follow", signal: AbortSignal.timeout(4000) });
    try {
      if (res.status !== 200 && res.status !== 206) return null;
      if (!/^image\/(jpeg|png|gif|webp)\b/i.test(res.headers.get("content-type") ?? "")) return null;
      const range = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
      const total = range ? Number(range[1]) : Number(res.headers.get("content-length") ?? NaN);
      if (Number.isFinite(total) && total > MAX_IMAGE_BYTES) return null;
      const reader = res.body?.getReader();
      if (!reader) return null;
      const buf = new Uint8Array(HEAD_BYTES);
      let n = 0;
      while (n < HEAD_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        const take = Math.min(value.length, HEAD_BYTES - n);
        buf.set(value.subarray(0, take), n);
        n += take;
      }
      await reader.cancel().catch(() => {});
      return imageSize(buf.subarray(0, n));
    } finally {
      res.body?.cancel().catch(() => {});
    }
  } catch {
    return null;
  }
};

/** What has worked on a host in this worker instance, so a rule that never works stops costing requests. */
const memory = new Map<string, { ok: number; fail: number }>();
export function forgetRules() {
  memory.clear();
}
const GIVE_UP_AFTER = 8;
const ruleKey = (url: string, rule: string) => `${new URL(url).hostname}|${rule}`;

/**
 * The bigger address to use for each link, or null to keep the link as it is. `budget` caps the outbound
 * requests spent on checking, across the whole list.
 */
export async function upgradePhotoLinks(links: string[], opts: { budget?: number; probe?: Probe } = {}): Promise<(string | null)[]> {
  const probe = opts.probe ?? probeImage;
  let budget = opts.budget ?? 25;
  const cands = links.map(candidatesFor);
  const out: (string | null)[] = links.map(() => null);

  const check = async (indices: number[], round: number) => {
    const batch = indices.slice(0, Math.max(0, budget));
    budget -= batch.length;
    const sizes = await Promise.all(batch.map((i) => probe(cands[i]![round]!.url)));
    batch.forEach((i, k) => {
      const c = cands[i]![round]!;
      const got = sizes[k];
      const good = !!got && Math.max(got.width, got.height) >= c.minSide;
      const key = ruleKey(c.url, c.rule);
      const m = memory.get(key) ?? { ok: 0, fail: 0 };
      if (good) (m.ok++, (out[i] = c.url));
      else m.fail++;
      memory.set(key, m);
    });
    return batch;
  };

  for (let round = 0; round < MAX_CANDIDATES && budget > 0; round++) {
    const groups = new Map<string, number[]>();
    for (let i = 0; i < links.length; i++) {
      const c = cands[i]![round];
      if (out[i] !== null || !c) continue;
      const key = ruleKey(c.url, c.rule);
      const m = memory.get(key);
      if (m && m.fail >= GIVE_UP_AFTER && m.ok === 0) continue;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    // A rule nobody has seen working is tried on a few links first: if none of them has a bigger picture the
    // rest aren't checked at all (a supplier whose server only has thumbnails would otherwise cost one request
    // per link). Once it has worked, every link is checked on its own, since pictures differ.
    const rest: number[] = [];
    const samples: number[] = [];
    for (const [key, idx] of groups) {
      if ((memory.get(key)?.ok ?? 0) > 0) rest.push(...idx);
      else (samples.push(...idx.slice(0, 3)), rest.push(...idx.slice(3)));
    }
    await check(samples, round);
    const later = rest.filter((i) => out[i] === null && (memory.get(ruleKey(cands[i]![round]!.url, cands[i]![round]!.rule))?.ok ?? 0) > 0);
    await check(later, round);
  }
  return out;
}
