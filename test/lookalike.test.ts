// @ts-nocheck -- Node-only test (reads fixture files); the project types are for Cloudflare Workers.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { maybeSame, parseSignature, sameByThumb, signatureFromRGBA, thumbFromRGBA } from "../public/js/phash.js";
import { keepOf } from "../public/js/lookalike.js";

// 256-pixel copies of test pictures, as the browser makes them before fingerprinting.
const DIR = path.join(__dirname, "fixtures", "lookalike");
const sizes = JSON.parse(fs.readFileSync(path.join(DIR, "sizes.json"), "utf8"));
const pic = (name: string) => {
  const [w, h] = sizes[name];
  const data = new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(DIR, `${name}.rgba.gz`))));
  return { parsed: parseSignature(signatureFromRGBA(data, w, h)), thumb: thumbFromRGBA(data, w, h) };
};
const same = (a: string, b: string) => {
  const A = pic(a);
  const B = pic(b);
  return maybeSame(A.parsed, B.parsed) && sameByThumb(A.thumb, B.thumb);
};

describe("look-alike photos", () => {
  it("recognises the same picture resized, re-compressed, sharpened or brightened", () => {
    expect(same("bal1", "bal1_small_q70")).toBe(true);
    expect(same("bal1", "bal1_q55")).toBe(true);
    expect(same("ban30", "ban30_q55")).toBe(true);
    expect(same("ban30", "ban30_small_q70")).toBe(true);
    expect(same("ban30", "ban30_bright")).toBe(true);
    expect(same("prodA", "prodA_small_q70")).toBe(true);
    expect(same("prodA", "prodA_sharpen")).toBe(true);
  });

  it("never merges different products that look alike", () => {
    expect(same("bal1", "bal2")).toBe(false); // number balloons
    expect(same("bal1", "bal7")).toBe(false);
    expect(same("bal1", "bal1_silver")).toBe(false); // gold vs silver
    expect(same("ban30", "ban40")).toBe(false); // Happy 30th vs 40th
    expect(same("b30", "b38")).toBe(false);
    expect(same("b18", "b13")).toBe(false);
    expect(same("ban30", "ban30_silver")).toBe(false);
    expect(same("lab1", "lab7")).toBe(false); // same box, only a small printed code differs
    expect(same("prodA", "prodB")).toBe(false);
    expect(same("prodA", "prodA_blue")).toBe(false);
  });

  it("keeps the clearly sharper copy, otherwise the one stored first", () => {
    const old = { fileId: "gid://shopify/MediaImage/10", pixels: 1_000_000 };
    expect(keepOf({ fileId: "gid://shopify/MediaImage/20", pixels: 1_200_000 }, old)).toBe(old);
    const sharp = { fileId: "gid://shopify/MediaImage/20", pixels: 4_000_000 };
    expect(keepOf(sharp, old)).toBe(sharp);
  });
});
