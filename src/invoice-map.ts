/**
 * Spreadsheet invoices (Excel, CSV): the AI only looks at the first rows and says which column holds what.
 * The page then reads every row itself, so a long file costs one small AI request, barcodes and codes are
 * copied exactly, and there's no limit on the number of lines. Titles are tidied afterwards in batches.
 */
import type { Env } from "./types";
import { ExtractionError, geminiJson, modelFor } from "./extract";

export interface InvoiceMap {
  supplierName: string | null;
  invoiceNumber: string | null;
  layout: "table" | "other";
  sheet: string | null;
  headerRow: number | null;
  columns: {
    barcode: string | null;
    supplierCode: string | null;
    title: string | null;
    titleExtras: string[];
    /** The quantity supplied on the line. */
    quantity: string | null;
    /** What the quantity counts (EA, CTN...). */
    unit: string | null;
    /** How many single retail units one invoiced unit holds (carton quantity, inner quantity, pack size). */
    unitsPer: string | null;
  };
}

export const INVOICE_MAP_PROMPT = `You are looking at the first rows of a supplier invoice, order or price list exported to a spreadsheet.
Each row is shown as "Row N: A=value | B=value ...", using the spreadsheet's own column letters. Each sheet's
heading says how many rows it has in total; only the first rows are shown.

Return:
- supplierName: the business that issued the document (the seller, not the shop being billed), without "Pty Ltd"
  or similar. Null if you can't tell.
- invoiceNumber: the invoice or order number. Null if there isn't one.
- layout: "table" when the products are listed one per row, in the same columns on every row (with or without a
  row of headings). "other" when they aren't (a letter-style layout, each product spread over several rows, or no
  products at all).
- sheet: the name of the sheet that lists the products.
- headerRow: the row number holding the column headings of the product list, or null if there are none.
- columns: the column LETTER for each of these, or null if the document doesn't have it:
  - barcode: the EAN/UPC/APN/GTIN barcode of the single retail unit (not an inner or carton barcode if both exist).
  - supplierCode: the supplier's own item/product/stock code.
  - title: the product description or name.
  - titleExtras: other columns that are part of the product's name and belong after it, such as a separate colour,
    size, flavour or design column, in reading order. Empty list if none. Never include quantity, unit, price,
    inner or carton quantity, discount, tax or total columns.
  - quantity: the quantity actually supplied or invoiced (headings like Qty, Quantity, Qty Shipped, Supplied, Inv Qty).
    If there is both an ordered and a supplied/shipped quantity, choose the supplied one. Never the back-order,
    price, total or carton-count-per-pack columns. Null if there isn't one.
  - unit: a column saying what the quantity counts (UOM, Unit, EA, CTN). Null if there isn't one.
  - unitsPer: a column saying how many single retail units are in one invoiced unit (Carton Qty, Qty per Ctn, Inner Qty,
    Pack Size, Units per Case). Null if there isn't one.
Never guess a column that isn't there.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    supplierName: { type: "STRING", nullable: true },
    invoiceNumber: { type: "STRING", nullable: true },
    layout: { type: "STRING", enum: ["table", "other"] },
    sheet: { type: "STRING", nullable: true },
    headerRow: { type: "INTEGER", nullable: true },
    columns: {
      type: "OBJECT",
      properties: {
        barcode: { type: "STRING", nullable: true },
        supplierCode: { type: "STRING", nullable: true },
        title: { type: "STRING", nullable: true },
        titleExtras: { type: "ARRAY", items: { type: "STRING" } },
        quantity: { type: "STRING", nullable: true },
        unit: { type: "STRING", nullable: true },
        unitsPer: { type: "STRING", nullable: true },
      },
      required: ["barcode", "supplierCode", "title", "titleExtras", "quantity", "unit", "unitsPer"],
      propertyOrdering: ["barcode", "supplierCode", "title", "titleExtras", "quantity", "unit", "unitsPer"],
    },
  },
  required: ["supplierName", "invoiceNumber", "layout", "sheet", "headerRow", "columns"],
  propertyOrdering: ["supplierName", "invoiceNumber", "layout", "sheet", "headerRow", "columns"],
};

const COL_RE = /^[A-Z]{1,3}$/;
const NOTHING = /^(null|n\/a|none|unknown|-)$/i;

/** Never trust model output: letters only, no column used twice, sensible numbers. */
export function cleanInvoiceMap(raw: unknown): InvoiceMap {
  const r = (raw ?? {}) as Record<string, unknown>;
  const c = (r.columns ?? {}) as Record<string, unknown>;
  const used = new Set<string>();
  const col = (v: unknown) => {
    const s = typeof v === "string" ? v.trim().toUpperCase() : "";
    if (!COL_RE.test(s) || used.has(s)) return null;
    used.add(s);
    return s;
  };
  // Title first: if the AI gave one column two jobs, the title keeps it.
  const title = col(c.title);
  const barcode = col(c.barcode);
  const supplierCode = col(c.supplierCode);
  const titleExtras = Array.isArray(c.titleExtras) ? c.titleExtras.map(col).filter((x): x is string => !!x).slice(0, 3) : [];
  const quantity = col(c.quantity);
  const unit = col(c.unit);
  const unitsPer = col(c.unitsPer);
  const text = (v: unknown, n: number) => {
    const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
    return t && !NOTHING.test(t) ? t.slice(0, n) : null;
  };
  const row = Number(r.headerRow);
  return {
    supplierName: text(r.supplierName, 100),
    invoiceNumber: text(r.invoiceNumber, 40),
    layout: r.layout === "other" ? "other" : "table",
    sheet: text(r.sheet, 100),
    headerRow: Number.isInteger(row) && row > 0 && row < 1_000_000 ? row : null,
    columns: { barcode, supplierCode, title, titleExtras, quantity, unit, unitsPer },
  };
}

export async function mapInvoiceColumns(env: Env, sample: string, attempt = 1): Promise<{ map: InvoiceMap; model: string }> {
  if (env.AI_PROVIDER !== "gemini") throw new ExtractionError(`Unknown AI provider "${env.AI_PROVIDER}".`);
  const model = modelFor(env, attempt);
  const raw = await geminiJson(env, model, {
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: INVOICE_MAP_PROMPT }, { text: sample }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
    }),
  });
  return { map: cleanInvoiceMap(raw), model };
}
