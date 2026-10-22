import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { resetTokenCache } from "../src/shopify";
import { resetSchemaCache, RunStore } from "../src/store";
import type { Env } from "../src/types";
import { sqliteDb } from "./sqlite-db";

let env: Env;
let fileSeq = 0;
let files: Record<string, { status: string; url: string | null; source: string }>;
let uploads: { url: string; body: string }[];
let productInputs: any[];
let deleted: string[];
let shopifyCalls: string[];
let probes: string[];
let storeProducts: Record<string, { title: string; barcode: string; photos: number }>;

const cdn = (id: string) => `https://cdn.shopify.com/s/files/1/demo/${id.split("/").pop()}.jpg`;

beforeEach(async () => {
  resetTokenCache();
  resetSchemaCache();
  env = {
    SHOPIFY_STORE_DOMAIN: "t.myshopify.com",
    SHOPIFY_API_VERSION: "2026-07",
    SHOPIFY_ADMIN_TOKEN: "t",
    AI_PROVIDER: "gemini",
    AI_MODEL: "m",
    GEMINI_API_KEY: "k",
    DEV_AUTH_BYPASS: "true",
    DB: sqliteDb(),
  } as unknown as Env;
  fileSeq = 0;
  files = {};
  uploads = [];
  productInputs = [];
  deleted = [];
  shopifyCalls = [];
  probes = [];
  storeProducts = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (String(url).startsWith("https://pics.example/")) {
        // The supplier's picture server: a bigger copy exists at the link without its size, except for "nobig".
        probes.push(String(url));
        const name = String(url);
        if (/_200x200|_1000x1000|_600x600/.test(name) || name.includes("nobig")) return new Response("missing", { status: 404 });
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, 0x04, 0xb0, 0x04, 0xb0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        return new Response(jpeg, { status: 206, headers: { "content-type": "image/jpeg", "content-range": `bytes 0-${jpeg.length - 1}/250000` } });
      }
      if (String(url).startsWith("https://shopify-staged-uploads.storage.googleapis.com")) {
        uploads.push({ url, body: Buffer.from(await new Response(init.body).arrayBuffer()).toString("latin1") });
        return new Response(null, { status: 204 });
      }
      const { query, variables } = JSON.parse(init.body);
      const op = /(?:mutation|query)\s+(\w+)/.exec(query)?.[1] ?? "?";
      shopifyCalls.push(op);
      if (query.includes("stagedUploadsCreate")) {
        return Response.json({
          data: {
            stagedUploadsCreate: {
              stagedTargets: [
                {
                  url: "https://shopify-staged-uploads.storage.googleapis.com/",
                  resourceUrl: `https://shopify-staged-uploads.storage.googleapis.com/tmp/${variables.input[0].filename}`,
                  parameters: [{ name: "key", value: "tmp/abc" }, { name: "policy", value: "p0l1cy" }],
                },
              ],
              userErrors: [],
            },
          },
        });
      }
      if (query.includes("fileCreate")) {
        // Like Shopify: the error says which file in the batch it refused (its position in "files").
        const refused = variables.files.map((f: any, i: number) => (f.originalSource.includes("refuse") || (f.originalSource.includes("rejectbig") && !f.originalSource.includes("200x200")) ? i : -1)).filter((i: number) => i >= 0);
        if (refused.length) {
          return Response.json({
            data: { fileCreate: { files: null, userErrors: refused.map((i: number) => ({ field: ["files", String(i), "originalSource"], message: "Image URL is invalid" })) } },
          });
        }
        // A refusal that doesn't say which file: only ever happens for a batch of more than one.
        if (variables.files.length > 1 && variables.files.some((f: any) => f.originalSource.includes("vague"))) {
          return Response.json({ data: { fileCreate: { files: null, userErrors: [{ field: ["files"], message: "Something in this batch is wrong" }] } } });
        }
        if (variables.files.length === 1 && variables.files[0].originalSource.includes("vague")) {
          return Response.json({ data: { fileCreate: { files: null, userErrors: [{ field: ["files", "0", "originalSource"], message: "Image URL is invalid" }] } } });
        }
        const made = variables.files.map((f: any) => {
          const id = `gid://shopify/MediaImage/${++fileSeq}`;
          files[id] = { status: f.originalSource.includes("expired") ? "FAILED" : "READY", url: cdn(id), source: f.originalSource };
          return { id, fileStatus: "UPLOADED", fileErrors: [], image: null };
        });
        return Response.json({ data: { fileCreate: { files: made, userErrors: [] } } });
      }
      if (query.includes("nodes(ids") && query.includes("... on File")) {
        return Response.json({
          data: {
            nodes: variables.ids.map((id: string) => {
              const f = files[id];
              if (!f) return null;
              return { id, fileStatus: f.status, fileErrors: f.status === "FAILED" ? [{ message: "Download failed" }] : [], image: f.status === "READY" ? { url: f.url } : null };
            }),
          },
        });
      }
      if (query.includes("fileDelete")) {
        deleted.push(...variables.ids);
        for (const id of variables.ids) delete files[id];
        return Response.json({ data: { fileDelete: { deletedFileIds: variables.ids, userErrors: [] } } });
      }
      if (query.includes("locations(")) {
        return Response.json({ data: { locations: { nodes: [{ id: "L1", name: "Shop" }] }, publications: { nodes: [{ id: "P2", name: "Point of Sale" }] }, metafieldDefinitions: { nodes: [] } } });
      }
      if (query.includes("productVariants")) return Response.json({ data: { productVariants: { nodes: [] } } });
      if (query.includes("productSet")) {
        productInputs.push(variables.input);
        const media = (variables.input.files ?? []).map((_: unknown, k: number) => ({ id: `gid://shopify/MediaImage/${900 + productInputs.length * 10 + k}` }));
        storeProducts[`gid://shopify/Product/${productInputs.length}`] = { title: variables.input.title, barcode: variables.input.variants[0].barcode ?? "", photos: media.length };
        return Response.json({ data: { productSet: { product: { id: `gid://shopify/Product/${productInputs.length}`, media: { nodes: media } }, userErrors: [] } } });
      }
      if (query.includes("... on Product")) {
        return Response.json({
          data: {
            nodes: variables.ids.map((id: string) => {
              const p = storeProducts[id];
              return p ? { id, title: p.title, handle: "h", vendor: "Harbour Novelty Imports", featuredMedia: p.photos ? { id: "m" } : null, variants: { nodes: [{ barcode: p.barcode, sku: "" }] } } : null;
            }),
          },
        });
      }
      if (query.includes("publishablePublish")) return Response.json({ data: { publishablePublish: { userErrors: [] } } });
      if (query.includes("productUpdate")) {
        const p = storeProducts[variables.product.id];
        if (p) p.photos += variables.media.length;
        return Response.json({ data: { productUpdate: { product: { id: variables.product.id, media: { nodes: variables.media.map((_: unknown, k: number) => ({ id: `gid://shopify/MediaImage/${700 + k}` })) } }, userErrors: [] } } });
      }
      if (query.includes("products(first")) {
        return Response.json({
          data: {
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { id: "gid://shopify/Product/500", title: "Skull Candle", handle: "s", vendor: "Harbour Novelty Imports", featuredMedia: null, variants: { nodes: [{ barcode: "9399111770133", sku: "" }] } },
                { id: "gid://shopify/Product/501", title: "Finger Lights", handle: "f", vendor: "Harbour Novelty Imports", featuredMedia: null, variants: { nodes: [{ barcode: "", sku: "HN8010" }] } },
                { id: "gid://shopify/Product/502", title: "Has a photo", handle: "h", vendor: "Harbour Novelty Imports", featuredMedia: { id: "x" }, variants: { nodes: [{ barcode: "9399111770133", sku: "" }] } },
                { id: "gid://shopify/Product/503", title: "Unknown", handle: "u", vendor: "Other", featuredMedia: null, variants: { nodes: [{ barcode: "", sku: "HN8010" }] } },
              ],
            },
          },
        });
      }
      return Response.json({ errors: [{ message: `unmocked: ${op}` }] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const call = (method: string, p: string, body?: unknown) =>
  app.fetch(new Request(`http://x${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

const FP = (n: number) => n.toString(16).padStart(64, "0");
const photo = (code: string, fp: string, bytes = "JPEGBYTES") =>
  app.fetch(
    new Request(`http://x/api/catalogues/${code}/photo`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "X-File-Name": encodeURIComponent("HN 7701 front.JPG"), "X-Alt": "Skull", "X-Fingerprint": fp },
      body: bytes,
    }),
    env,
  );

async function newUpload(supplier = "Harbour Novelty Imports") {
  return (await json(call("POST", "/api/catalogues", { supplier, fileNames: ["harbour.xlsx"] }))).upload.code as string;
}

describe("catalogue uploads", () => {
  it("streams a photo into Shopify Files, and never uploads the same picture twice", async () => {
    const code = await newUpload();
    expect(code).toBe("C1");
    const first = await json(photo(code, FP(1)));
    expect(first.photo).toMatchObject({ fileId: "gid://shopify/MediaImage/1", status: "processing" });
    expect(uploads).toHaveLength(1);
    // Shopify's fields first, then the file, as multipart form data
    expect(uploads[0]!.body).toMatch(/name="key"\r\n\r\ntmp\/abc\r\n[\s\S]*name="policy"[\s\S]*name="file"; filename="hn-7701-front.jpg"\r\nContent-Type: image\/jpeg\r\n\r\nJPEGBYTES\r\n--/);
    const again = await json(photo(code, FP(1)));
    expect(again).toMatchObject({ reused: true, photo: { fileId: "gid://shopify/MediaImage/1" } });
    expect(uploads).toHaveLength(1);
  });

  it("refuses non-photos and missing fingerprints", async () => {
    const code = await newUpload();
    const bad = await app.fetch(new Request(`http://x/api/catalogues/${code}/photo`, { method: "POST", headers: { "Content-Type": "image/x-emf", "Content-Length": "3", "X-Fingerprint": FP(1) }, body: "abc" }), env);
    expect(bad.status).toBe(415);
    const nofp = await app.fetch(new Request(`http://x/api/catalogues/${code}/photo`, { method: "POST", headers: { "Content-Type": "image/png", "Content-Length": "3" }, body: "abc" }), env);
    expect(nofp.status).toBe(400);
  });

  it("hands links to Shopify, reports refused and expired ones", async () => {
    const code = await newUpload();
    const res = await json(
      call("POST", `/api/catalogues/${code}/links`, {
        links: [
          { url: "https://img.example/a.jpg", alt: "A" },
          { url: "https://img.example/refuse.jpg", alt: "B" },
          { url: "not a link", alt: "C" },
          { url: "https://img.example/expired.jpg", alt: "D" },
        ],
      }),
    );
    expect(res.results.map((r: any) => (r.photo ? "ok" : r.error))).toEqual(["ok", "Image URL is invalid", "Not a web link.", "ok"]);
    // Shopify fails the expired one while processing: it shows up in the upload's failed list.
    const up = (await json(call("GET", `/api/catalogues/${code}`))).upload;
    expect(up.photos).toMatchObject({ ready: 1, failed: 2 });
    expect(up.failed.map((f: any) => f.source)).toEqual(["https://img.example/refuse.jpg", "https://img.example/expired.jpg"]);
  });

  it("sends Shopify a bigger copy of a thumbnail when the supplier's server has one, and the original when not", async () => {
    const code = await newUpload();
    const links = [
      { url: "https://pics.example/a/good_1_200x200.jpg?ft=1", alt: "", name: "" },
      { url: "https://pics.example/a/nobig_1_200x200.jpg?ft=1", alt: "", name: "" },
      { url: "https://x.example/plain.jpg", alt: "", name: "" },
    ];
    const res = await json(call("POST", `/api/catalogues/${code}/links`, { links }));
    expect(res.results.every((r: any) => r.photo)).toBe(true);
    const sent = Object.values(files).map((f) => f.source);
    expect(sent).toContain("https://pics.example/a/good_1.jpg?ft=1"); // bigger
    expect(sent).toContain("https://pics.example/a/nobig_1_200x200.jpg?ft=1"); // nothing bigger: as given
    expect(sent).toContain("https://x.example/plain.jpg"); // not a thumbnail link: untouched
    expect(probes.some((u) => u.includes("plain"))).toBe(false);
  });

  it("falls back to the original link when Shopify refuses the bigger one", async () => {
    const code = await newUpload();
    const res = await json(call("POST", `/api/catalogues/${code}/links`, { links: [{ url: "https://pics.example/a/rejectbig_1_200x200.jpg", alt: "", name: "" }] }));
    expect(res.results[0].photo).toBeTruthy();
    expect(Object.values(files).map((f) => f.source)).toEqual(["https://pics.example/a/rejectbig_1_200x200.jpg"]);
  });

  it("PHOTO_UPGRADE=false keeps every link as given", async () => {
    const code = await newUpload();
    (env as any).PHOTO_UPGRADE = "false";
    await json(call("POST", `/api/catalogues/${code}/links`, { links: [{ url: "https://pics.example/a/good_1_200x200.jpg", alt: "", name: "" }] }));
    expect(Object.values(files).map((f) => f.source)).toEqual(["https://pics.example/a/good_1_200x200.jpg"]);
    expect(probes).toEqual([]);
    delete (env as any).PHOTO_UPGRADE;
  });

  it("a refused link costs one extra call, not one per link (a batch of 25 must fit in one request)", async () => {
    const code = await newUpload();
    const links = Array.from({ length: 25 }, (_, i) => ({ url: i === 7 ? "https://x.example/refuse.jpg" : `https://x.example/p${i}.jpg`, alt: "", name: "" }));
    const before = shopifyCalls.filter((o) => o === "Make").length;
    const res = await json(call("POST", `/api/catalogues/${code}/links`, { links }));
    expect(shopifyCalls.filter((o) => o === "Make").length - before).toBe(2); // the batch, then the 24 that were fine
    expect(res.results.filter((r: any) => r.photo)).toHaveLength(24);
    expect(res.results[7].error).toBe("Image URL is invalid");
  });

  it("when Shopify won't say which link, the batch is split in halves with a limit on calls", async () => {
    const code = await newUpload();
    const links = Array.from({ length: 25 }, (_, i) => ({ url: i === 20 ? "https://x.example/vague.jpg" : `https://x.example/q${i}.jpg`, alt: "", name: "" }));
    const before = shopifyCalls.filter((o) => o === "Make").length;
    const res = await json(call("POST", `/api/catalogues/${code}/links`, { links }));
    expect(shopifyCalls.filter((o) => o === "Make").length - before).toBeLessThanOrEqual(6);
    expect(res.results.filter((r: any) => r.photo).length).toBeGreaterThanOrEqual(12);
  });
});

describe("matching invoices to catalogues", () => {
  async function seed() {
    const code = await newUpload();
    const fid = (await json(photo(code, FP(1)))).photo.fileId;
    await call("POST", `/api/catalogues/${code}/items`, {
      items: [
        { barcode: "9399111770133", code: "HN-7701", title: "SKULL CANDLE HOLDER", description: "Black resin.\n\nBatteries not included.", photos: [fid] },
        { barcode: null, code: "HN-8010", title: "LED FINGER LIGHTS", photos: [] },
        { barcode: "9.39911E+12", code: "HN-7712", title: "PUMPKIN BUCKET", photos: [] },
        { barcode: null, code: null, title: "--- HALLOWEEN ---", photos: [] },
      ],
    });
    const done = (await json(call("POST", `/api/catalogues/${code}/finish`))).upload;
    return { code, fid, done };
  }

  it("matches by barcode from any supplier, and by code only within the supplier", async () => {
    const { done, fid } = await seed();
    expect(done).toMatchObject({ itemCount: 3, photoCount: 1 }); // the heading row had nothing to match on
    const lines = [
      { id: "a", barcode: "9399111770133", supplierCode: null },
      { id: "b", barcode: null, supplierCode: "hn 8010" },
      { id: "c", barcode: "9.39911E+12", supplierCode: "HN-7712" },
      { id: "d", barcode: "9399999999992", supplierCode: "HN-7701" }, // code matches, barcode says otherwise
    ];
    const m = (await json(call("POST", "/api/catalogue/match", { supplier: "harbour  novelty imports", items: lines }))).matches;
    expect(Object.keys(m).sort()).toEqual(["a", "b", "c"]);
    expect(m.a).toMatchObject({ by: "barcode", catalogue: "C1", title: "SKULL CANDLE HOLDER" });
    // Shopify finished processing the photo: its address is filled in on the way
    expect(m.a.photos).toEqual([{ fileId: fid, status: "ready", url: cdn(fid) }]);
    expect(m.b.by).toBe("code");
    const other = (await json(call("POST", "/api/catalogue/match", { supplier: "Someone Else", items: lines }))).matches;
    expect(Object.keys(other)).toEqual(["a"]);
  });

  it("gives new products copies of the photos and the description", async () => {
    const { fid } = await seed();
    await call("POST", "/api/catalogue/match", { supplier: "Harbour Novelty Imports", items: [{ id: "a", barcode: "9399111770133" }] }); // photo now ready
    await new RunStore(env.DB!).createRun("dev@local");
    const res = await json(
      call("POST", "/api/create", {
        runCode: "R1",
        items: [
          { id: "a", invoiceId: "s1", title: "Black Skull Candle Holder 12cm", barcode: "9399111770133", vendor: "Harbour Novelty Imports", importId: "20261007-R1-HARBOUR-AAAA", photos: [fid, "gid://shopify/MediaImage/999"], description: "Black resin.\n\nBatteries <not> included." },
        ],
      }),
    );
    expect(res.results[0]).toMatchObject({ status: "created", photos: 1 });
    expect(productInputs[0].files).toEqual([{ originalSource: cdn(fid), contentType: "IMAGE", alt: "Black Skull Candle Holder 12cm", filename: expect.stringMatching(/^black-skull-candle-holder-12cm\.(jpg|png)$/) }]);
    expect(productInputs[0].descriptionHtml).toBe("<p>Black resin.</p><p>Batteries &lt;not&gt; included.</p>");
  });

  it("finds store products without photos that a catalogue covers, and adds copies", async () => {
    const { fid } = await seed();
    await call("POST", "/api/catalogue/match", { supplier: "Harbour Novelty Imports", items: [{ id: "a", barcode: "9399111770133" }] });
    const res = await json(call("GET", "/api/catalogue/missing-photos"));
    expect(res.checked).toBe(3); // the one with a photo is left out
    expect(res.found.map((f: any) => f.product.productId)).toEqual(["gid://shopify/Product/500"]); // 501 matches but has no photo; 503 is another supplier
    const att = await json(call("POST", "/api/catalogue/attach", { items: [{ productId: "gid://shopify/Product/500", title: "Skull", fileIds: [fid] }] }));
    expect(att.results).toEqual([{ productId: "gid://shopify/Product/500", ok: true, photos: 1 }]);
  });
});

describe("undoing a catalogue upload", () => {
  it("brings back the previous upload, and keeps photos a newer upload still uses", async () => {
    const c1 = await newUpload();
    const fid = (await json(photo(c1, FP(1)))).photo.fileId;
    const fid2 = (await json(photo(c1, FP(2), "OTHERBYTES"))).photo.fileId;
    await call("POST", `/api/catalogues/${c1}/items`, { items: [{ code: "HN-7701", title: "Old title", photos: [fid, fid2] }] });
    await call("POST", `/api/catalogues/${c1}/finish`);

    const c2 = await newUpload();
    expect((await json(call("POST", `/api/catalogues/${c2}/known`, { fingerprints: [FP(1), FP(3)] }))).known).toEqual({
      [FP(1)]: { fileId: fid, status: "processing", url: null },
    });
    await call("POST", `/api/catalogues/${c2}/items`, { items: [{ code: "HN-7701", title: "New title", photos: [fid] }] });
    await call("POST", `/api/catalogues/${c2}/finish`);

    const match = async () => (await json(call("POST", "/api/catalogue/match", { supplier: "Harbour Novelty Imports", items: [{ id: "x", supplierCode: "HN-7701" }] }))).matches.x;
    expect((await match()).title).toBe("New title");

    // Undo the older one: the photo C2 also uses moves to C2; only C1's other photo is deleted.
    expect((await json(call("POST", `/api/catalogues/${c1}/undo`))).remaining).toBe(1);
    expect((await json(call("POST", `/api/catalogues/${c1}/undo-step`))).remaining).toBe(0);
    expect(deleted).toEqual([fid2]);
    expect((await match()).photos.map((p: any) => p.fileId)).toEqual([fid]);

    // Undo the newer one too: now nothing uses that photo, so it goes.
    expect((await json(call("POST", `/api/catalogues/${c2}/undo`))).remaining).toBe(1);
    await call("POST", `/api/catalogues/${c2}/undo-step`);
    expect(deleted).toEqual([fid2, fid]);
    expect(await match()).toBeUndefined();
    // An undone upload can't take more items
    expect((await call("POST", `/api/catalogues/${c2}/items`, { items: [] })).status).toBe(409);
  });

  it("lists finished uploads, newest first, and searches them", async () => {
    const c1 = await newUpload("Harbour Novelty Imports");
    await call("POST", `/api/catalogues/${c1}/finish`);
    const c2 = await newUpload("Koala Craft");
    await call("POST", `/api/catalogues/${c2}/finish`);
    await newUpload("Unfinished");
    expect((await json(call("GET", "/api/catalogues"))).uploads.map((u: any) => u.code)).toEqual(["C2", "C1"]);
    expect((await json(call("GET", "/api/catalogues?q=koala"))).uploads.map((u: any) => u.code)).toEqual(["C2"]);
  });
});

describe("look-alike photos on the server", () => {
  const SIG = (n: number) => `v1.${n.toString(16).padStart(64, "0")}.${"f".repeat(96)}.1000`;
  it("pages the fingerprints, and lists the other photos on a product for photos still to be fingerprinted", async () => {
    const c1 = await newUpload();
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) ids.push((await json(photo(c1, FP(n), `N${n}`))).photo.fileId);
    await call("POST", `/api/catalogues/${c1}/items`, { items: [{ code: "A-1", title: "A", photos: [ids[0], ids[1]] }, { code: "B-1", title: "B", photos: [ids[2]] }] });
    await call("POST", `/api/catalogues/${c1}/finish`);
    await call("GET", `/api/catalogues/${c1}`);
    await call("POST", "/api/catalogue/signatures", { items: [{ fileId: ids[0], sig: SIG(1), thumb: "AAAA", pixels: 100 }] });
    const page = await json(call("GET", "/api/catalogue/signatures"));
    expect(page).toMatchObject({ next: null, missing: 2 });
    expect(page.files.map((f: any) => f.fileId)).toEqual([ids[0]]);
    expect((await json(call("GET", "/api/catalogue/signatures?after=999999"))).files).toEqual([]);
    const missing = (await json(call("GET", "/api/catalogue/signatures/missing"))).files;
    expect(missing.find((f: any) => f.fileId === ids[1]).siblings).toEqual([ids[0]]); // the other photo of product A-1
    expect(missing.find((f: any) => f.fileId === ids[2]).siblings).toEqual([]);
  });

  it("saves a full batch of products in a few database calls", async () => {
    const c1 = await newUpload();
    const one = (await json(photo(c1, FP(1)))).photo.fileId;
    const items = Array.from({ length: 100 }, (_, i) => ({ code: `P-${i}`, title: `Item ${i}`, photos: [one] }));
    // Count the calls that reach the database: a batch is one, however many statements are in it.
    let calls = 0;
    const real = env.DB as any;
    const wrap = (st: any): any => ({
      bind: (...v: unknown[]) => wrap(st.bind(...v)),
      first: (...a: unknown[]) => (calls++, st.first(...a)),
      all: (...a: unknown[]) => (calls++, st.all(...a)),
      run: (...a: unknown[]) => (calls++, st.run(...a)),
      raw: st,
    });
    (env as any).DB = {
      prepare: (sql: string) => wrap(real.prepare(sql)),
      batch: (stmts: any[]) => (calls++, real.batch(stmts.map((x) => x.raw ?? x))),
    };
    const res = await json(call("POST", `/api/catalogues/${c1}/items`, { items }));
    expect(res.added).toBe(100);
    expect(calls).toBeLessThan(20); // one call per batch, not one per product (free plan: about 50 per request)
    const done = await json(call("POST", `/api/catalogues/${c1}/finish`));
    expect(done.upload).toMatchObject({ itemCount: 100, photoCount: 1 });
  });

  it("stores fingerprints, serves thumbnails, and merges a look-alike into the photo that's kept", async () => {
    const c1 = await newUpload();
    const keep = (await json(photo(c1, FP(1)))).photo.fileId;
    const dupe = (await json(photo(c1, FP(2), "OTHER"))).photo.fileId;
    await call("POST", `/api/catalogues/${c1}/items`, {
      items: [
        { code: "A-1", title: "A", photos: [keep, dupe] },
        { code: "B-1", title: "B", photos: [dupe] },
      ],
    });
    await call("POST", `/api/catalogues/${c1}/finish`);
    await call("GET", `/api/catalogues/${c1}`); // photos become ready

    expect((await json(call("GET", "/api/catalogue/signatures"))).missing).toBe(2);
    const saved = await json(call("POST", "/api/catalogue/signatures", {
      items: [
        { fileId: keep, sig: SIG(1), thumb: "AAAA", pixels: 100 },
        { fileId: dupe, sig: SIG(2), thumb: "BBBB", pixels: 100 },
        { fileId: dupe, sig: "not a fingerprint", thumb: "x", pixels: 1 },
      ],
    }));
    expect(saved.saved).toBe(2);
    expect((await json(call("GET", "/api/catalogue/signatures"))).files).toHaveLength(2);
    expect((await json(call("POST", "/api/catalogue/thumbs", { fileIds: [keep] }))).thumbs).toEqual({ [keep]: "AAAA" });

    const merged = await json(call("POST", "/api/catalogue/merge", { pairs: [{ from: dupe, to: keep }] }));
    expect(merged).toEqual({ merged: 1, deleted: 1 });
    expect(deleted).toEqual([dupe]);
    // Item A had both: it keeps one. Item B switches over.
    const items = (await json(call("GET", `/api/catalogues/${c1}/items`))).items;
    expect(items.map((i: any) => [i.code, i.photos.map((p: any) => p.fileId)])).toEqual([
      ["A-1", [keep]],
      ["B-1", [keep]],
    ]);
    // The same bytes uploaded again count as the photo it was merged into.
    expect((await json(call("POST", `/api/catalogues/${c1}/known`, { fingerprints: [FP(2)] }))).known[FP(2)].fileId).toBe(keep);
    // Merging again, or into a deleted photo, does nothing.
    expect((await json(call("POST", "/api/catalogue/merge", { pairs: [{ from: dupe, to: keep }, { from: keep, to: dupe }] }))).merged).toBe(0);
  });
});

