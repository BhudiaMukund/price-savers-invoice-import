import { describe, expect, it } from "vitest";
import * as entry from "../src/index";

describe("Worker main module", () => {
  // Cloudflare treats every export of the main module as an entry point and refuses to start
  // if one isn't a handler. Keep constants in other files.
  it("only exports the app", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
  });
});
