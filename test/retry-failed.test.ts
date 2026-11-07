import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { sniffImage } from "../src/sniff";
import { CatalogueStore } from "../src/catalogue";
import { resetSchemaCache } from "../src/store";
import type { Env } from "../src/types";
import { sqliteDb } from "./sqlite-db";

const env = {
  SHOPIFY_STORE_DOMAIN: "test.myshopify.com",
  SHOPIFY_API_VERSION: "2026-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "gemini-test",
  GEMINI_API_KEY: "k",
  DEV_AUTH_BYPASS: "true",
} as unknown as Env;

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const avif = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const html = new TextEncoder().encode("<!DOCTYPE html><html>nope</html>");

const SRC = (n: string) => `https://blob.example/img/${n}.jpg`;
let sources: Record<string, { status: number; bytes: Uint8Array; type?: string }> = {};
let uploads: { name: string; type: string }[] = [];
let deleted: string[] = [];

function mockFetch() {
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (url.startsWith("https://blob.example/")) {
        const s = sources[url];
        if (!s) return new Response("nope", { status: 404 });
        return new Response(s.bytes, { status: s.status, headers: { "Content-Type": s.type ?? "application/octet-stream" } });
      }
      if (url.startsWith("https://upload.example/")) {
        const form = init.body;
        const buf = new Uint8Array(await new Response(form).arrayBuffer());
        const text = new TextDecoder("latin1").decode(buf);
        uploads.push({ name: /filename="([^"]+)"/.exec(text)?.[1] ?? "", type: /Content-Type: ([^\r]+)/.exec(text)?.[1] ?? "" });
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(init.body);
      const q: string = body.query;
      if (q.includes("Stage(")) return Response.json({ data: { stagedUploadsCreate: { stagedTargets: [{ url: "https://upload.example/x", resourceUrl: "https://stage.example/r", parameters: [{ name: "k", value: "v" }] }], userErrors: [] } } });
      if (q.includes("Make(")) return Response.json({ data: { fileCreate: { files: body.variables.files.map(() => ({ id: `gid://shopify/MediaImage/${900 + ++n}`, fileStatus: "UPLOADED" })), userErrors: [] } } });
      if (q.includes("Del(")) {
        deleted.push(...body.variables.ids);
        return Response.json({ data: { fileDelete: { deletedFileIds: body.variables.ids, userErrors: [] } } });
      }
      return Response.json({ errors: [{ message: "unmocked" }] });
    }),
  );
}

const call = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

let store: CatalogueStore;
beforeEach(async () => {
  resetSchemaCache();
  const db = sqliteDb();
  (env as any).DB = db;
  store = new CatalogueStore(db as any);
  sources = {};
  uploads = [];
  deleted = [];
  mockFetch();
  await json(call("POST", "/api/catalogues", { supplier: "Durmaz", fileNames: ["d.csv"] }));
});
afterEach(() => vi.unstubAllGlobals());

async function failedPhoto(fileId: string, source: string) {
  const up = await store.open("C1");
  await store.addFile({ fileId, fingerprint: null, uploadId: up.id, status: "failed", url: null, source, error: "Media could not be processed because the image is an unsupported file type." });
  await store.addItems("C1", [{ barcode: "9300000000019", code: "A1", title: "Thing", description: null, mixed: false, photos: [fileId] } as any]);
}

describe("reading what a file really is", () => {
  it("knows the common pictures and says what the others are", () => {
    expect(sniffImage(jpeg)).toMatchObject({ ok: true, ext: "jpg" });
    expect(sniffImage(png)).toMatchObject({ ok: true, ext: "png" });
    expect(sniffImage(avif)).toEqual({ ok: false, what: "an AVIF image" });
    expect(sniffImage(html)).toMatchObject({ ok: false });
    expect(sniffImage(new Uint8Array())).toEqual({ ok: false, what: "an empty file" });
  });
});

describe("trying failed photos again", () => {
  it("uploads the real bytes with the real type, and moves products to the new photo", async () => {
    sources[SRC("1")] = { status: 200, bytes: jpeg, type: "application/octet-stream" }; // wrong type from the server
    await failedPhoto("gid://shopify/MediaImage/1", SRC("1"));
    const res = await json(call("POST", "/api/catalogues/C1/retry-failed", {}));
    expect(res).toMatchObject({ fixed: 1, notFixed: 0, next: null });
    expect(uploads[0]).toEqual({ name: "thing-a1.jpg", type: "image/jpeg" }); // named after the product, not the link
    const items = await json(call("GET", "/api/catalogues/C1/items"));
    expect(JSON.stringify(items)).toContain("gid://shopify/MediaImage/9");
    expect(JSON.stringify(items)).not.toContain("gid://shopify/MediaImage/1\"");
    expect(deleted).toEqual(["gid://shopify/MediaImage/1"]); // the failed copy is cleared out of Shopify Files
  });

  it("names the real reason when a file can't be fixed", async () => {
    sources[SRC("2")] = { status: 200, bytes: avif, type: "image/jpeg" };
    sources[SRC("3")] = { status: 200, bytes: html, type: "text/html" };
    await failedPhoto("gid://shopify/MediaImage/2", SRC("2"));
    await failedPhoto("gid://shopify/MediaImage/3", SRC("3"));
    await failedPhoto("gid://shopify/MediaImage/4", SRC("4")); // 404
    const res = await json(call("POST", "/api/catalogues/C1/retry-failed", {}));
    expect(res.fixed).toBe(0);
    expect(res.notFixed).toBe(3);
    expect(Object.keys(res.reasons).join(" ")).toMatch(/AVIF/);
    expect(Object.keys(res.reasons).join(" ")).toMatch(/web page/);
    expect(Object.keys(res.reasons).join(" ")).toMatch(/404/);
    expect(uploads.length).toBe(0);
    // the list now shows the real reasons
    const up = await json(call("GET", "/api/catalogues/C1"));
    expect(up.upload.failed.map((f: any) => f.error).join(" ")).toMatch(/AVIF/);
  });

  it("works through a long list a page at a time", async () => {
    for (let i = 10; i < 20; i++) {
      sources[SRC(String(i))] = { status: 200, bytes: png, type: "image/png" };
      await failedPhoto(`gid://shopify/MediaImage/${i}`, SRC(String(i)));
    }
    const first = await json(call("POST", "/api/catalogues/C1/retry-failed", { size: 8 }));
    expect(first.fixed).toBe(8);
    expect(first.next).not.toBeNull();
    const second = await json(call("POST", "/api/catalogues/C1/retry-failed", { after: first.next, size: 8 }));
    expect(second.fixed + second.notFixed).toBeGreaterThan(0);
    expect(first.fixed + second.fixed).toBe(10);
  });
});

describe("photos too big for one call", () => {
  it("does a few per call, and can skip the one that can't be done", async () => {
    for (const n of ["11", "12", "13", "14"]) {
      sources[SRC(n)] = { status: 200, bytes: jpeg, type: "image/jpeg" };
      await failedPhoto(`gid://shopify/MediaImage/${n}`, SRC(n));
    }
    const first = await json(call("POST", "/api/catalogues/C1/retry-failed", { size: 1, skip: true }));
    expect(first).toMatchObject({ fixed: 0, notFixed: 1 });
    expect(first.next).not.toBeNull();
    const rest = await json(call("POST", "/api/catalogues/C1/retry-failed", { after: first.next, size: 3 }));
    expect(rest).toMatchObject({ fixed: 3, next: null });
    const up = await json(call("GET", "/api/catalogues/C1"));
    expect(JSON.stringify(up.upload.failed)).toMatch(/too big to process here/);
  });
});