describe("uploading the same photos again", () => {
  it("works after the catalogue they came from was undone", async () => {
    const c1 = await newUpload();
    const first = (await json(photo(c1, FP(7)))).photo.fileId;
    await call("POST", `/api/catalogues/${c1}/items`, { items: [{ code: "KC-118", title: "Pens", photos: [first] }] });
    await call("POST", `/api/catalogues/${c1}/finish`);
    await call("POST", `/api/catalogues/${c1}/undo`);
    await call("POST", `/api/catalogues/${c1}/undo-step`);
    expect(deleted).toEqual([first]);

    const c2 = await newUpload();
    expect((await json(call("POST", `/api/catalogues/${c2}/known`, { fingerprints: [FP(7)] }))).known).toEqual({});
    const again = await photo(c2, FP(7));
    expect(again.status).toBe(200);
    const fid = ((await again.json()) as any).photo.fileId;
    expect(fid).not.toBe(first);
    expect((await json(call("GET", `/api/catalogues/${c2}`))).upload.failed).toEqual([]);
  });

  it("doesn't reuse a photo Shopify couldn't process", async () => {
    const c1 = await newUpload();
    await call("POST", `/api/catalogues/${c1}/links`, { links: [{ url: "https://img.example/expired.jpg", alt: "x" }] });
    await call("GET", `/api/catalogues/${c1}`); // now known to have failed
    const fp = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("url:https://img.example/expired.jpg")))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect((await json(call("POST", `/api/catalogues/${c1}/known`, { fingerprints: [fp] }))).known).toEqual({});
  });

  it("removes a photo from Shopify if it can't be recorded", async () => {
    const c1 = await newUpload();
    const real = (env.DB as any).prepare.bind(env.DB);
    let failures = 1; // recording the photo fails; recording the failure afterwards works
    (env.DB as any).prepare = (sql: string) =>
      sql.trim().startsWith("INSERT INTO catalogue_files") && failures-- > 0 ? { bind: () => ({ run: async () => { throw new Error("database is busy"); } }) } : real(sql);
    const res = await photo(c1, FP(9));
    (env.DB as any).prepare = real;
    expect(res.status).toBe(502);
    expect(deleted).toHaveLength(1); // the copy that reached Shopify was removed again
  });
});

