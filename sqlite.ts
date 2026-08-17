// Small D1-compatible facade backed by a persistent SQLite file for Node/Docker.
// Keeping the D1-shaped API lets existing routes and sync code run unchanged.
// @ts-ignore better-sqlite3 ships its runtime separately from TypeScript types.
import Database from "better-sqlite3";

const filename = process.env.SQLITE_PATH || ".data/eve-lp.db";
let instance: any;

function db() {
  if (!instance) {
    instance = new Database(filename);
    instance.pragma("journal_mode = WAL");
    instance.pragma("busy_timeout = 5000");
  }
  return instance;
}

class Statement {
  private values: unknown[] = [];
  constructor(private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T = Record<string, unknown>>() { return (db().prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async all<T = Record<string, unknown>>() { return { results: db().prepare(this.sql).all(...this.values) as T[], success: true }; }
  async raw<T = unknown[]>() { return db().prepare(this.sql).raw().all(...this.values) as T[]; }
  async run() { const info = db().prepare(this.sql).run(...this.values); return { results: [], success: true, meta: info }; }
}

export function getSqlite() {
  return {
    prepare(sql: string) { return new Statement(sql); },
    async batch(statements: Statement[]) {
      const transaction = db().transaction(() => statements.map(statement => statement.run()));
      transaction();
      return statements.map(() => ({ results: [], success: true }));
    },
    async exec(sql: string) { db().exec(sql); },
  } as any;
}
