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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
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
        if (variables.files.some((f: any) => f.originalSource.includes("refuse"))) {
          if (variables.files.length > 1) return Response.json({ data: { fileCreate: { files: null, userErrors: [{ field: ["files", "0"], message: "Bad URL" }] } } });
          return Response.json({ data: { fileCreate: { files: null, userErrors: [{ field: ["files", "0", "originalSource"], message: "Image URL is invalid" }] } } });
        }
        const made = variables.files.map((f: any) => {
          const id = `gid://shopify/MediaImage/${++fileSeq}`;
          files[id] = { status: f.originalSource.includes("expired") ? "FAILED" : "READY", url: cdn(id), source: f.originalSource };
          return { id, fileStatus: "UPLOADED", fileErrors: [], image: null };
        });
        return Response.json({ data: { fileCreate: { files: made, userErrors: [] } } });
      }
      if (query.includes("nodes(ids")) {
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
        return Response.json({ data: { productSet: { product: { id: `gid://shopify/Product/${productInputs.length}` }, userErrors: [] } } });
      }
      if (query.includes("publishablePublish")) return Response.json({ data: { publishablePublish: { userErrors: [] } } });
      if (query.includes("productUpdate")) return Response.json({ data: { productUpdate: { product: { id: variables.product.id }, userErrors: [] } } });
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
    expect(productInputs[0].files).toEqual([{ originalSource: cdn(fid), contentType: "IMAGE", alt: "Black Skull Candle Holder 12cm" }]);
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

