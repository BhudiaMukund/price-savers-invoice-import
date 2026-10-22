// A tidy title made by simple rules, shown straight away and kept if the AI can't tidy a line.
// It never invents anything: it only cleans what's printed (capitals, units, pack sizes, common supplier
// abbreviations) and removes barcodes, the item's own code and stock notes.

const ABBR = {
  bln: "Balloon", blns: "Balloons", ltx: "Latex", asst: "Assorted", asstd: "Assorted",
  napk: "Napkins", plt: "Plates", plts: "Plates", bnr: "Banner", met: "Metallic",
  holo: "Holographic", blk: "Black", wht: "White", gld: "Gold", slv: "Silver", pnk: "Pink",
  blu: "Blue", grn: "Green", yel: "Yellow", ylw: "Yellow", ppl: "Purple", pur: "Purple", brn: "Brown",
  gry: "Grey", pstl: "Pastel", rnd: "Round", rect: "Rectangle", lrg: "Large", sml: "Small", med: "Medium",
  ppr: "Paper", plas: "Plastic", tblcvr: "Tablecover", cndl: "Candle", cndls: "Candles",
  assrt: "Assorted", assrtd: "Assorted", assd: "Assorted", assts: "Assorted", prem: "Premium", dlx: "Deluxe", dlxe: "Deluxe",
  bday: "Birthday", xmas: "Christmas", hween: "Halloween", hallo: "Halloween", vday: "Valentine's Day",
  flwr: "Flower", flwrs: "Flowers", ctr: "Centrepiece", decor: "Decoration", decos: "Decorations", deco: "Decoration",
  pkd: "Packed", prepk: "Pre-Packed", bskt: "Basket",
  sil: "Silver", mtl: "Metal", mtlc: "Metallic", foi: "Foil", hdbd: "Headband",
  ltrs: "Letters", nmbr: "Number", nmbrs: "Numbers", sprk: "Sparkler", sprkl: "Sparkler",
};
// Colour initials joined by dashes: "R-B-Y" is red, blue, yellow.
const COLOUR_LETTER = { R: "Red", B: "Blue", Y: "Yellow", G: "Green", W: "White", K: "Black", O: "Orange", P: "Pink" };
const COLOUR_CODE = /(^|[\s(\[])((?:[RBYGWKOP])(?:-[RBYGWKOP])+)(?=$|[\s)(\].,])/g;
// Kept in capitals.
const ACRONYMS = new Set(["LED", "HB", "USB", "DIY", "XL", "XXL", "XS", "AFL", "NRL", "BBQ", "UV", "PVC", "LCD", "AA", "AAA", "TV", "DVD", "CD", "ID", "A3", "A4", "A5", "EVA", "NFL", "NBA", "USA", "UK", "NZ", "AU", "SA", "NSW", "VIC", "QLD", "WA", "NT", "ACT", "TAS", "3D", "2D", "LOL", "OK"]);
const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
const NOTES = /\*+\s*(new|sale|clearance|disc(ontinued)?|special|promo)\s*\*+|\b(clearance|discontinued)\b|\*{2,}|\s\*\s|^\*|\*$/gi;
const CARTON = /\b(ctn|carton|inner|outer)\s*(of\s*)?\d+\b|\b\d+\s*\/\s*\d+\b(?!\s*(cm|mm|m|ml|l|g|kg|in))/gi;
// "in"/"inch" only as a size: "2 IN 1 GAME" stays as it is.
const UNIT = /\b(\d+(?:\.\d+)?)\s*(cm|mm|m|ml|l|ltr|g|gm|kg|ft|oz|(?:in|inch)(?!\s*\d))\b/gi;
const PACK = /\b(\d+)\s*(pk|pck|pack|pkt|pcs|pc|piece|pieces)\b|\bpack\s+of\s+(\d+)\b|(?:^|\s)x\s?(\d+)$/i;

/** Mostly capitals (or mostly lower case): the supplier's own system wrote it, so it gets Title Case. */
export function needsCase(s) {
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length / letters.length;
  return upper > 0.7 || upper < 0.15;
}

function titleCaseWord(w, first) {
  const bare = w.replace(/[^A-Za-z0-9]/g, "");
  if (ACRONYMS.has(bare.toUpperCase()) && bare.length > 1) return w.toUpperCase();
  const lower = w.toLowerCase();
  if (!first && SMALL.has(lower)) return lower;
  // Keep units and sizes as written below ("30cm"), capitalise the rest ("o'brien" -> "O'Brien").
  if (/^\d/.test(w)) return lower;
  return lower.replace(/(^|[-'’(/])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

/**
 * Tidy a printed description by simple rules.
 * code / barcode: the line's own supplier code and barcode, removed if repeated in the description.
 */
export function basicTitle(raw, { code = "", barcode = "" } = {}) {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "");
  if (!s) return "";
  const recase = needsCase(s); // decided on the printed text, before abbreviations are spelled out
  // The line's own code and barcode, and any other barcode-like number.
  for (const v of [code, barcode]) {
    const t = String(v ?? "").trim();
    if (t.length >= 3) s = s.replace(new RegExp(`(^|\\s|\\()${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\s|\\)|,|-)`, "gi"), "$1");
  }
  s = s.replace(/\b\d{8,14}\b/g, " ");
  s = s.replace(NOTES, " ").replace(CARTON, " ").replace(/\s\d+\s*\/\s*$/, " "); // "... 34cm 10/" is a pack note cut short
  s = s.replace(COLOUR_CODE, (_, lead, code) => {
    const names = code.split("-").map((c) => COLOUR_LETTER[c]);
    return `${lead}${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]} `;
  });
  s = s.replace(/\b(pre|non|re|co|multi|self|semi|anti)-\s+(?=[A-Za-z])/gi, "$1-"); // "PRE- PACKED"
  s = s.replace(/([A-Za-z])-\s+/g, "$1 "); // "LEI- RED": a dangling dash
  // Pack size, written once at the end as "(Pack of N)". A pack of 1 is just the item.
  let pack = null;
  const pm = PACK.exec(s);
  if (pm) {
    pack = Number(pm[1] ?? pm[3] ?? pm[4]);
    s = s.replace(pm[0], " ");
  }
  // Abbreviations, word by word ("W/" means "with").
  s = s.replace(/\bw\/\s*/gi, "with ");
  s = s
    .split(" ")
    .map((w) => {
      const key = w.toLowerCase().replace(/[^a-z]/g, "");
      return ABBR[key] && w.replace(/[^A-Za-z]/g, "").length === w.length ? ABBR[key] : w;
    })
    .join(" ");
  s = s.replace(/\s+/g, " ").replace(/\s+([,.)])/g, "$1").replace(/\(\s*\)|\[\s*\]/g, "").replace(/^\[(.*)\]$/, "$1").replace(/^[\s,.;:-]+|[\s,;:-]+$/g, "").trim();
  if (recase) s = s.split(" ").map((w, i) => titleCaseWord(w, i === 0)).join(" ");
  else if (s) s = s[0].toUpperCase() + s.slice(1);
  // Units lower case with no space: 30cm, 2.5m, 500ml.
  s = s.replace(UNIT, (_, n, u) => `${n}${{ ltr: "l", gm: "g", inch: "in" }[u.toLowerCase()] ?? u.toLowerCase()}`);
  s = s.replace(/\b(\d+(?:\.\d+)?)\s*X\s*(\d+(?:\.\d+)?)/g, "$1x$2"); // 137X274 -> 137x274
  if (pack && pack > 1) s = `${s} (Pack of ${pack})`;
  s = s.replace(/\s+/g, " ").trim();
  return s || String(raw ?? "").replace(/\s+/g, " ").trim();
}
