/**
 * Work out a catalogue spreadsheet's layout with AI: which sheet, which row has the headings, and which
 * columns hold the barcode, supplier code, title, description and photo links. Only the first rows are
 * sent (not the whole file), so a big catalogue costs one small AI request. The page then reads every row
 * itself, and staff can correct the columns before anything is saved.
 */
import type { Env } from "./types";
import { ExtractionError, geminiJson, modelFor } from "./extract";

export interface ColumnMap {
  sheet: string | null;
  headerRow: number | null;
  columns: {
    barcode: string | null;
    supplierCode: string | null;
    title: string | null;
    description: string | null;
    photoLinks: string[];
  };
}

export const MAP_PROMPT = `You are looking at the first rows of a supplier's product catalogue or price list, exported from a
spreadsheet. Each row is shown as "Row N: A=value | B=value ...", using the spreadsheet's own column letters.

Work out the layout so a program can read every product row:
- sheet: the name of the sheet that lists the products.
- headerRow: the row number holding the column headings, or null if there are none.
- columns: the column LETTER for each of these, or null if the catalogue doesn't have it:
  - barcode: the EAN/UPC/APN/GTIN barcode of the single retail unit (not an inner or carton barcode if both exist).
  - supplierCode: the supplier's own item/product/stock code.
  - title: the product name or short description.
  - description: a longer description, if there is a separate column for one.
  - photoLinks: every column holding web links (http...) to product photos, in order. Empty list if none.
Never guess a column that isn't there.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    sheet: { type: "STRING", nullable: true },
    headerRow: { type: "INTEGER", nullable: true },
    columns: {
      type: "OBJECT",
      properties: {
        barcode: { type: "STRING", nullable: true },
        supplierCode: { type: "STRING", nullable: true },
        title: { type: "STRING", nullable: true },
        description: { type: "STRING", nullable: true },
        photoLinks: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["barcode", "supplierCode", "title", "description", "photoLinks"],
      propertyOrdering: ["barcode", "supplierCode", "title", "description", "photoLinks"],
    },
  },
  required: ["sheet", "headerRow", "columns"],
  propertyOrdering: ["sheet", "headerRow", "columns"],
};

const COL_RE = /^[A-Z]{1,3}$/;

/** Never trust model output. */
export function cleanMap(raw: unknown): ColumnMap {
  const r = (raw ?? {}) as Record<string, unknown>;
  const c = (r.columns ?? {}) as Record<string, unknown>;
  const col = (v: unknown) => {
    const s = typeof v === "string" ? v.trim().toUpperCase() : "";
    return COL_RE.test(s) ? s : null;
  };
  const row = Number(r.headerRow);
  return {
    sheet: typeof r.sheet === "string" && r.sheet.trim() ? r.sheet.trim().slice(0, 100) : null,
    headerRow: Number.isInteger(row) && row > 0 && row < 100_000 ? row : null,
    columns: {
      barcode: col(c.barcode),
      supplierCode: col(c.supplierCode),
      title: col(c.title),
      description: col(c.description),
      photoLinks: Array.isArray(c.photoLinks) ? [...new Set(c.photoLinks.map(col).filter((x): x is string => !!x))].slice(0, 10) : [],
    },
  };
}

export async function mapColumns(env: Env, sample: string, attempt = 1): Promise<{ map: ColumnMap; model: string }> {
  if (env.AI_PROVIDER !== "gemini") throw new ExtractionError(`Unknown AI provider "${env.AI_PROVIDER}".`);
  const model = modelFor(env, attempt);
  const raw = await geminiJson(env, model, {
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: MAP_PROMPT }, { text: sample }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
    }),
  });
  return { map: cleanMap(raw), model };
}
