/**
 * Tidy product titles in batches, for spreadsheets whose rows the page reads itself.
 *
 * Each title goes out with an id and must come back with the same id AND an exact copy of the text that
 * was sent ("original"). A title is only accepted when that copy matches, when it keeps no number that
 * wasn't in the text (so a size or pack count can't jump from a neighbouring line), and when it shares at
 * least one word with the text. Anything else is rejected and the page asks again, or keeps a tidy made by
 * simple rules and flags it for a look. A wrong title is never quietly put on the wrong product.
 */
import type { Env } from "./types";
import { ExtractionError, TITLE_STYLE, geminiJson, modelFor } from "./extract";

export const TITLE_BATCH = 100;
export const MAX_TITLE_TEXT = 400;
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

export const TITLES_PROMPT = `You rewrite supplier product descriptions as product titles for a shop.
Each input line is "id: description". Rewrite every line on its own, using only the words on that line.

Return one entry per input line, in the same order, with:
- id: the id exactly as given.
- original: the description exactly as given, character for character.
- title: the rewritten title.

Never merge, split, skip or reorder lines, and never move words or numbers from one line to another.
Keep every size, quantity and number as written on its line: don't convert units (inches stay inches) or work
out new numbers.

${TITLE_STYLE}`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, original: { type: "STRING" }, title: { type: "STRING" } },
        required: ["id", "original", "title"],
        propertyOrdering: ["id", "original", "title"],
      },
    },
  },
  required: ["items"],
};

export interface TitleRequest {
  id: string;
  text: string;
}

/** Check and clean what the page sent. Returns an error message, or the items. */
export function readTitleRequest(body: unknown): { error: string } | { items: TitleRequest[]; supplier: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.items) || !b.items.length) return { error: "Send at least one title." };
  if (b.items.length > TITLE_BATCH) return { error: `Send at most ${TITLE_BATCH} titles at a time.` };
  const seen = new Set<string>();
  const items: TitleRequest[] = [];
  for (const x of b.items) {
    const r = (x ?? {}) as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const text = typeof r.text === "string" ? r.text.replace(/\s+/g, " ").trim() : "";
    if (!ID_RE.test(id) || seen.has(id)) return { error: "Each title needs its own id." };
    if (!text || text.length > MAX_TITLE_TEXT) return { error: `Titles must be 1 to ${MAX_TITLE_TEXT} characters.` };
    seen.add(id);
    items.push({ id, text });
  }
  const supplier = typeof b.supplier === "string" && b.supplier.trim() ? b.supplier.replace(/\s+/g, " ").trim().slice(0, 100) : null;
  return { items, supplier };
}

/* ------------------------------------------------------------------ checks */

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Share of letter pairs two strings have in common (1 = same). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const pa = pairs(a);
  const pb = pairs(b);
  let both = 0;
  for (const [k, n] of pa) both += Math.min(n, pb.get(k) ?? 0);
  return (2 * both) / (a.length - 1 + (b.length - 1));
}

/** The copy that came back is the text that was sent (allowing tiny slips in spacing or punctuation). */
export function echoMatches(sent: string, original: string): boolean {
  const a = norm(sent);
  const b = norm(original);
  return a === b || similarity(a, b) >= 0.9;
}

// Numbers written as words, which a tidy title may write as digits ("PAIR" -> "(Pack of 2)").
const WORD_NUMBERS: [RegExp, number][] = [
  [/\b(one|single)\b/i, 1], [/\b(two|pair|twin|double|duo)\b/i, 2], [/\b(three|trio|triple)\b/i, 3], [/\bfour\b/i, 4],
  [/\bfive\b/i, 5], [/\b(six|half\s*doz(en)?)\b/i, 6], [/\bseven\b/i, 7], [/\beight\b/i, 8], [/\bnine\b/i, 9],
  [/\bten\b/i, 10], [/\b(twelve|doz|dozen)\b/i, 12], [/\b(twenty)\b/i, 20], [/\b(hundred)\b/i, 100],
];

/** Numbers in a text: "2.5m" -> 2.5, "137x274" -> 137, 274, "25PK" -> 25, "1,000" -> 1000, "PAIR" -> 2. */
function numbers(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.replace(/(\d),(\d{3})\b/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)) out.add(String(Number(m[0])));
  for (const [re, n] of WORD_NUMBERS) if (re.test(s)) out.add(String(n));
  return out;
}

/** "BLN" fits "balloon", "LTX" fits "latex": same first letter and its letters appear in order. */
function abbreviates(short: string, word: string): boolean {
  if (short.length < 2 || short[0] !== word[0] || short.length > word.length) return false;
  let i = 0;
  for (const ch of word) if (ch === short[i]) i++;
  return i === short.length;
}

