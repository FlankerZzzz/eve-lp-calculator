import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import check from "node:test";

const daemon = new URL("../scripts/contract-sync-daemon.mjs", import.meta.url);
const fetchMock = new URL("./contract-sync-fetch-mock.mjs", import.meta.url);

async function runOnce(database, scenario = "normal") {
  const child = spawn(process.execPath, ["--import", fetchMock.pathname, daemon.pathname], {
    env: { ...process.env, SQLITE_PATH: database, ESI_BASE_URL: "https://contract-sync.test", CONTRACT_SYNC_ONCE: "1", MOCK_CONTRACT_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const [code] = await once(child, "close");
  return { code, output };
}

check("合同同步首轮抓明细、后续复用缓存且失败保留上一轮快照", async () => {
  const directoryPath = await mkdtemp(path.join(tmpdir(), "eve-contract-sync-"));
  const database = path.join(directoryPath, "test.db");
  try {
    const setup = new DatabaseSync(database);
    setup.exec("CREATE TABLE implant_catalog(set_key TEXT PRIMARY KEY,set_name TEXT NOT NULL,is_blueprint INTEGER NOT NULL DEFAULT 0,item_type_ids TEXT NOT NULL,source_flags TEXT NOT NULL DEFAULT 'direct',generation_id TEXT,updated_at TEXT NOT NULL)");
    setup.prepare("INSERT INTO implant_catalog VALUES(?,?,?,?,?,?,?)").run("10,20,30,40,50,60", "测试套装", 0, "10,20,30,40,50,60", "direct", "test", new Date().toISOString());
    setup.prepare("INSERT INTO implant_catalog VALUES(?,?,?,?,?,?,?)").run("120,70,110,80,100,90", "旧蓝图套装", 1, "120,70,110,80,100,90", "direct", null, new Date().toISOString());
    setup.close();

    const first = await runOnce(database);
    assert.equal(first.code, 0, first.output);
    const verifyFirst = new DatabaseSync(database, { readOnly: true });
    const snapshot = verifyFirst.prepare("SELECT payload,fetched_at FROM contract_snapshots WHERE set_key=?").get("10,20,30,40,50,60");
    assert.equal(JSON.parse(snapshot.payload).length, 1);
    assert.equal(JSON.parse(snapshot.payload)[0].set_count, 10);
    assert.deepEqual({ ...verifyFirst.prepare("SELECT set_key,is_blueprint,source_flags FROM implant_catalog WHERE set_name='旧蓝图套装'").get() }, {
      set_key: "70,80,90,100,110,120", is_blueprint: 1, source_flags: "blueprint",
    });
    assert.deepEqual({ ...verifyFirst.prepare("SELECT request_count,unavailable_contracts FROM contract_sync_state WHERE id=1").get() }, { request_count: 4, unavailable_contracts: 1 });
    verifyFirst.close();

    const second = await runOnce(database);
    assert.equal(second.code, 0, second.output);
    const verifySecond = new DatabaseSync(database, { readOnly: true });
    const beforeFailure = verifySecond.prepare("SELECT payload,fetched_at FROM contract_snapshots WHERE set_key=?").get("10,20,30,40,50,60");
    assert.deepEqual({ ...verifySecond.prepare("SELECT request_count,fetched_contracts,cached_contracts,unavailable_contracts FROM contract_sync_state WHERE id=1").get() }, {
      request_count: 2, fetched_contracts: 0, cached_contracts: 2, unavailable_contracts: 1,
    });
    verifySecond.close();

    const failed = await runOnce(database, "failure");
    assert.equal(failed.code, 1);
    const verifyFailure = new DatabaseSync(database, { readOnly: true });
    const afterFailure = verifyFailure.prepare("SELECT payload,fetched_at FROM contract_snapshots WHERE set_key=?").get("10,20,30,40,50,60");
    assert.deepEqual(afterFailure, beforeFailure);
    assert.equal(verifyFailure.prepare("SELECT status FROM contract_sync_state WHERE id=1").get().status, "error");
    verifyFailure.close();
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});
