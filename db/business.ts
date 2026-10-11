import { DatabaseSync } from 'node:sqlite';

type BusinessStatement = {
  bind(...values: unknown[]): BusinessStatement;
  first<T = Record<string,unknown>>(): Promise<T | null>;
  all<T = Record<string,unknown>>(): Promise<{results:T[];success:boolean}>;
};
export type BusinessDatabase = {prepare(sql:string):BusinessStatement};

let reader: DatabaseSync | null = null;

export async function ensureBusinessSchema(): Promise<BusinessDatabase> {
  if (!reader) {
    const path = process.env.V2_SQLITE_PATH;
    if (!path) throw new Error('V2_SQLITE_PATH must be configured');
    reader = new DatabaseSync(path, { readOnly: true });
    reader.exec('PRAGMA busy_timeout=10000; PRAGMA query_only=ON;');
  }
  const ready = reader.prepare("SELECT value FROM runtime_state WHERE key='business_ready'").get() as { value?: string } | undefined;
  if (JSON.parse(ready?.value || 'false') !== true) throw new Error('V2 data has not passed production readiness validation');
  const db = reader;
  class ReadStatement {
    private values: unknown[] = [];
    constructor(private sql: string) {}
    bind(...values: unknown[]) { this.values = values; return this; }
    async first<T>() { return (db.prepare(this.sql).get(...this.values as never[]) as T | undefined) ?? null; }
    async all<T>() { return { results: db.prepare(this.sql).all(...this.values as never[]) as T[], success: true }; }
    async run() { throw new Error('Business V2 connection is read-only'); }
  }
  return { prepare: (sql: string) => new ReadStatement(sql) };
}
