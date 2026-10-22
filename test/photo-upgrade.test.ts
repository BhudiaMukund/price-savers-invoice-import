import { beforeEach, describe, expect, it, vi } from "vitest";
import { candidatesFor, forgetRules, imageSize, upgradePhotoLinks, type Probe } from "../src/photo-upgrade";

const PEPPERI = "https://cdn.pepperi.com/WrntyImages/30012981/PortfolioItems/1/74422371_1_200x200.jpg?ft=1";

const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...u16(16), ...new Array(14).fill(0), 0xff, 0xc0, ...u16(17), 8, ...u16(h), ...u16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const png = (w: number, h: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, ...u16(w), 0, 0, ...u16(h), 8, 2, 0, 0, 0]);
const gif = (w: number, h: number) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
const webpX = (w: number, h: number) => {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 0);
  const W = w - 1, H = h - 1;
  b.set([W & 255, (W >> 8) & 255, (W >> 16) & 255, H & 255, (H >> 8) & 255, (H >> 16) & 255], 24);
  return b;
};

describe("candidatesFor", () => {
  it("tries the link without its size, then larger sizes", () => {
    expect(candidatesFor(PEPPERI).map((c) => c.url)).toEqual([
      "https://cdn.pepperi.com/WrntyImages/30012981/PortfolioItems/1/74422371_1.jpg?ft=1",
      "https://cdn.pepperi.com/WrntyImages/30012981/PortfolioItems/1/74422371_1_1000x1000.jpg?ft=1",
      "https://cdn.pepperi.com/WrntyImages/30012981/PortfolioItems/1/74422371_1_600x600.jpg?ft=1",
    ]);
  });
  it("needs a bigger picture than the thumbnail", () => {
    expect(candidatesFor(PEPPERI)[0]!.minSide).toBe(280);
  });
  it("handles other ways suppliers and shops put a size on a link", () => {
    expect(candidatesFor("https://shop.example/img/cake-150x150.png")[0]!.url).toBe("https://shop.example/img/cake.png");
    expect(candidatesFor("https://cdn.example/p/cake_200x.jpg")[0]!.url).toBe("https://cdn.example/p/cake.jpg");
    expect(candidatesFor("https://cdn.example/p/cake_thumb.jpg")[0]!).toMatchObject({ url: "https://cdn.example/p/cake.jpg", minSide: 400 });
    expect(candidatesFor("https://cdn.example/p/cake.jpg?width=200&v=3").map((c) => c.url)).toEqual([
      "https://cdn.example/p/cake.jpg?v=3",
      "https://cdn.example/p/cake.jpg?width=1000&v=3",
      "https://cdn.example/p/cake.jpg?width=600&v=3",
    ]);
  });
  it("leaves ordinary links, big sizes and non-public addresses alone", () => {
    expect(candidatesFor("https://x.example/photos/cake.jpg")).toEqual([]);
    expect(candidatesFor("https://x.example/p/cake.jpg?width=1600")).toEqual([]);
    expect(candidatesFor("http://localhost/cake_200x200.jpg")).toEqual([]);
    expect(candidatesFor("http://192.168.1.5/cake_200x200.jpg")).toEqual([]);
    expect(candidatesFor("https://x.example:8443/cake_200x200.jpg")).toEqual([]);
    expect(candidatesFor("ftp://x.example/cake_200x200.jpg")).toEqual([]);
    expect(candidatesFor("not a link")).toEqual([]);
  });
});

describe("imageSize", () => {
  it("reads JPEG, PNG, GIF and WebP headers", () => {
    expect(imageSize(jpeg(1200, 900))).toEqual({ width: 1200, height: 900 });
    expect(imageSize(png(800, 600))).toEqual({ width: 800, height: 600 });
    expect(imageSize(gif(300, 200))).toEqual({ width: 300, height: 200 });
    expect(imageSize(webpX(1000, 750))).toEqual({ width: 1000, height: 750 });
  });
  it("gives up on anything else", () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    expect(imageSize(new TextEncoder().encode("<html><body>Not found</body></html>"))).toBeNull();
  });
});

