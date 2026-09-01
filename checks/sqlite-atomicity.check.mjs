import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("SQLite D1 兼容层在发布批次失败时完整回滚", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eve-lp-atomic-"));
  const previousPath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(directory, "atomic.db");
  try {
    const { getSqlite } = await import(`../db/sqlite.ts?atomic=${Date.now()}`);
    const db = getSqlite();
    await db.exec("CREATE TABLE live (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO live VALUES (1, 'complete');");
    await assert.rejects(db.batch([
      db.prepare("DELETE FROM live"),
      db.prepare("INSERT INTO live VALUES (1, 'partial')"),
      db.prepare("INSERT INTO live VALUES (1, 'duplicate')"),
    ]));
    const row = await db.prepare("SELECT value FROM live WHERE id=1").first();
    assert.equal(row?.value, "complete");
  } finally {
    if (previousPath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