describe("catalogue photos on store products", () => {
  async function productWithCataloguePhoto() {
    const c1 = await newUpload();
    const fid = (await json(photo(c1, FP(1)))).photo.fileId;
    await call("POST", `/api/catalogues/${c1}/items`, { items: [{ barcode: "9399111770133", code: "HN-7701", title: "Skull", photos: [fid] }] });
    await call("POST", `/api/catalogues/${c1}/finish`);
    await call("GET", `/api/catalogues/${c1}`); // photo ready
    await new RunStore(env.DB!).createRun("dev@local");
    await call("POST", "/api/create", {
      runCode: "R1",
      items: [{ id: "a", invoiceId: "s1", title: "Black Skull Candle Holder", barcode: "9399111770133", importId: "20261007-R1-HARBOUR-AAAA", photos: [fid] }],
    });
    return { c1, fid, productId: "gid://shopify/Product/1", copy: "gid://shopify/MediaImage/910" };
  }

  it("won't remove a catalogue whose photos are on products without the typed code", async () => {
    const { c1 } = await productWithCataloguePhoto();
    const refused = await call("POST", `/api/catalogues/${c1}/undo`, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "has_products", products: 1, titles: ["Black Skull Candle Holder"] });
    expect((await call("POST", `/api/catalogues/${c1}/undo`, { confirm: "C2" })).status).toBe(409); // wrong code
    // Nothing changed: still matching
    const m = await json(call("POST", "/api/catalogue/match", { supplier: "Harbour Novelty Imports", items: [{ id: "x", barcode: "9399111770133" }] }));
    expect(m.matches.x).toBeTruthy();
  });

  it("with the code typed: removes the photos from the products too, and remembers those products", async () => {
    const { c1, fid, productId, copy } = await productWithCataloguePhoto();
    expect((await json(call("POST", `/api/catalogues/${c1}/undo`, { confirm: "c1" }))).remaining).toBe(1);
    await call("POST", `/api/catalogues/${c1}/undo-step`);
    expect(deleted).toEqual([copy, fid]); // the product's copy, then the catalogue's photo
    expect((await call("DELETE", `/api/catalogues/${c1}`)).status).toBe(200);
    expect((await json(call("GET", "/api/catalogues"))).uploads).toEqual([]);

    // A later catalogue with the same product: it's offered photos again, marked as having lost them.
    storeProducts[productId]!.photos = 0;
    const c2 = await newUpload();
    const fid2 = (await json(photo(c2, FP(2), "NEWPHOTO"))).photo.fileId;
    await call("POST", `/api/catalogues/${c2}/items`, { items: [{ barcode: "9399111770133", code: "HN-7701", title: "Skull", photos: [fid2] }] });
    await call("POST", `/api/catalogues/${c2}/finish`);
    await call("GET", `/api/catalogues/${c2}`);
    expect(await json(call("GET", "/api/catalogue/stripped"))).toEqual({ products: 1, matched: 1 });
    const missing = await json(call("GET", "/api/catalogue/missing-photos"));
    const hit = missing.found.find((f: any) => f.product.productId === productId);
    expect(hit.stripped).toMatchObject({ catalogue: "C1" });
    await call("POST", "/api/catalogue/attach", { items: [{ productId, title: "Black Skull Candle Holder", fileIds: [fid2] }] });
    expect(await json(call("GET", "/api/catalogue/stripped"))).toEqual({ products: 0, matched: 0 });
  });

  it("removes a catalogue nobody's products use with no code needed", async () => {
    const c1 = await newUpload();
    const fid = (await json(photo(c1, FP(3)))).photo.fileId;
    await call("POST", `/api/catalogues/${c1}/items`, { items: [{ code: "Z-1", title: "Z", photos: [fid] }] });
    await call("POST", `/api/catalogues/${c1}/finish`);
    expect((await json(call("POST", `/api/catalogues/${c1}/undo`, {}))).remaining).toBe(1);
    expect((await call("DELETE", `/api/catalogues/${c1}`)).status).toBe(409); // photos not deleted yet
    await call("POST", `/api/catalogues/${c1}/undo-step`);
    expect((await call("DELETE", `/api/catalogues/${c1}`)).status).toBe(200);
  });
});

