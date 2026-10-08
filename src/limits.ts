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

/**
 * Supplier catalogues. Photos go one per request (each is streamed through to Shopify Files);
 * everything else is batched by the page in these sizes.
 */
export const CATALOGUE_LIMITS = {
  knownBatch: 200,
  /** One fileCreate call for the whole batch. */
  linkBatch: 25,
  itemBatch: 100,
  matchBatch: 300,
  /** Two Shopify calls per product at most. */
  attachBatch: 10,
  undoBatch: 50,
  /** Look-alike photos: fingerprints saved, thumbnails fetched, pairs merged per request. */
  signatureBatch: 50,
  thumbBatch: 200,
  mergeBatch: 25,
} as const;
