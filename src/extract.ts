import type { Env, ExtractedItem, InvoiceDetails } from "./types";
import { streamedBody } from "./streams";

/**
 * Provider-agnostic extraction. Every supplier layout goes through the same prompt + schema,
 * so there is no per-supplier code. To switch model or provider, change AI_MODEL / AI_PROVIDER
 * (and add a provider to PROVIDERS below if needed).
 *
 * Cloudflare's free plan allows roughly 10 ms of CPU per request, so the Worker never decodes or
 * re-encodes file contents. The browser converts Excel to CSV text and encodes PDFs/photos as base64;
 * the Worker forwards that base64 to the AI as a stream, without parsing it.
 */

export type InvoicePayload =
  | { kind: "text"; filename: string; text: string }
  | {
      kind: "base64";
      filename: string;
      mimeType: string;
      /** Base64 characters (no data: prefix). */
      stream: ReadableStream<Uint8Array>;
      /** Byte length of the base64 stream, from Content-Length. */
      length: number;
    };

export class ExtractionError extends Error {
  /** True when trying again shortly (or with the fallback model) may work: busy, overloaded, rate-limited. */
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

/**
 * House style for product titles. Edit this block to change how cleaned titles read;
 * nothing else in the code needs to change.
 */
export const TITLE_STYLE = `House style for product titles (Price Savers, a party supply and souvenir shop in Adelaide):
- Title Case. Keep brand names and licensed names exactly as the brand writes them.
- Order: colour or theme, then what the product is, then size, then pack size.
  Examples: "Gold Happy Birthday Foil Banner 2.5m", "Assorted Latex Balloons 30cm (Pack of 25)",
  "Pastel Pink Paper Plates 23cm (Pack of 10)", "Kangaroo Souvenir Keyring".
- Write pack sizes as "(Pack of N)". Leave it out for single items.
- Units in lower case with no space: 30cm, 2.5m, 500ml.
- Spell out supplier abbreviations: BLN or BALL = Balloon, LTX = Latex, ASST = Assorted, PK or PCK = Pack,
  NAPK = Napkins, PLT = Plates, BNR = Banner, HB = Happy Birthday, MET = Metallic, HOLO = Holographic.
- Australian English: colour, centrepiece, serviettes are fine.
- Remove anything that isn't the product: supplier codes, barcodes, carton or inner quantities (CTN 12, 6/72),
  prices, stock notes (NEW, SALE, CLEARANCE, DISC, ***), and order notes.
- Fix obvious typos. Replace crude, offensive or inappropriate wording with a neutral description of the same product.
- Never add facts that aren't on the invoice line (no invented colours, sizes, materials or uses).
- At most 70 characters. If you can't tell what the product is, keep the original words, just in Title Case.`;

export const PROMPT = `You are reading a supplier invoice or price list for a retail shop. Extract every PRODUCT line item.

For the invoice as a whole return:
- supplierName: the business name of the supplier that issued the invoice (the seller, not the shop being billed), without "Pty Ltd" or similar. Null if you can't tell.
- invoiceNumber: the invoice or order number as printed. Null if there isn't one.

For each product return:
- invoiceTitle: the product description exactly as printed on the invoice.
- title: the same product rewritten as a clean shop title, following the house style below.
- supplierCode: the supplier's item/product/stock code if one is printed for the line, otherwise null.
- barcode: the barcode (EAN/UPC/GTIN) digits if printed for the line, otherwise null. Never guess or construct a barcode. Copy digits exactly, including leading zeros.

Rules:
- Do NOT include prices, costs, quantities, totals or tax. They are not wanted.
- Skip non-product lines: freight, delivery, GST, discounts, deposits, subtotals, notes, headers and footers.
- If the same product appears on several lines, return it once per line as printed.
- If the document has no product lines, return an empty list.

${TITLE_STYLE}`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    supplierName: { type: "STRING", nullable: true },
    invoiceNumber: { type: "STRING", nullable: true },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          invoiceTitle: { type: "STRING" },
          title: { type: "STRING" },
          supplierCode: { type: "STRING", nullable: true },
          barcode: { type: "STRING", nullable: true },
        },
        required: ["invoiceTitle", "title", "supplierCode", "barcode"],
        propertyOrdering: ["invoiceTitle", "title", "supplierCode", "barcode"],
      },
    },
  },
  required: ["supplierName", "invoiceNumber", "items"],
  propertyOrdering: ["supplierName", "invoiceNumber", "items"],
};

/** File types the AI reads directly (sent as base64). Text formats go through the text path. */
export const BINARY_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);

type Provider = (env: Env, payload: InvoicePayload, model: string) => Promise<unknown>;

const enc = new TextEncoder();

/**
 * Send one request to Gemini and return the parsed JSON answer. Shared by invoice reading and catalogue
 * column mapping, so both get the same error messages and retry hints.
 */
