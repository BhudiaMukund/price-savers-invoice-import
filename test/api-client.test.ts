// @ts-nocheck -- Node-only test of the browser's API client.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, SessionExpired } from "../public/js/api.js";

const json = (body: unknown, status = 200) => ({ type: "basic", status, ok: status < 400, text: async () => JSON.stringify(body) });
const html = (body: string, status: number) => ({ type: "basic", status, ok: false, text: async () => body });
const redirect = () => ({ type: "opaqueredirect", status: 0, ok: false, text: async () => "" });
const CF_1102 = "<!DOCTYPE html><html><head><title>Worker exceeded resource limits | Cloudflare</title></head><body>Error 1102</body></html>";
const ACCESS_LOGIN = '<!DOCTYPE html><html><head><title>Sign in</title></head><body><a href="https://shop.cloudflareaccess.com/cdn-cgi/access/login">Sign in</a></body></html>';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("API client: what an error response means", () => {
  it("a Cloudflare error page is a busy server, not an expired sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(CF_1102, 503)));
    const err = await api.createCatalogue("X", []).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(SessionExpired);
    expect(err.message).toMatch(/busy/i);
    expect(err.body.retryable).toBe(true);
  });

  it("a redirect to the login page is an expired sign-in once a second look agrees", async () => {
    const f = vi.fn(async () => redirect());
    vi.stubGlobal("fetch", f);
    await expect(api.suppliers()).rejects.toBeInstanceOf(SessionExpired);
    expect(f).toHaveBeenCalledTimes(2); // the call, then /api/health
  });

  it("the login page itself counts too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(ACCESS_LOGIN, 200)));
    await expect(api.suppliers()).rejects.toBeInstanceOf(SessionExpired);
  });

  it("a stray redirect while the sign-in is fine is only a hiccup", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/api/health") ? json({ ok: true }) : n++ === 0 ? redirect() : json({ suppliers: [] }))));
    const err = await api.suppliers().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(SessionExpired);
  });

  it("a 403 from the server with a reason is shown as that reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Only the people listed in ADMIN_EMAILS can change settings." }, 403)));
    const err = await api.saveSettings({}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/ADMIN_EMAILS/);
  });

  it("the server's own 'Not signed in' is an expired sign-in when /api/health says so too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Not signed in" }, 401)));
    await expect(api.suppliers()).rejects.toBeInstanceOf(SessionExpired);
  });
});

describe("API client: trying again", () => {
  it("repeatable calls (photo checks, uploads) try again when the server is busy", async () => {
    vi.useFakeTimers();
    let n = 0;
    const f = vi.fn(async () => (n++ < 2 ? html(CF_1102, 503) : json({ thumbs: {} })));
    vi.stubGlobal("fetch", f);
    const p = api.photoThumbs(["gid://x/1"]);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toEqual({ thumbs: {} });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("saving products is not repeated on its own (it would add them twice)", async () => {
    const f = vi.fn(async () => html(CF_1102, 503));
    vi.stubGlobal("fetch", f);
    await expect(api.catalogueItemsAdd("C1", [])).rejects.toBeInstanceOf(ApiError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("gives up after a few tries with a plain message", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => html(CF_1102, 503));
    vi.stubGlobal("fetch", f);
    const p = api.photoThumbs(["a"]).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20000);
    expect((await p).message).toMatch(/busy/i);
    expect(f).toHaveBeenCalledTimes(4);
  });
});
