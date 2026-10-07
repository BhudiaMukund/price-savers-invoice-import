import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { modelFor } from "../src/extract";
import type { Env } from "../src/types";

const env = {
  SHOPIFY_STORE_DOMAIN: "t.myshopify.com",
  SHOPIFY_API_VERSION: "2026-07",
  SHOPIFY_ADMIN_TOKEN: "t",
  AI_PROVIDER: "gemini",
  AI_MODEL: "main-model",
  AI_FALLBACK_MODEL: "backup-model",
  GEMINI_API_KEY: "k",
  DEV_AUTH_BYPASS: "true",
} as unknown as Env;

const calls: string[] = [];
function mock(geminiStatusFor: (url: string) => number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("generativelanguage")) {
        calls.push(u);
        const status = geminiStatusFor(u);
        if (status !== 200) return new Response("busy", { status });
        return Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ supplierName: null, invoiceNumber: null, items: [{ invoiceTitle: "A", title: "A", supplierCode: null, barcode: null }] }) }] } }],
        });
      }
      return Response.json({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    }),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

const extract = (attempt: number) =>
  app.fetch(
    new Request("http://x/api/extract", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-attempt": String(attempt) },
      body: JSON.stringify({ filename: "a.csv", text: "a,b" }),
    }),
    env,
  );

describe("when Google's AI is overloaded", () => {
  it("says it's worth retrying, then uses the backup model on the second try", async () => {
    mock((u) => (u.includes("main-model") ? 503 : 200));
    const first = await extract(1);
    expect(first.status).toBe(422);
    const body: any = await first.json();
    expect(body.retryable).toBe(true);
    expect(body.error).toMatch(/overloaded/);

    const second = await extract(2);
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).model).toBe("backup-model");
    expect(calls[1]).toContain("backup-model");
  });

  it("doesn't suggest retrying a refused key", async () => {
    mock(() => 403);
    const body: any = await (await extract(1)).json();
    expect(body.retryable).toBe(false);
    expect(body.error).toMatch(/GEMINI_API_KEY/);
  });

  it("keeps the main model when no backup is set", () => {
    expect(modelFor({ ...env, AI_FALLBACK_MODEL: "" } as Env, 3)).toBe("main-model");
    expect(modelFor(env, 1)).toBe("main-model");
    expect(modelFor(env, 2)).toBe("backup-model");
  });
});
