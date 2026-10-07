// Demo mode: runs the real app on your computer with a FAKE Shopify store and a FAKE invoice reader,
// so you can try the whole interface with no keys and nothing touching your real store.
//   npm run demo   then open http://localhost:8787
// Whatever file you upload, the fake reader returns the same sample party-supply invoice.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "../src/index";
import { sqliteDb } from "../test/sqlite-db";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const realFetch = globalThis.fetch;

type V = { barcode: string; sku: string; product: { id: string; title: string; handle: string } };
let n = 100;
const store: V[] = [
  ["9310720073156", "Balloons Latex 30cm Assorted 25pk"],
  ["4006381333931", "Happy Birthday Banner Gold"],
  ["036000291452", "Party Hats Rainbow 8pk"],
].map(([b, t]) => ({ barcode: b, sku: "", product: { id: `gid://shopify/Product/${n++}`, title: t, handle: t.toLowerCase().replace(/\W+/g, "-") } }));
// pad store to look realistic
for (let i = 0; i < 1955; i++) store.push({ barcode: "", sku: "", product: { id: `gid://shopify/Product/${n++}`, title: `Filler ${i}`, handle: `f${i}` } });

const SUPPLIER_ITEMS = [
  { invoiceTitle: "BLN LTX 30CM ASST 25PK *NEW*", title: "Assorted Latex Balloons 30cm (Pack of 25)", supplierCode: "BL30-25", barcode: "9310720073156" },
  { invoiceTitle: "FOIL BLN NO.1 SLV 86CM CTN 12", title: "Silver Number 1 Foil Balloon 86cm", supplierCode: "FB-N1S", barcode: "9311192614151" },
  { invoiceTitle: "FOIL BLN NO.2 SLV 86CM CTN 12", title: "Silver Number 2 Foil Balloon 86cm", supplierCode: "FB-N2S", barcode: "9311192674902" },
  { invoiceTitle: "PLT PPR 23CM PSTL PNK 10PK", title: "Pastel Pink Paper Plates 23cm (Pack of 10)", supplierCode: "PP23-PK", barcode: "9311192703312" },
  { invoiceTitle: "PARTY HATS RAINBOW 8PK", title: "Rainbow Party Hats (Pack of 8)", supplierCode: "PH-RB8", barcode: "0036000291452" },
  { invoiceTitle: "TBLCVR RECT GLD 137X274 **CLEARANCE**", title: "Gold Rectangle Tablecover 137 x 274cm", supplierCode: "TC-RG", barcode: "9311192609578" },
  { invoiceTitle: "CURL RIBBON MET BLUE 10M", title: "Metallic Blue Curling Ribbon 10m", supplierCode: "CR-MB10", barcode: null },
  { invoiceTitle: "CNDL SPIRAL PSTL 24PK 6/72", title: "Pastel Spiral Candles (Pack of 24)", supplierCode: "CS-P24", barcode: "9311192523729" },
  { invoiceTitle: "NAPK LUNCH 33CM BLK 20PK", title: "Black Lunch Napkins 33cm (Pack of 20)", supplierCode: "NL33-BK", barcode: "9311192577227" },
  { invoiceTitle: "PLT PPR 23CM PSTL PNK 10PK", title: "Pastel Pink Paper Plates 23cm (Pack of 10)", supplierCode: "PP23-PK", barcode: "9311192703312" },
];

