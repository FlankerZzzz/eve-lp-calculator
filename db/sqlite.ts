// Small D1-compatible facade backed by a persistent SQLite file for Node/Docker.
// Keeping the D1-shaped API lets existing routes and sync code run unchanged.
// Node 22 includes a synchronous SQLite driver, avoiding native addon loading
// inside Vinext's SSR module runner.
import { DatabaseSync } from "node:sqlite";

const filename = process.env.SQLITE_PATH || ".data/eve-lp.db";
let instance: DatabaseSync | null = null;

function db() {
  if (!instance) {
    instance = new DatabaseSync(filename);
    instance.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536;");
  }
  return instance;
}

class Statement {
  private values: unknown[] = [];
  constructor(private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T = Record<string, unknown>>() { return (db().prepare(this.sql).get(...this.values as never[]) as T | undefined) ?? null; }
  async all<T = Record<string, unknown>>() { return { results: db().prepare(this.sql).all(...this.values as never[]) as T[], success: true }; }
  async raw<T = unknown[]>() { const statement = db().prepare(this.sql) as unknown as { setReturnArrays(value: boolean): { all(...values: never[]): T[] } }; return statement.setReturnArrays(true).all(...this.values as never[]); }
  async run() { const info = db().prepare(this.sql).run(...this.values as never[]); return { results: [], success: true, meta: info }; }
}

export function getSqlite(): D1Database {
  return {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: Statement[]) {
      if (!statements.length) return [];
      const sqlite = db();
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of statements) await statement.run();
        sqlite.exec("COMMIT");
      } catch (error) {
        try { sqlite.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
      return statements.map(() => ({ results: [], success: true }));
    },
    async exec(sql: string) { db().exec(sql); },
  } as unknown as D1Database;
}
