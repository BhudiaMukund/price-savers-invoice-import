import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getShopContext, resetTokenCache } from "../src/shopify";
import type { Env } from "../src/types";

const base = { SHOPIFY_STORE_DOMAIN: "shop.myshopify.com", SHOPIFY_API_VERSION: "2025-07" };
let tokenCalls = 0;
let tokenSeen: string[] = [];
let expireNext = false;

beforeEach(() => {
  resetTokenCache();
  tokenCalls = 0;
  tokenSeen = [];
  expireNext = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (String(url).endsWith("/admin/oauth/access_token")) {
        tokenCalls++;
        const p = new URLSearchParams(init.body);
        if (p.get("client_secret") !== "secret") return new Response("bad", { status: 400 });
        expect(p.get("grant_type")).toBe("client_credentials");
        return Response.json({ access_token: `tok${tokenCalls}`, scope: "read_products", expires_in: 86399 });
      }
      tokenSeen.push(init.headers["X-Shopify-Access-Token"]);
      if (expireNext) {
        expireNext = false;
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({ data: { locations: { nodes: [{ id: "L1", name: "Shop" }] }, publications: { nodes: [] } } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Shopify access tokens", () => {
  it("exchanges client credentials once and reuses the token", async () => {
    const env = { ...base, SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret" } as unknown as Env;
    await getShopContext(env);
    await getShopContext(env);
    expect(tokenCalls).toBe(1);
    expect(tokenSeen).toEqual(["tok1", "tok1"]);
  });

  it("gets a fresh token and retries once when Shopify says the token expired", async () => {
    const env = { ...base, SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret" } as unknown as Env;
    await getShopContext(env);
    expireNext = true;
    await getShopContext(env);
    expect(tokenCalls).toBe(2);
    expect(tokenSeen).toEqual(["tok1", "tok1", "tok2"]);
  });

  it("uses a legacy permanent token without the exchange", async () => {
    const env = { ...base, SHOPIFY_ADMIN_TOKEN: "shpat_x" } as unknown as Env;
    await getShopContext(env);
    expect(tokenCalls).toBe(0);
    expect(tokenSeen).toEqual(["shpat_x"]);
  });

  it("explains a wrong secret in plain words", async () => {
    const env = { ...base, SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "nope" } as unknown as Env;
    await expect(getShopContext(env)).rejects.toThrow(/refused the app's credentials/);
  });
});
