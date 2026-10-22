import { describe, expect, it } from "vitest";
import * as server from "../src/photo-names";
// @ts-expect-error plain JS module shared with the browser
import * as browser from "../public/js/photo-names.js";

describe("slug", () => {
  const cases = ["SKULL CANDLE HOLDER BLK 12CM", "Café & Bar — Party Pack (x10)", "Kid's 5th Birthday!!", "", "a".repeat(90), "Glow Sticks 20cm (Pack of 15) Assorted Neon Colours For Parties And Festivals"];
  it("agrees between the browser and the server", () => {
    for (const c of cases) expect(browser.slug(c)).toBe(server.slug(c));
  });
  it("makes readable web-safe names", () => {
    expect(server.slug("SKULL CANDLE HOLDER BLK 12CM")).toBe("skull-candle-holder-blk-12cm");
    expect(server.slug("Café & Bar — Party Pack (x10)")).toBe("cafe-and-bar-party-pack-x10");
    expect(server.slug("Kid's 5th Birthday!!")).toBe("kids-5th-birthday");
  });
  it("cuts long names at a word boundary", () => {
    const s = server.slug("Glow Sticks 20cm (Pack of 15) Assorted Neon Colours For Parties And Festivals", 40);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
    expect("glow-sticks-20cm-pack-of-15-assorted-neon-colours".startsWith(s)).toBe(true);
  });
});

describe("imageExt", () => {
  it("reads names and links", () => {
    expect(server.imageExt("image12.PNG")).toBe(".png");
    expect(server.imageExt("https://cdn.shopify.com/s/files/1/x/files/hn-7701.jpeg?v=17")).toBe(".jpg");
    expect(server.imageExt("https://example.com/photo?id=5")).toBe("");
    expect(browser.imageExt("HN-7701-1.WEBP")).toBe(".webp");
  });
});

describe("catalogue photo names (browser)", () => {
  const item = { title: "SKULL CANDLE HOLDER BLK 12CM", code: "HN-7701" };
  it("names photos from the product's title and code", () => {
    expect(browser.catalogueFileName(item, 0, "image12.png")).toBe("skull-candle-holder-black-12cm-hn-7701.png");
    expect(browser.catalogueFileName(item, 1, "image13.jpeg")).toBe("skull-candle-holder-black-12cm-hn-7701-2.jpg");
  });
  it("doesn't repeat a code already in the title", () => {
    expect(browser.catalogueFileName({ title: "HN-7701 Skull Candle", code: "HN-7701" }, 0, "a.jpg")).toBe("skull-candle-hn-7701.jpg");
  });
  it("keeps the original name when there's nothing to name it from", () => {
    expect(browser.catalogueFileName({ title: "", code: "" }, 0, "photo.jpg")).toBe("photo.jpg");
  });
  it("leaves links without an image extension to Shopify", () => {
    expect(browser.catalogueFileName(item, 0, "https://x.example/p?id=1")).toBe("");
  });
  it("describes each photo in plain words, without the supplier's code", () => {
    expect(browser.catalogueAlt(item, 0, 1)).toBe("Skull Candle Holder Black 12cm");
    expect(browser.catalogueAlt(item, 1, 3)).toBe("Skull Candle Holder Black 12cm, photo 2 of 3");
    expect(browser.catalogueAlt({ title: "", code: "HN-1" }, 0, 1)).toBe("Product HN-1");
    expect(browser.catalogueAlt({ title: "", code: null, barcode: "9399022205014" }, 0, 1)).toBe("Product with barcode 9399022205014");
  });
  it("spells out supplier short forms, pack ratios and colour initials", () => {
    const alt = (title: string) => browser.catalogueAlt({ title, code: "X1" }, 0, 1);
    expect(alt("UMBRELLA KIDS PRINT ASST 55cm")).toBe("Umbrella Kids Print Assorted 55cm");
    expect(alt("CLEAR UMBRELLA DOME [12/60]")).toBe("Clear Umbrella Dome");
    expect(alt("SWEATBANDS R-B-Y 3PCS  12/120")).toBe("Sweatbands Red, Blue and Yellow (Pack of 3)");
    expect(alt("Burgundy 6 Branch Austin Roses 34cm 10/")).toBe("Burgundy 6 Branch Austin Roses 34cm");
    expect(alt(" PRE- PACKED ROSES ASSRT 10")).toBe("Pre-Packed Roses Assorted 10");
  });
});

describe("product photo copies (server)", () => {
  it("names and describes each photo from the shop's title", () => {
    const out = server.namedPhotos("Black Skull Candle Holder 12cm", [
      "https://cdn.shopify.com/s/files/1/files/skull-candle-holder-blk-12cm-hn-7701.png?v=1",
      "https://cdn.shopify.com/s/files/1/files/skull-candle-holder-blk-12cm-hn-7701-2.jpg?v=1",
    ]);
    expect(out).toEqual([
      { url: expect.any(String), alt: "Black Skull Candle Holder 12cm", filename: "black-skull-candle-holder-12cm.png" },
      { url: expect.any(String), alt: "Black Skull Candle Holder 12cm, photo 2 of 2", filename: "black-skull-candle-holder-12cm-2.jpg" },
    ]);
  });
  it("leaves the name to Shopify when the link has no extension", () => {
    expect(server.namedPhotos("Party Hat", ["https://cdn.example/x"])).toEqual([{ url: "https://cdn.example/x", alt: "Party Hat" }]);
  });
});
