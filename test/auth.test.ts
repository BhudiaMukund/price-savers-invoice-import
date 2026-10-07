import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { resetAuthCache } from "../src/auth";
import type { Env } from "../src/types";

const TEAM = "shop.cloudflareaccess.com";
const AUD = "aud-123";

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function makeKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  return { privateKey: pair.privateKey, jwk };
}

async function sign(privateKey: CryptoKey, claims: Record<string, unknown>, kid = "k1") {
  const h = b64url(JSON.stringify({ alg: "RS256", kid }));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const baseEnv = {
  SHOPIFY_STORE_DOMAIN: "t.myshopify.com",
  SHOPIFY_API_VERSION: "2025-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "m",
  GEMINI_API_KEY: "k",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
} as unknown as Env;

const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: `https://${TEAM}`, aud: [AUD], exp: now() + 600, email: "staff@shop.com" });

let key: Awaited<ReturnType<typeof makeKey>>;

beforeEach(async () => {
  resetAuthCache();
  key = await makeKey();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/cdn-cgi/access/certs")) return Response.json({ keys: [key.jwk] });
      // health route's Shopify calls: fail quietly, we only care about the auth outcome
      return Response.json({ errors: [{ message: "unmocked" }] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const call = (env: Env, token?: string) =>
  app.fetch(new Request("http://x/api/health", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} }), env);

describe("requireAuth", () => {
  it("accepts a valid Access token", async () => {
    const res = await call(baseEnv, await sign(key.privateKey, good()));
    expect(res.status).toBe(200);
  });

  it("rejects a missing token", async () => {
    expect((await call(baseEnv)).status).toBe(401);
  });

  it("rejects the wrong audience", async () => {
    const t = await sign(key.privateKey, { ...good(), aud: ["someone-else"] });
    expect((await call(baseEnv, t)).status).toBe(401);
  });

  it("rejects the wrong issuer", async () => {
    const t = await sign(key.privateKey, { ...good(), iss: "https://evil.cloudflareaccess.com" });
    expect((await call(baseEnv, t)).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const t = await sign(key.privateKey, { ...good(), exp: now() - 10 });
    expect((await call(baseEnv, t)).status).toBe(401);
  });

  it("rejects a token signed by a different key", async () => {
    const other = await makeKey();
    const t = await sign(other.privateKey, good());
    expect((await call(baseEnv, t)).status).toBe(401);
  });

  it("rejects a tampered payload", async () => {
    const t = await sign(key.privateKey, good());
    const [h, , s] = t.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ ...good(), email: "attacker@x.com" }))}.${s}`;
    expect((await call(baseEnv, forged)).status).toBe(401);
  });

  it("denies everything when auth is not configured", async () => {
    const env = { ...baseEnv, ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined } as unknown as Env;
    expect((await call(env)).status).toBe(503);
  });

  it("only bypasses when DEV_AUTH_BYPASS is exactly 'true'", async () => {
    const on = { ...baseEnv, DEV_AUTH_BYPASS: "true" } as unknown as Env;
    const off = { ...baseEnv, DEV_AUTH_BYPASS: "yes" } as unknown as Env;
    expect((await call(on)).status).toBe(200);
    expect((await call(off)).status).toBe(401);
  });
});
