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
    setup.exec("CREATE TABLE corporations(corporation_id INTEGER PRIMARY KEY,faction_id INTEGER,name TEXT NOT NULL)");
    setup.exec("CREATE TABLE lp_offers(corporation_id INTEGER NOT NULL,offer_id INTEGER NOT NULL,type_id INTEGER NOT NULL,quantity INTEGER NOT NULL,lp_cost INTEGER NOT NULL,isk_cost REAL NOT NULL,ak_cost INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(corporation_id,offer_id))");
    setup.exec("CREATE TABLE blueprint_recipes(blueprint_type_id INTEGER PRIMARY KEY,product_type_id INTEGER NOT NULL,product_quantity INTEGER NOT NULL,checked_at TEXT NOT NULL)");
    setup.prepare("INSERT INTO corporations VALUES(?,?,?)").run(1, 500001, "正常军团");
    setup.prepare("INSERT INTO corporations VALUES(?,?,?)").run(1000283, 500001, "涂装军团");
    setup.prepare("INSERT INTO lp_offers VALUES(?,?,?,?,?,?,?)").run(1, 1, 700, 1, 1000, 0, 0);
    setup.prepare("INSERT INTO lp_offers VALUES(?,?,?,?,?,?,?)").run(1000283, 2, 701, 1, 1000, 0, 0);
    setup.prepare("INSERT INTO lp_offers VALUES(?,?,?,?,?,?,?)").run(1, 3, 702, 1, 1000, 0, 1);
    setup.prepare("INSERT INTO lp_offers VALUES(?,?,?,?,?,?,?)").run(1, 4, 701, 1, 1000, 0, 0);
    setup.prepare("INSERT INTO lp_offers VALUES(?,?,?,?,?,?,?)").run(1000283, 5, 703, 1, 1000, 0, 0);
    setup.prepare("INSERT INTO blueprint_recipes VALUES(?,?,?,?)").run(700, 701, 1, new Date().toISOString());
    setup.prepare("INSERT INTO blueprint_recipes VALUES(?,?,?,?)").run(701, 702, 1, new Date().toISOString());
    setup.prepare("INSERT INTO blueprint_recipes VALUES(?,?,?,?)").run(702, 703, 1, new Date().toISOString());
    setup.prepare("INSERT INTO blueprint_recipes VALUES(?,?,?,?)").run(703, 704, 1, new Date().toISOString());
    setup.close();

    const first = await runOnce(database);
    assert.equal(first.code, 0, first.output);
    const verifyFirst = new DatabaseSync(database, { readOnly: true });
    const snapshot = verifyFirst.prepare("SELECT payload,fetched_at FROM contract_snapshots WHERE set_key=?").get("10,20,30,40,50,60");
    assert.equal(JSON.parse(snapshot.payload).length, 1);
    assert.equal(JSON.parse(snapshot.payload)[0].set_count, 10);
    const blueprintSnapshot = verifyFirst.prepare("SELECT payload FROM contract_snapshots WHERE set_key=?").get("blueprint-copy:700");
    assert.deepEqual(JSON.parse(blueprintSnapshot.payload), [{
      contract_id: 104, date_issued: "2026-08-29T00:00:00Z", date_expired: "2026-09-29T00:00:00Z", price: 24_000_000,
      unit_price: 12_000_000, price_per_run: 2_400_000, copy_count: 2, runs: 5, material_efficiency: 10, time_efficiency: 20,
      start_location_id: 60003760, end_location_id: 60003760, solar_system_id: 30000142, location_name: "吉他 4 - 卫星 4 - 加达里海军组装车间",
    }]);
    assert.equal(JSON.parse(verifyFirst.prepare("SELECT payload FROM contract_snapshots WHERE set_key=?").get("blueprint-copy:701").payload).length, 0);
    assert.equal(verifyFirst.prepare("SELECT 1 FROM contract_snapshots WHERE set_key=?").get("blueprint-copy:702"), undefined);
    assert.equal(verifyFirst.prepare("SELECT 1 FROM contract_snapshots WHERE set_key=?").get("blueprint-copy:703"), undefined);
    assert.deepEqual({ ...verifyFirst.prepare("SELECT set_key,is_blueprint,source_flags FROM implant_catalog WHERE set_name='旧蓝图套装'").get() }, {
      set_key: "70,80,90,100,110,120", is_blueprint: 1, source_flags: "blueprint",
    });
    assert.deepEqual({ ...verifyFirst.prepare("SELECT request_count,unavailable_contracts FROM contract_sync_state WHERE id=1").get() }, { request_count: 5, unavailable_contracts: 1 });
    verifyFirst.close();

    const second = await runOnce(database);
    assert.equal(second.code, 0, second.output);
    const verifySecond = new DatabaseSync(database, { readOnly: true });
    const beforeFailure = verifySecond.prepare("SELECT payload,fetched_at FROM contract_snapshots WHERE set_key=?").get("10,20,30,40,50,60");
    assert.deepEqual({ ...verifySecond.prepare("SELECT request_count,fetched_contracts,cached_contracts,unavailable_contracts FROM contract_sync_state WHERE id=1").get() }, {
      request_count: 2, fetched_contracts: 0, cached_contracts: 3, unavailable_contracts: 1,
    });
    verifySecond.close();

    const sabotage = new DatabaseSync(database);
    sabotage.exec("CREATE TRIGGER reject_blueprint_snapshot BEFORE INSERT ON contract_snapshots WHEN NEW.set_key='blueprint-copy:700' BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    sabotage.close();
    const failedPublish = await runOnce(database);
    assert.equal(failedPublish.code, 1);
    const verifyPublishFailure = new DatabaseSync(database, { readOnly: true });
    assert.deepEqual(verifyPublishFailure.prepare("SELECT payload,fetched_at FROM contract_snapshots WHERE set_key=?").get("10,20,30,40,50,60"), beforeFailure);
    assert.deepEqual(verifyPublishFailure.prepare("SELECT payload FROM contract_snapshots WHERE set_key=?").get("blueprint-copy:700"), blueprintSnapshot);
    verifyPublishFailure.close();

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