// Products "created" in this demo session, and suppliers saved through the page.
const created: Record<string, { vendor?: string; importId: string | null; price: string; tags?: string[] }> = {};
let savedSuppliers: string | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("generativelanguage.googleapis.com")) {
    // DEMO_AI_BUSY=1 npm run demo: the main model answers "overloaded", to try the automatic retry.
    if (process.env.DEMO_AI_BUSY && url.includes(env.AI_MODEL)) return new Response("overloaded", { status: 503 });
    const body = typeof init.body === "string" ? init.body : await new Response(init.body).text();
    const json = JSON.parse(body); // proves the streamed body is valid JSON
    await sleep(900);
    const part = json.contents[0].parts[1];
    let items = SUPPLIER_ITEMS;
    if (part.text && part.text.includes("SHEETTEST")) {
      items = part.text.split("\n").slice(4).filter(Boolean).map((l: string) => {
        const [code, desc, bc] = l.split(",");
        return { title: desc, supplierCode: code, barcode: bc || null };
      });
    }
    const invoice = part.text ? { supplierName: null, invoiceNumber: null } : { supplierName: "Alpen Pty Ltd", invoiceNumber: "INV-45512" };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ ...invoice, items }) }] } }] });
  }
  if (url.includes("myshopify.com")) {
    const { query, variables } = JSON.parse(init.body);
    await sleep(120);
    if (query.includes("locations(")) {
      return Response.json({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "West Lakes" }] }, publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }, { id: "gid://shopify/Publication/2", name: "Point of Sale" }] } } });
    }
    if (query.includes("productVariants") && variables?.q) {
      const terms = String(variables.q).split(" OR ").map((t: string) => t.replace("barcode:", ""));
      return Response.json({ data: { productVariants: { nodes: store.filter((v) => v.barcode && terms.includes(v.barcode)) } } });
    }
    if (query.includes("productVariants")) {
      return Response.json({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: store } } });
    }
    if (query.includes("productVendors")) {
      const vendors = [...new Set(["Alpen", "Dats", "Goldstar", "IG-Design", "Price Savers", "Toplite", ...Object.values(created).map((c) => c.vendor).filter(Boolean)])];
      return Response.json({ data: { productVendors: { edges: vendors.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("shop {")) {
      return Response.json({ data: { shop: { id: "gid://shopify/Shop/1", metafield: savedSuppliers ? { value: savedSuppliers } : null } } });
    }
    if (query.includes("metafieldsSet")) {
      savedSuppliers = variables.m[0].value;
      return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
    }
    if (query.includes("nodes(ids")) {
      return Response.json({
        data: {
          nodes: variables.ids.map((id: string) => {
            const c = created[id];
            return c ? { id, metafield: c.importId ? { value: c.importId } : null, variants: { nodes: [{ price: c.price }] } } : null;
          }),
        },
      });
    }
    if (query.includes("productDelete")) {
      delete created[variables.id];
      const i = store.findIndex((v) => v.product.id === variables.id);
      if (i >= 0) store.splice(i, 1);
      return Response.json({ data: { productDelete: { deletedProductId: variables.id, userErrors: [] } } });
    }
    if (query.includes("productSet")) {
      const input = variables.input;
      if (/fail/i.test(input.title)) return Response.json({ data: { productSet: { product: null, userErrors: [{ field: ["title"], message: "Title is not allowed (test)" }] } } });
      const id = `gid://shopify/Product/${n++}`;
      store.push({ barcode: input.variants[0].barcode ?? "", sku: input.variants[0].sku ?? "", product: { id, title: input.title, handle: "x" } });
      created[id] = { vendor: input.vendor, importId: input.metafields?.[0]?.value ?? null, price: input.variants[0].price, tags: input.tags };
      console.log(`[demo] created ${input.title} | vendor=${input.vendor} | import_source=${input.metafields?.[0]?.value} | tags=${input.tags}`);
      return Response.json({ data: { productSet: { product: { id }, userErrors: [] } } });
    }
    if (query.includes("publishablePublish")) return Response.json({ data: { publishablePublish: { userErrors: [] } } });
  }
  if (url.startsWith("http://localhost")) return realFetch(input, init);
  throw new Error(`Demo mode blocks outside requests: ${url}`);
}) as typeof fetch;

// Runs are kept in an in-memory SQLite database (needs Node 22.13 or newer); they vanish when the demo stops.
const env = {
  DB: sqliteDb(),
  SHOPIFY_STORE_DOMAIN: "price-savers-test.myshopify.com",
  SHOPIFY_API_VERSION: "2025-07",
  SHOPIFY_ADMIN_TOKEN: "demo",
  AI_PROVIDER: "gemini",
  AI_MODEL: "gemini-3.8-flash",
  GEMINI_API_KEY: "demo",
  AI_FALLBACK_MODEL: "gemini-3.1-flash-lite",
  DEV_AUTH_BYPASS: "true",
};

const headersFile = fs.readFileSync(path.join(PUBLIC, "_headers"), "utf8");
const staticHeaders: Record<string, string> = {};
for (const line of headersFile.split("\n").slice(1)) {
  const m = line.trim().match(/^([\w-]+):\s*(.*)$/);
  if (m) staticHeaders[m[1]] = m[2];
}
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain" };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as any,
        body: hasBody ? (req as any) : undefined,
        duplex: "half",
      } as any);
      const out = await app.fetch(request, env as any);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    let p = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
    // Like Cloudflare's single-page-app mode: unknown paths such as /runs/R3 get the page itself.
    if (p.startsWith(PUBLIC) && !path.extname(p) && !fs.existsSync(p)) p = path.join(PUBLIC, "index.html");
    if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", ...staticHeaders });
    fs.createReadStream(p).pipe(res);
  })
  .listen(8787, () => console.log("Demo running: open http://localhost:8787  (fake store, fake invoice reader; Ctrl+C to stop)"));
