// Turns what an invoice line says about quantity into whole units for the shop's stock.
// The AI and the spreadsheet reader both hand over the same raw fields:
//   quantity  the number supplied on the line, as printed
//   unit      what it counts, as printed ("EA", "CTN", "DOZ"...), or ""
//   unitsPer  how many single retail units one invoiced unit holds, when the invoice says so, or null
//   unclear   the AI couldn't tell whether it counts units or cartons
// Result: { qty, note, check }. qty is a whole number or null. check means staff must look before it's used.

const SINGLE = /^(ea|each|unit|units|pc|pcs|piece|pieces|item|items|u|qty)\.?$/i;
const DOZEN = /^(doz|dozen|dz)\.?$/i;
const MULTI = /(ctn|carton|case|box|inner|outer|bundle|pallet|tray|display|pack|pk|set|bag|bx|cs)/i;

export function resolveQuantity({ quantity, unit = "", unitsPer = null, unclear = false } = {}) {
  const q = typeof quantity === "string" ? (quantity.trim() === "" ? null : Number(quantity.replace(/,/g, "").trim())) : quantity;
  if (q === null || q === undefined || !Number.isFinite(q) || q < 0) return { qty: null, note: "No quantity on this line", check: true };
  if (!Number.isInteger(q)) return { qty: null, note: `Quantity ${q} isn't a whole number`, check: true };
  const u = String(unit ?? "").trim();
  let per = Number.isInteger(unitsPer) && unitsPer >= 1 ? unitsPer : null;
  if (per === null && DOZEN.test(u)) per = 12;
  const countsBundles = u && !SINGLE.test(u) && !DOZEN.test(u) && MULTI.test(u);
  let check = unclear === true;
  let note = "";
  if (per !== null && per > 1) note = `${q} × ${per}`;
  else if (per === null && countsBundles) {
    check = true;
    note = `Invoiced as ${q} ${u}: how many single items?`;
  } else if (unclear) note = "Unit unclear: check the quantity";
  const qty = q * (per ?? 1);
  if (qty > 100000) return { qty: null, note: "That quantity looks too big", check: true };
  return { qty, note, check };
}
