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

type V = { barcode: string; sku: string; product: { id: string; title: string; handle: string }; vendor?: string; photos?: number };
let n = 100;
const store: V[] = [
  ["9310720073156", "Balloons Latex 30cm Assorted 25pk"],
  ["4006381333931", "Happy Birthday Banner Gold"],
  ["036000291452", "Party Hats Rainbow 8pk"],
].map(([b, t]) => ({ barcode: b, sku: "", product: { id: `gid://shopify/Product/${n++}`, title: t, handle: t.toLowerCase().replace(/\W+/g, "-") } }));
// Two products already in the store with no photo, that the sample Harbour catalogue covers.
for (const [b, t, sku] of [["9399111770133", "Black Skull Candle Holder 12cm", "HN-7701"], ["", "LED Finger Lights (Pack of 4)", "HN-8010"]]) {
  store.push({ barcode: b, sku, product: { id: `gid://shopify/Product/${n++}`, title: t, handle: t.toLowerCase().replace(/\W+/g, "-") }, vendor: "Harbour Novelty Imports" } as V);
}
// pad store to look realistic
for (let i = 0; i < 1955; i++) store.push({ barcode: "", sku: "", product: { id: `gid://shopify/Product/${n++}`, title: `Filler ${i}`, handle: `f${i}` } });

