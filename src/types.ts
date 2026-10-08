export interface Env {
  ASSETS: Fetcher;
  /** Cloudflare D1 database for runs and the import ledger (see README). */
  DB?: import("./store").Db;
  SHOPIFY_STORE_DOMAIN: string;
  SHOPIFY_API_VERSION: string;
  /** Legacy custom apps only (permanent shpat_ token). */
  SHOPIFY_ADMIN_TOKEN?: string;
  /** Dev Dashboard apps: client credentials, exchanged for a 24-hour token. */
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  AI_PROVIDER: string;
  AI_MODEL: string;
  /** Used from the second attempt when the main model is busy or overloaded. Optional. */
  AI_FALLBACK_MODEL?: string;
  GEMINI_API_KEY: string;
  /** e.g. yourteam.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag from the Access application */
  ACCESS_AUD?: string;
  /** "true" only in local .dev.vars */
  DEV_AUTH_BYPASS?: string;
  /** Product metafield that records which import a product came from. Default "custom.import_source". */
  IMPORT_SOURCE_METAFIELD?: string;
  /** "false" to stop adding an import-<ID> tag to products (the starting value of the setting). */
  IMPORT_TAGS?: string;
  /** Comma-separated emails of the people allowed to change settings and delete suppliers. Empty: everyone. */
  ADMIN_EMAILS?: string;
}

/** One line item as read from an invoice. Cost and quantity are deliberately not captured. */
export interface ExtractedItem {
  /** Client-side row id, echoed back so results can be matched to rows. */
  id?: string;
  /** Cleaned title, in the shop's house style. */
  title: string;
  /** The wording printed on the invoice, when it differs from the cleaned title. */
  invoiceTitle?: string;
  supplierCode: string | null;
  barcode: string | null;
}

/** What the AI reads from the invoice as a whole. */
export interface InvoiceDetails {
  /** Supplier's business name as printed (the company that sent the invoice). */
  supplierName: string | null;
  invoiceNumber: string | null;
}

/** An extracted item after matching against the store. */
export interface ReviewItem extends ExtractedItem {
  id: string;
  /** Normalised barcode (digits only, GTIN-14 padded) or null when absent/invalid. */
  normalizedBarcode: string | null;
  barcodeStatus: "valid" | "missing" | "invalid_check_digit" | "invalid_format";
  /** Leading zeros were restored (spreadsheets often drop them). */
  barcodeRepaired: boolean;
  match: "new" | "exists" | "duplicate_in_invoice";
  existing?: { productId: string; title: string; handle: string };
}

export interface StoreProduct {
  productId: string;
  title: string;
  handle: string;
  /** Raw barcode as stored in Shopify. */
  barcode: string;
  sku: string;
}
