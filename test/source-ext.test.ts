import { describe, expect, it } from "vitest";
import { withSourceExt } from "../src/files";

describe("withSourceExt", () => {
  it("keeps the link's exact extension, capitals included", () => {
    expect(withSourceExt("candle-holder.jpg", "https://ec.goldstarimports.com.au/Triumph%20Images/ACC5080.JPG")).toEqual({ filename: "candle-holder.JPG" });
    expect(withSourceExt("candle-holder.jpg", "https://x.com/a/b.jpeg?v=2")).toEqual({ filename: "candle-holder.jpeg" });
  });
  it("gives no name when the link has no extension", () => {
    expect(withSourceExt("candle-holder.jpg", "https://x.com/image/123")).toEqual({});
  });
});
