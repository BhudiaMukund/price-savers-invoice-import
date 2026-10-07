import { analyzeBarcode, storeMatchKeys } from "./barcode";
import type { ExtractedItem, ReviewItem, StoreProduct } from "./types";

export type StoreIndex = Map<string, StoreProduct>;

export function buildStoreIndex(products: StoreProduct[]): StoreIndex {
  const index: StoreIndex = new Map();
  for (const p of products) {
    for (const key of storeMatchKeys(p.barcode)) {
      if (!index.has(key)) index.set(key, p);
    }
  }
  return index;
}

/**
 * Classify each extracted line:
 *  - exists: its barcode is already on a store variant (skipped by default)
 *  - duplicate_in_invoice: same barcode appears earlier in this invoice (skipped by default)
 *  - new: safe to create
 * Items with no usable barcode are always "new" but flagged by barcodeStatus so staff can review.
 */
export function classifyItems(items: ExtractedItem[], index: StoreIndex): ReviewItem[] {
  const seen = new Set<string>();
  return items.map((item, i) => {
    const bc = analyzeBarcode(item.barcode);
    const base: ReviewItem = {
      ...item,
      id: typeof item.id === "string" && item.id ? item.id.slice(0, 64) : `row-${i}`,
      normalizedBarcode: bc.key,
      barcodeStatus: bc.status,
      barcodeRepaired: bc.repaired,
      match: "new",
    };
    if (bc.key) {
      const hit = index.get(bc.key) ?? (bc.digits ? index.get(bc.digits) : undefined);
      if (hit) {
        return {
          ...base,
          match: "exists",
          existing: { productId: hit.productId, title: hit.title, handle: hit.handle },
        };
      }
      if (seen.has(bc.key)) return { ...base, match: "duplicate_in_invoice" };
      seen.add(bc.key);
    }
    return base;
  });
}