describe("upgradePhotoLinks", () => {
  beforeEach(() => forgetRules());
  const sizes = (map: Record<string, { width: number; height: number } | null>): Probe => async (url) => map[url] ?? null;
  const STRIPPED = "https://cdn.pepperi.com/WrntyImages/30012981/PortfolioItems/1/74422371_1.jpg?ft=1";
  const X5 = "https://cdn.pepperi.com/WrntyImages/30012981/PortfolioItems/1/74422371_1_1000x1000.jpg?ft=1";
  const X3 = "https://cdn.pepperi.com/WrntyImages/30012981/PortfolioItems/1/74422371_1_600x600.jpg?ft=1";

  it("uses the link without its size when that's a bigger picture", async () => {
    expect(await upgradePhotoLinks([PEPPERI], { probe: sizes({ [STRIPPED]: { width: 1500, height: 1500 } }) })).toEqual([STRIPPED]);
  });
  it("goes on to larger sizes when removing the size doesn't work", async () => {
    expect(await upgradePhotoLinks([PEPPERI], { probe: sizes({ [X5]: { width: 1000, height: 1000 } }) })).toEqual([X5]);
    expect(await upgradePhotoLinks([PEPPERI], { probe: sizes({ [X3]: { width: 600, height: 600 } }) })).toEqual([X3]);
  });
  it("keeps the original link when nothing bigger comes back", async () => {
    expect(await upgradePhotoLinks([PEPPERI], { probe: sizes({}) })).toEqual([null]);
  });
  it("won't take the same thumbnail served from another address", async () => {
    expect(await upgradePhotoLinks([PEPPERI], { probe: sizes({ [STRIPPED]: { width: 200, height: 200 }, [X5]: { width: 250, height: 250 } }) })).toEqual([null]);
  });
  it("only checks links that look like thumbnails, and stays inside its budget", async () => {
    const probe = vi.fn(async (u: string) => (/plain/.test(u) ? null : { width: 1200, height: 1200 }));
    const links = [...Array.from({ length: 40 }, (_, i) => `https://cdn.example/p/${i}_200x200.jpg`), "https://cdn.example/plain.jpg"];
    const out = await upgradePhotoLinks(links, { probe, budget: 30 });
    expect(probe).toHaveBeenCalledTimes(30);
    expect(out.filter(Boolean)).toHaveLength(30);
    expect(probe.mock.calls.some(([u]) => String(u).includes("plain"))).toBe(false);
  });
  it("tries a rule on a few links first, and skips the rest when it never works", async () => {
    const probe = vi.fn(sizes({}));
    await upgradePhotoLinks(Array.from({ length: 25 }, (_, i) => `https://cdn.example/p/${i}_200x200.jpg`), { probe });
    expect(probe).toHaveBeenCalledTimes(9); // 3 samples for each of the 3 rules, not 75 checks
  });
  it("stops trying a rule on a host once it has failed every time", async () => {
    const probe = vi.fn(sizes({}));
    const batch = (b: number) => upgradePhotoLinks(Array.from({ length: 5 }, (_, i) => `https://cdn.example/p/${b}${i}_200x200.jpg`), { probe });
    await batch(0);
    await batch(1);
    await batch(2);
    const after3 = probe.mock.calls.length;
    await batch(3);
    expect(probe.mock.calls.length).toBe(after3);
  });
  it("keeps trying a rule that works", async () => {
    const probe: Probe = async (url) => (/_200x200/.test(url) ? null : { width: 1200, height: 1200 });
    for (let b = 0; b < 3; b++) {
      const links = Array.from({ length: 10 }, (_, i) => `https://cdn.example/p/${b}${i}_200x200.jpg`);
      expect((await upgradePhotoLinks(links, { probe })).every(Boolean)).toBe(true);
    }
  });
});
