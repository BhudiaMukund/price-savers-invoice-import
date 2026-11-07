/**
 * Sized for the Workers Paid plan (1,000 outbound requests per call; the free plan allows 50). A create batch costs
 * 1 lookup + 1 context + about 2 per product (+3 for a helium bundle). The page sends larger selections in batches.
 * On the free plan, set these back to 15 (create), 20 (undo) and 10 (attach).
 */
export const MAX_CREATE_BATCH = 30;
/** A line that also makes a helium bundle counts as this many lines in a batch (the bundle takes three more
 *  Shopify requests: make it, link its parts, publish it). */
export const BUNDLE_WEIGHT = 2.5;

/** Undo: 1 check + 1 delete per product (+1 token). */
export const MAX_UNDO_BATCH = 50;

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
  attachBatch: 25,
  undoBatch: 50,
  /** Look-alike photos: fingerprints saved, thumbnails fetched, pairs merged per request. */
  signatureBatch: 50,
  /** Fingerprints sent per page when the page loads the stored ones. */
  signaturePage: 500,
  thumbBatch: 200,
  mergeBatch: 25,
} as const;
