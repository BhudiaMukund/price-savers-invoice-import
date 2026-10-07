import type { MiddlewareHandler } from "hono";
import type { Env } from "./types";

/**
 * Cloudflare Access authentication. Access sits in front of the site (Google login, email allow-list,
 * managed in the Cloudflare dashboard, free for up to 50 users) and attaches a signed JWT to each request.
 * The Worker verifies that JWT itself, so the API still refuses requests that somehow bypass Access
 * (for example by hitting the raw workers.dev address). Denies by default when not configured.
 */

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { team: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getKeys(team: string, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.team === team && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Could not load Access signing keys (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { team, keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/** Test helper: forget cached signing keys. */
export function resetAuthCache() {
  jwksCache = null;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;
}

export interface AccessIdentity {
  email: string;
}

/** Returns the identity if the token is valid for this team + application, otherwise null. */
export async function verifyAccessJwt(token: string, team: string, aud: string): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  let keys = await getKeys(team);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Keys rotate; refresh once before giving up.
    keys = await getKeys(team, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== `https://${team}`) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;

  return { email: payload.email ?? "unknown" };
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: { user: string } }> = async (c, next) => {
  const env = c.env;

  // Local development only. Never set this in production.
  if (env.DEV_AUTH_BYPASS === "true") {
    c.set("user", "dev@local");
    return next();
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return c.json(
      {
        error:
          "Sign-in isn't set up yet, so the server is refusing every request. Testing on your computer: add DEV_AUTH_BYPASS=true to .dev.vars and restart npm run dev. Live site: fill in ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.toml and deploy again.",
        code: "auth_not_configured",
      },
      503,
    );
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "Not signed in" }, 401);

  try {
    const identity = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
    if (!identity) return c.json({ error: "Not signed in" }, 401);
    c.set("user", identity.email);
  } catch (e) {
    console.error(e);
    return c.json({ error: "Could not verify sign-in" }, 503);
  }
  return next();
};
