/**
 * Workers' free plan allows 50 outbound requests per invocation. A create batch costs
 * 1 lookup + 1 context + 2 per product (+1 for a fresh Shopify token), so 15 stays well inside it.
 * The page sends larger selections in batches.
 */
export const MAX_CREATE_BATCH = 15;

/** Undo: 1 check + 1 delete per product (+1 token). */
export const MAX_UNDO_BATCH = 20;

/** Import IDs look like 20261007-ALPEN-K3F9: letters, digits and hyphens only. */
export const IMPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{3,60}$/;