// The sample "3 - Harbour Novelty Imports - Order HN-5521.xlsx" invoice, as the AI would read it.
const HARBOUR_ITEMS = [
  { invoiceTitle: "HN-7701 SKULL CANDLE HOLDER BLK 12CM", title: "Black Skull Candle Holder 12cm", supplierCode: "HN-7701", barcode: "9399111770133" },
  { invoiceTitle: "SPIDER WEB STRETCH W/ 2 SPIDERS 60G", title: "Stretch Spider Web with 2 Spiders 60g", supplierCode: "HN-7705", barcode: "9399111770515" },
  { invoiceTitle: "PUMPKIN BUCKET LED 18CM ORANGE (BATT INC)", title: "Orange LED Pumpkin Bucket 18cm", supplierCode: "HN-7712", barcode: "9.39911E+12" },
  { invoiceTitle: "GLOW STICKS 20CM 15PK TUBE ASST", title: "Assorted Glow Sticks 20cm (Pack of 15)", supplierCode: "HN-8001", barcode: "71234880010" },
  { invoiceTitle: "GLOW BRACELETS 50PK + CONNECTORS", title: "Glow Bracelets with Connectors (Pack of 50)", supplierCode: "HN-8003", barcode: "71234880034" },
  { invoiceTitle: "LED FINGER LIGHTS 4PC", title: "LED Finger Lights (Pack of 4)", supplierCode: "HN-8010", barcode: null },
  { invoiceTitle: "AUSSIE FLAG HEADBAND", title: "Aussie Flag Headband", supplierCode: "HN-6120", barcode: "6921866190107" },
  { invoiceTitle: "NOVELTY GLASSES RED", title: "Red Novelty Glasses", supplierCode: "HN-6135", barcode: "9399111613501" },
];

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
    if (String(json.contents[0].parts[0].text).includes("product catalogue")) {
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(demoMap(part.text)) }] } }] });
    }
    let items = SUPPLIER_ITEMS;
    if (part.text && part.text.includes("HARBOUR NOVELTY")) {
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ supplierName: "Harbour Novelty Imports", invoiceNumber: "HN-5521", items: HARBOUR_ITEMS }) }] } }] });
    }
    if (part.text && part.text.includes("SHEETTEST")) {
      items = part.text.split("\n").slice(4).filter(Boolean).map((l: string) => {
        const [code, desc, bc] = l.split(",");
        return { title: desc, supplierCode: code, barcode: bc || null };
      });
    }
    const invoice = part.text ? { supplierName: null, invoiceNumber: null } : { supplierName: "Alpen Pty Ltd", invoiceNumber: "INV-45512" };
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ ...invoice, items }) }] } }] });
  }
  if (url.startsWith("https://shopify-staged-uploads.storage.googleapis.com")) {
    // The browser's photo, streamed through the Worker: keep the file part.
    const buf = Buffer.from(await new Response(init.body).arrayBuffer());
    const head = buf.indexOf("\r\n\r\n", buf.indexOf('name="file"'));
    const type = /Content-Type: ([^\r]+)/.exec(buf.subarray(buf.indexOf('name="file"'), head).toString())?.[1] ?? "image/jpeg";
    const end = buf.lastIndexOf("\r\n--");
    const key = new URL(url).searchParams.get("key")!;
    staged.set(key, { bytes: buf.subarray(head + 4, end), type });
    return new Response(null, { status: 204 });
  }
  if (url.includes("myshopify.com")) {
    const { query, variables } = JSON.parse(init.body);
    await sleep(120);
    const filesReply = filesApi(query, variables);
    if (filesReply) return filesReply;
    if (query.includes("locations(")) {
      return Response.json({ data: { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "West Lakes" }] }, publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }, { id: "gid://shopify/Publication/2", name: "Point of Sale" }] } } });
    }
    if (query.includes("products(first")) {
      const seen = new Set<string>();
      const nodes = store
        .filter((v) => (v.barcode || v.sku) && !seen.has(v.product.id) && seen.add(v.product.id))
        .map((v) => ({ ...v.product, vendor: v.vendor ?? "", featuredMedia: v.photos ? { id: "x" } : null, variants: { nodes: [{ barcode: v.barcode, sku: v.sku }] } }));
      return Response.json({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }
    if (query.includes("productUpdate")) {
      const v = store.find((x) => x.product.id === variables.product.id);
      if (v) v.photos = (v.photos ?? 0) + variables.media.length;
      console.log(`[demo] added ${variables.media.length} photo copies to ${v?.product.title}`);
      return Response.json({ data: { productUpdate: { product: { id: variables.product.id }, userErrors: [] } } });
    }
    if (query.includes("productVariants") && variables?.q) {
      const terms = String(variables.q).split(" OR ").map((t: string) => t.replace("barcode:", ""));
      return Response.json({ data: { productVariants: { nodes: store.filter((v) => v.barcode && terms.includes(v.barcode)) } } });
    }
    if (query.includes("productVariants")) {
      return Response.json({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: store } } });
    }
    if (query.includes("productsCount")) {
      // Product counts per vendor: the real store's numbers for the usual suppliers, plus demo-made products.
      const base: Record<string, number> = { alpen: 739, "price savers": 405, goldstar: 296, "ig-design": 252, toplite: 118, dats: 104 };
      const data: Record<string, { count: number }> = {};
      for (const [k, q] of Object.entries(variables as Record<string, string>)) {
        const name = /vendor:"(.*)"/.exec(q)?.[1]?.replace(/\\"/g, '"') ?? "";
        const made = Object.values(created).filter((c) => c.vendor?.toLowerCase() === name.toLowerCase()).length + store.filter((v) => v.vendor?.toLowerCase() === name.toLowerCase()).length;
        data[k.replace(/^q/, "v")] = { count: (base[name.toLowerCase()] ?? 0) + made };
      }
      return Response.json({ data });
    }
    if (query.includes("productVendors")) {
      const vendors = [...new Set(["Alpen", "Dats", "Goldstar", "IG-Design", "Price Savers", "Toplite", ...Object.values(created).map((c) => c.vendor).filter(Boolean), ...store.map((v) => v.vendor).filter(Boolean)])];
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
      store[store.length - 1]!.photos = input.files?.length ?? 0;
      console.log(`[demo] created ${input.title} | vendor=${input.vendor} | import_source=${input.metafields?.[0]?.value} | tags=${input.tags} | photos=${input.files?.length ?? 0} | description=${input.descriptionHtml ? "yes" : "no"}`);
      return Response.json({ data: { productSet: { product: { id }, userErrors: [] } } });
    }
    if (query.includes("publishablePublish")) return Response.json({ data: { publishablePublish: { userErrors: [] } } });
  }
  if (url.startsWith("http://localhost")) return realFetch(input, init);
  throw new Error(`Demo mode blocks outside requests: ${url}`);
}) as typeof fetch;

/* ---------------------------------------------------------------- fake Shopify Files */

const staged = new Map<string, { bytes: Buffer; type: string }>();
type DemoFile = { bytes: Buffer | null; type: string; label: string; created: number; fails: boolean };
const demoFiles = new Map<string, DemoFile>();
let fileSeq = 0;

