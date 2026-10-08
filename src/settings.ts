/**
 * Shared settings, changed on the Settings page and stored in D1. Everyone using the site gets the same
 * values. If ADMIN_EMAILS is set, only those people can change them (everyone can still see them).
 */
import type { Env } from "./types";
import { ensureSchema, StoreError, type Db } from "./store";

export interface Settings {
  /** Tag new products with import-<ID> and run-<code>. */
  importTags: boolean;
  /** Tick catalogue photos for new products by default. */
  cataloguePhotos: boolean;
  /** Add the catalogue's description to new products by default. */
  catalogueDescriptions: boolean;
}

export function defaultSettings(env: Env): Settings {
  return { importTags: env.IMPORT_TAGS !== "false", cataloguePhotos: true, catalogueDescriptions: true };
}

const KEYS = ["importTags", "cataloguePhotos", "catalogueDescriptions"] as const;

export function admins(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Who can change settings and delete suppliers: anyone, unless ADMIN_EMAILS lists particular people. */
export function canManage(env: Env, user: string): boolean {
  const list = admins(env);
  return !list.length || list.includes(user.toLowerCase()) || (user === "dev@local" && env.DEV_AUTH_BYPASS === "true");
}

export async function readSettings(env: Env): Promise<Settings> {
  const out = defaultSettings(env);
  if (!env.DB) return out;
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all<{ key: string; value: string }>();
  for (const r of results) {
    if (!(KEYS as readonly string[]).includes(r.key)) continue;
    try {
      const v = JSON.parse(r.value);
      if (typeof v === "boolean") (out as unknown as Record<string, boolean>)[r.key] = v;
    } catch {
      /* ignore a broken value: the default stands */
    }
  }
  return out;
}

export async function writeSettings(db: Db, changes: Record<string, unknown>, user: string): Promise<void> {
  await ensureSchema(db);
  const t = new Date().toISOString();
  const stmts = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!(KEYS as readonly string[]).includes(key)) throw new StoreError(`Unknown setting "${key}".`, 400);
    if (typeof value !== "boolean") throw new StoreError(`"${key}" must be on or off.`, 400);
    stmts.push(
      db
        .prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .bind(key, JSON.stringify(value), user, t),
    );
  }
  if (stmts.length) await db.batch(stmts);
}