export async function geminiJson(env: Env, model: string, init: RequestInit & { duplex?: "half" }): Promise<unknown> {
  if (!env.GEMINI_API_KEY) throw new ExtractionError("The AI key is not set up.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
  });
  if (res.status === 429) {
    throw new ExtractionError("The free AI limit was reached (per minute or per day). Wait a minute and try again.", true);
  }
  if (res.status === 503 || res.status === 500 || res.status === 504) {
    throw new ExtractionError(`Google's AI is overloaded right now (${res.status}). This usually clears within minutes. Try again.`, true);
  }
  if (res.status === 404) throw new ExtractionError(`The AI model "${model}" is not available. Update AI_MODEL in wrangler.toml.`, true);
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new ExtractionError(`Google refused the request (${res.status}). Check GEMINI_API_KEY is set and the key is allowed to use "${model}".`);
  }
  if (!res.ok) throw new ExtractionError(`The AI service returned an error (${res.status}). Try again.`, true);

  const out = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (out.promptFeedback?.blockReason) throw new ExtractionError("The AI refused to read this file.");
  const cand = out.candidates?.[0];
  if (cand?.finishReason === "MAX_TOKENS") {
    throw new ExtractionError("This file is too long to read in one go. Split it into smaller files.");
  }
  const text = cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new ExtractionError("The AI returned nothing for this file. Check it and try again.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ExtractionError("The AI's answer could not be read. Try again.");
  }
}

const gemini: Provider = async (env, payload, model) => {
  if (!env.GEMINI_API_KEY) throw new ExtractionError("The AI key is not set up. Add rows by hand for now.");
  const generationConfig = { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA };

  if (payload.kind === "text") {
    return geminiJson(env, model, {
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: PROMPT }, { text: `Invoice file "${payload.filename}" contents:\n\n${payload.text}` }],
          },
        ],
        generationConfig,
      }),
    });
  }
  const MARK = "\u0000FILE_DATA\u0000";
  const template = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: PROMPT }, { inline_data: { mime_type: payload.mimeType, data: MARK } }] }],
    generationConfig,
  });
  const marker = JSON.stringify(MARK).slice(1, -1); // as it appears inside the JSON string
  const at = template.indexOf(marker);
  const { body, duplex } = streamedBody(enc.encode(template.slice(0, at)), payload.stream, payload.length, enc.encode(template.slice(at + marker.length)));
  return geminiJson(env, model, duplex ? { body, duplex } : { body });
};

const PROVIDERS: Record<string, Provider> = { gemini };

/**
 * Which model to use for this attempt. The page retries busy/overloaded failures itself (it still has the
 * file; the server streams it and can't replay it), and from the second attempt on we switch to
 * AI_FALLBACK_MODEL, which has its own capacity and free quota.
 */
export function modelFor(env: Env, attempt: number): string {
  return attempt >= 2 && env.AI_FALLBACK_MODEL ? env.AI_FALLBACK_MODEL : env.AI_MODEL;
}

export async function extractItems(
  env: Env,
  payload: InvoicePayload,
  attempt = 1,
): Promise<{ items: ExtractedItem[]; invoice: InvoiceDetails; model: string }> {
  const provider = PROVIDERS[env.AI_PROVIDER];
  if (!provider) throw new ExtractionError(`Unknown AI provider "${env.AI_PROVIDER}". Check AI_PROVIDER in the settings.`);
  const model = modelFor(env, attempt);
  const raw = (await provider(env, payload, model)) as Record<string, unknown> | null;
  const text = (v: unknown, n: number) => {
    if (typeof v !== "string" && typeof v !== "number") return null;
    const t = String(v).replace(/\s+/g, " ").trim();
    return t && !/^(null|n\/a|none|unknown|-)$/i.test(t) ? t.slice(0, n) : null;
  };
  return {
    items: sanitize(raw?.items),
    invoice: { supplierName: text(raw?.supplierName, 100), invoiceNumber: text(raw?.invoiceNumber, 40) },
    model,
  };
}

/** Never trust model output: coerce types, trim, drop empties. */
export function sanitize(items: unknown): ExtractedItem[] {
  if (!Array.isArray(items)) return [];
  const out: ExtractedItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 255) : "");
    const invoiceTitle = clean(r.invoiceTitle);
    const title = clean(r.title) || invoiceTitle; // fall back to the printed wording
    if (!title) continue;
    const str = (v: unknown) => {
      if (typeof v !== "string" && typeof v !== "number") return null;
      const s = String(v).trim();
      return s && !/^(null|n\/a|none|-)$/i.test(s) ? s.slice(0, 64) : null;
    };
    out.push({
      title,
      invoiceTitle: invoiceTitle && invoiceTitle !== title ? invoiceTitle : undefined,
      supplierCode: str(r.supplierCode),
      barcode: str(r.barcode),
    });
  }
  return out;
}
