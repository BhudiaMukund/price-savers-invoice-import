// @ts-nocheck -- Node-only test helper; the project's types are for Cloudflare Workers.
// A D1-shaped adapter over Node's built-in SQLite, so the real SQL in src/store.ts runs in tests and demo mode.
import { createRequire } from "node:module";
import type { Db, Stmt } from "../src/store";

// Loaded at runtime: the bundler used by tests doesn't know the newer node:sqlite module.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function sqliteDb(file = ":memory:"): Db {
  const db = new DatabaseSync(file);
  const make = (sql: string, args: unknown[] = []): Stmt => ({
    bind: (...values: unknown[]) => make(sql, values),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) as T) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => {
      const r = db.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => make(sql),
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