function filesApi(query: string, variables: any): Response | null {
  if (query.includes("stagedUploadsCreate")) {
    const key = `tmp/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const f = variables.input[0];
    return Response.json({
      data: {
        stagedUploadsCreate: {
          stagedTargets: [
            { url: `https://shopify-staged-uploads.storage.googleapis.com/?key=${encodeURIComponent(key)}`, resourceUrl: `demo-staged://${key}/${f.filename}`, parameters: [{ name: "key", value: key }] },
          ],
          userErrors: [],
        },
      },
    });
  }
  if (query.includes("fileCreate")) {
    const files = variables.files.map((f: any) => {
      const id = `gid://shopify/MediaImage/${++fileSeq}`;
      const m = /^demo-staged:\/\/(.+)\/[^/]+$/.exec(f.originalSource);
      const s = m ? staged.get(m[1]!) : null;
      // A photo link: Shopify would download it. Here a stand-in picture is drawn, and links with "expired" fail.
      demoFiles.set(id, { bytes: s?.bytes ?? null, type: s?.type ?? "image/svg+xml", label: f.alt || f.filename || "Photo", created: Date.now(), fails: /expired/i.test(f.originalSource) });
      return { id, fileStatus: "UPLOADED", fileErrors: [], image: null };
    });
    return Response.json({ data: { fileCreate: { files, userErrors: [] } } });
  }
  if (query.includes("... on File")) {
    return Response.json({
      data: {
        nodes: variables.ids.map((id: string) => {
          const f = demoFiles.get(id);
          if (!f) return null;
          const ready = Date.now() - f.created > 2500; // Shopify takes a moment to process new files
          if (!ready) return { id, fileStatus: "PROCESSING", fileErrors: [], image: null };
          if (f.fails) return { id, fileStatus: "FAILED", fileErrors: [{ message: "The image link couldn't be downloaded (it may have expired)." }], image: null };
          return { id, fileStatus: "READY", fileErrors: [], image: { url: `http://localhost:8787/demo-files/${id.split("/").pop()}` } };
        }),
      },
    });
  }
  if (query.includes("fileDelete")) {
    for (const id of variables.ids) demoFiles.delete(id);
    console.log(`[demo] deleted ${variables.ids.length} files`);
    return Response.json({ data: { fileDelete: { deletedFileIds: variables.ids, userErrors: [] } } });
  }
  if (query.includes("files(first")) return Response.json({ data: { files: { nodes: [] } } });
  return null;
}

function standIn(label: string) {
  const esc = label.replace(/[<&>"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#e8eef6"/><rect x="40" y="36" width="120" height="96" rx="14" fill="#7b9cc4"/><text x="100" y="164" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#2b2f39">${esc.slice(0, 26)}</text></svg>`;
}

/** The fake AI for catalogues: find the headings row and the usual columns. */
function demoMap(sample: string) {
  for (const block of sample.split("## Sheet: ").slice(1)) {
    const sheet = block.split("\n")[0]!.replace(/ \(\d+ pictures.*$/, "").trim();
    for (const line of block.split("\n").slice(1)) {
      const m = /^Row (\d+): (.*)$/.exec(line);
      if (!m) continue;
      const cells = m[2]!.split(" | ").map((c) => c.split("=")) as [string, string][];
      const find = (re: RegExp) => cells.find(([, v]) => re.test(v))?.[0] ?? null;
      const barcode = find(/barcode|ean|apn/i);
      if (!barcode) continue;
      return {
        sheet,
        headerRow: Number(m[1]),
        columns: { barcode, supplierCode: find(/code|item no/i), title: find(/desc|name|product/i), description: null, photoLinks: cells.filter(([, v]) => /image|photo|url/i.test(v)).map(([c]) => c) },
      };
    }
  }
  return { sheet: null, headerRow: null, columns: { barcode: null, supplierCode: null, title: null, description: null, photoLinks: [] } };
}

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
    const df = /^\/demo-files\/(\d+)$/.exec(url.pathname);
    if (df) {
      const f = demoFiles.get(`gid://shopify/MediaImage/${df[1]}`);
      if (!f) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": f.bytes ? f.type : "image/svg+xml", "Cache-Control": "max-age=3600" });
      return res.end(f.bytes ?? standIn(f.label));
    }
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
