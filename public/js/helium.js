/**
 * Helium bundles for foil balloons. Used by the review screen (to suggest a bundle) and by the server (to
 * check and name it), so both read a title the same way.
 *
 * A bundle is a separate product, "Helium INFLATED <name> Foil Balloon", made of the flat balloon plus the
 * Helium Inflation size that fits it. Its stock comes from the balloon; its price is balloon + inflation.
 */

/** Smallest balloon that gets a helium bundle. Smaller foil balloons are air-filled. */
export const MIN_HELIUM_CM = 40;

const INCH = 2.54;

/** Balloon size in cm from a title: "45cm", "86 cm", "18in", "18\"", "34-inch", "34 Inch". Null when none. */
export function balloonSize(title) {
  const t = String(title ?? "");
  const cm = /(\d{2,3}(?:\.\d)?)\s*cm\b/i.exec(t);
  if (cm) return Math.round(Number(cm[1]));
  const inch = /(\d{2,3}(?:\.\d)?)\s*(?:"|''|”|-?\s*in(?:ch(?:es)?)?\b)/i.exec(t);
  if (inch) return Math.round(Number(inch[1]) * INCH);
  return null;
}

const NOT_FOIL = /\blatex\b|air[\s-]*fill|air[\s-]*only|\bon (?:a )?sticks?\b|\bstick balloons?\b|\bwalking\b|\bpunch\s?balls?\b|\bwater balloons?\b|\bmodell?ing\b/i;
const FOIL_WORD = /\bfoil\b|\bmylar\b|super\s?shape|\borbz\b|\bfb(?:al)?(?=\d|\b)/i;

/**
 * A foil balloon (not latex, not an air-fill or stick balloon; foil banners and curtains are not balloons).
 * Tidied titles often drop the word "foil" ("Happy New Year Bottle Balloon 98cm"), so this also looks at the
 * invoice's own wording ("FBAL.18\" BON VOYAGE"), the catalogue's title, and supplier codes starting FB. A balloon
 * of 40cm or more that says nothing about latex counts too: staff untick the odd one.
 * `more`: { code, invoiceTitle, catalogueTitle }.
 */
export function isFoilBalloon(title, more = {}) {
  const texts = [title, more.invoiceTitle, more.catalogueTitle].map((t) => String(t ?? ""));
  const all = texts.join(" | ");
  if (!/\bballoons?\b|\bbln\b/i.test(all) && !FOIL_WORD.test(all) && !/^FB/i.test(more.code ?? "")) return false;
  if (NOT_FOIL.test(all)) return false;
  if (!/\bballoons?\b|\bbln\b/i.test(all) && !/^FB/i.test(more.code ?? "") && !/\bfb(?:al)?(?=\d|\b)/i.test(all)) return false; // foil banners, curtains
  if (FOIL_WORD.test(all) || /^FB/i.test(more.code ?? "")) return true;
  const size = sizeOf(texts);
  return !!size && size >= MIN_HELIUM_CM;
}

const sizeOf = (texts) => texts.map(balloonSize).find((n) => n != null) ?? null;

/**
 * The size range an inflation variant covers, from its title: "40-50cm", "40 – 50 cm", "80 to 100cm", "Up to 50cm",
 * "115cm+", or a single size "45cm / 18in" (which covers that size only). Null when the title has no size.
 */
export function tierRange(variantTitle) {
  const t = String(variantTitle ?? "");
  const both = /(\d{2,3})\s*(?:cm)?\s*(?:-|–|—|to)\s*(\d{2,3})\s*cm/i.exec(t);
  if (both) return [Number(both[1]), Number(both[2])].sort((a, b) => a - b);
  const inches = /(\d{1,3})\s*(?:"|”|in(?:ch(?:es)?)?)?\s*(?:-|–|—|to)\s*(\d{1,3})\s*(?:"|”|in(?:ch(?:es)?)?\b)/i.exec(t);
  if (inches) return [Number(inches[1]), Number(inches[2])].map((n) => Math.round(n * INCH)).sort((a, b) => a - b);
  const upTo = /(?:up to|under|max(?:imum)?)\s*(\d{2,3})\s*cm/i.exec(t);
  if (upTo) return [MIN_HELIUM_CM, Number(upTo[1])];
  const over = /(\d{2,3})\s*cm\s*(?:\+|and (?:over|up|above)|or (?:more|bigger|larger))/i.exec(t);
  if (over) return [Number(over[1]), 999];
  const one = balloonSize(t);
  return one ? [one, one] : null;
}

/**
 * The inflation variant for a balloon size. `tiers`: [{ variantId, title, price, min, max }]. A size on a boundary
 * (50cm in "40-50cm" and "50-80cm") takes the smaller one. A tier for a single size also takes balloons within
 * 10% of it. Null when nothing fits.
 */
export function pickTier(sizeCm, tiers) {
  if (!sizeCm || sizeCm < MIN_HELIUM_CM) return null;
  const ranged = (tiers ?? []).filter((t) => t.min != null && t.max != null);
  const inside = ranged.filter((t) => sizeCm >= t.min && sizeCm <= t.max).sort((a, b) => a.min - b.min);
  if (inside.length) return inside[0];
  const near = ranged
    .filter((t) => t.min === t.max && Math.abs(sizeCm - t.min) <= t.min * 0.1)
    .sort((a, b) => Math.abs(sizeCm - a.min) - Math.abs(sizeCm - b.min));
  return near[0] ?? null;
}

/**
 * What the review screen suggests for a line: whether it's a foil balloon (these go to every sales channel once
 * priced), its size, and the inflation to bundle it with. `bundle` is on only for foil balloons of 40cm or more
 * whose size fits an inflation; staff can switch it off (an air-fill balloon filed as foil) or pick a size.
 */
export function heliumSuggestion(title, tiers, more = {}) {
  const foil = isFoilBalloon(title, more);
  if (!foil) return { foil: false, size: null, tier: null, bundle: false };
  const size = sizeOf([title, more.invoiceTitle, more.catalogueTitle]);
  const tier = pickTier(size, tiers);
  return { foil: true, size, tier: tier?.variantId ?? null, bundle: !!tier };
}

/** "Foil Balloon Luxe Gold Number #3" → "Helium INFLATED Luxe Gold Number #3 Foil Balloon", the store's own pattern. */
export function bundleTitle(title) {
  const name = String(title ?? "")
    .replace(/\bfoil\s+balloons?\b/gi, " ")
    .replace(/\bhelium\s+inflated\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—,]+|[\s\-–—,]+$/g, "")
    .trim();
  return `Helium INFLATED ${name || "Foil"} Foil Balloon`.slice(0, 255);
}

/** Bundle price: balloon + inflation, both GST-inclusive. "8.00" + "12.00" → "20.00". */
export function bundlePrice(balloon, inflation) {
  const cents = Math.round(Number(balloon) * 100) + Math.round(Number(inflation) * 100);
  return (cents / 100).toFixed(2);
}