/** Why a tidied title can't be trusted for this text, or null when it's fine. */
export function titleProblem(sent: string, title: string): string | null {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t || !/[A-Za-z]/.test(t)) return "empty";
  if (t.length > 150) return "too long";
  if (/\d{8,}/.test(t)) return "kept a barcode";
  const have = numbers(sent);
  for (const n of numbers(t)) if (!have.has(n)) return `the number ${n} isn't in the description`;
  const sentWords = norm(sent).split(" ").filter((w) => /[a-z]/.test(w) && w.replace(/\d/g, "").length >= 2).map((w) => w.replace(/\d/g, ""));
  if (!sentWords.length) return null; // nothing but codes and numbers to compare
  const titleWords = norm(t).split(" ").filter((w) => /[a-z]{2,}/.test(w)).map((w) => w.replace(/\d/g, ""));
  const fits = (s: string, w: string) => w === s || (s.length >= 3 && w.startsWith(s)) || (w.length >= 3 && s.startsWith(w)) || abbreviates(s, w);
  const shares = sentWords.some((s) => titleWords.some((w) => fits(s, w)));
  return shares ? null : "no words in common with the description";
}

const wordsOf = (t: string) => norm(t).split(" ").filter((w) => /[a-z]/.test(w)).map((w) => w.replace(/\d/g, "")).filter((w) => w.length >= 2);
const fits = (s: string, w: string) => w === s || (s.length >= 3 && w.startsWith(s)) || (w.length >= 3 && s.startsWith(w)) || abbreviates(s, w);

/**
 * Match the AI's answer to what was sent. Every id ends up either in titles or in rejected.
 * Besides the per-line checks, a title is turned down when its copy of the description is closer to another
 * line in the batch than to its own, or when it uses a word that only another line has ("Blue" on the red one).
 */
export function checkTitles(sent: TitleRequest[], raw: unknown): { titles: { id: string; title: string }[]; rejected: { id: string; reason: string }[] } {
  const list = Array.isArray((raw as { items?: unknown })?.items) ? ((raw as { items: unknown[] }).items) : [];
  const byId = new Map<string, { original: string; title: string }[]>();
  for (const x of list) {
    const r = (x ?? {}) as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) continue;
    const entry = { original: typeof r.original === "string" ? r.original : "", title: typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim() : "" };
    byId.set(id, [...(byId.get(id) ?? []), entry]);
  }
  const normed = sent.map((s) => norm(s.text));
  const words = sent.map((s) => wordsOf(s.text));
  const titles: { id: string; title: string }[] = [];
  const rejected: { id: string; reason: string }[] = [];
  sent.forEach((s, k) => {
    const got = byId.get(s.id) ?? [];
    if (!got.length) return rejected.push({ id: s.id, reason: "missing" });
    if (new Set(got.map((g) => g.title)).size > 1) return rejected.push({ id: s.id, reason: "answered twice" });
    const g = got[0]!;
    const copy = norm(g.original);
    if (copy !== normed[k]) {
      // Not an exact copy: it must be close to this line, and closer to it than to any other line.
      const own = similarity(normed[k]!, copy);
      const other = Math.max(0, ...normed.map((t, j) => (j === k || t === normed[k] ? 0 : similarity(t, copy))));
      if (own < 0.9 || other >= own) return rejected.push({ id: s.id, reason: "mixed up with another line" });
    }
    const problem = titleProblem(s.text, g.title);
    if (problem) return rejected.push({ id: s.id, reason: problem });
    // The title must describe this line at least as well as any other line in the batch. A title written for
    // the neighbouring line ("Monster Truck" on the dinosaur balloon, "Blue" on the red one) covers more of
    // that line's words than of its own.
    const tw = wordsOf(g.title);
    const cover = (ws: string[]) => (ws.length ? ws.filter((t) => tw.some((w) => fits(t, w))).length / ws.length : 0);
    const own = cover(words[k]!);
    const better = words.findIndex((ws, j) => j !== k && normed[j] !== normed[k] && cover(ws) > own + 1e-9);
    if (better >= 0) return rejected.push({ id: s.id, reason: "fits another line better" });
    titles.push({ id: s.id, title: g.title.slice(0, 255) });
  });
  return { titles, rejected };
}

export async function tidyTitles(env: Env, items: TitleRequest[], supplier: string | null, attempt = 1) {
  if (env.AI_PROVIDER !== "gemini") throw new ExtractionError(`Unknown AI provider "${env.AI_PROVIDER}".`);
  const model = modelFor(env, attempt);
  const lines = items.map((i) => `${i.id}: ${i.text}`).join("\n");
  const raw = await geminiJson(env, model, {
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: TITLES_PROMPT }, { text: `${supplier ? `Supplier: ${supplier}\n\n` : ""}Descriptions:\n${lines}` }],
        },
      ],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
    }),
  });
  return { ...checkTitles(items, raw), model };
}
