import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { canonicalTypeSignature, classifyContractItems, CONTRACT_CLASSIFIER_VERSION } from "./contract-sync-core.mjs";

const ESI_BASE = (process.env.ESI_BASE_URL || "https://ali-esi.evepc.163.com").replace(/\/$/, "");
const REGION_ID = 10000002;
const JITA_44_LOCATION_ID = 60003760;
const CONTRACT_INTERVAL_MS = 30 * 60 * 1000;
const DETAIL_CONCURRENCY = 12;
const DIRECTORY_CONCURRENCY = 4;
const retryDelays = [30000, 60000, 120000, 300000];
const requestRetryDelays = [1000, 2000, 5000, 10000];
const db = new DatabaseSync(process.env.SQLITE_PATH || "/data/eve-lp.db");
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=15000;");

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS implant_catalog (
      set_key TEXT PRIMARY KEY, set_name TEXT NOT NULL, is_blueprint INTEGER NOT NULL DEFAULT 0,
      item_type_ids TEXT NOT NULL, source_flags TEXT NOT NULL DEFAULT 'direct', generation_id TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contract_snapshots (
      set_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready', error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS contract_headers (
      contract_id INTEGER PRIMARY KEY, contract_type TEXT NOT NULL, price REAL NOT NULL,
      date_issued TEXT NOT NULL, date_expired TEXT NOT NULL, start_location_id INTEGER NOT NULL,
      end_location_id INTEGER, volume REAL NOT NULL DEFAULT 0, last_seen_generation TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS contract_item_cache (
      contract_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, classifier_version INTEGER NOT NULL,
      status TEXT NOT NULL, set_signature TEXT, set_count INTEGER, fetched_at TEXT NOT NULL, error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS contract_sync_state (
      id INTEGER PRIMARY KEY CHECK (id=1), status TEXT NOT NULL DEFAULT 'idle', locked_until TEXT,
      started_at TEXT, finished_at TEXT, last_success_at TEXT, heartbeat_at TEXT, generation_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0, directory_contracts INTEGER NOT NULL DEFAULT 0,
      candidate_contracts INTEGER NOT NULL DEFAULT 0, cached_contracts INTEGER NOT NULL DEFAULT 0,
      fetched_contracts INTEGER NOT NULL DEFAULT 0, unavailable_contracts INTEGER NOT NULL DEFAULT 0, matched_contracts INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, error_message TEXT
    );
    INSERT OR IGNORE INTO contract_sync_state (id,status,retry_count) VALUES (1,'idle',0);
    CREATE INDEX IF NOT EXISTS idx_contract_item_signature ON contract_item_cache (set_signature,status);
    CREATE INDEX IF NOT EXISTS idx_contract_headers_active ON contract_headers (active,contract_type,price);
  `);
  ensureColumn("implant_catalog", "source_flags", "TEXT NOT NULL DEFAULT 'direct'");
  ensureColumn("implant_catalog", "generation_id", "TEXT");
  const stateColumns = [
    ["heartbeat_at", "TEXT"], ["generation_id", "TEXT"],
    ["directory_contracts", "INTEGER NOT NULL DEFAULT 0"], ["candidate_contracts", "INTEGER NOT NULL DEFAULT 0"],
    ["cached_contracts", "INTEGER NOT NULL DEFAULT 0"], ["fetched_contracts", "INTEGER NOT NULL DEFAULT 0"],
    ["unavailable_contracts", "INTEGER NOT NULL DEFAULT 0"], ["matched_contracts", "INTEGER NOT NULL DEFAULT 0"], ["request_count", "INTEGER NOT NULL DEFAULT 0"],
    ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, definition] of stateColumns) ensureColumn("contract_sync_state", name, definition);
}

ensureSchema();

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const retryableStatus = status => status === 420 || status === 429 || status >= 500;

class ContractHttpError extends Error {
  constructor(status, path, detail = "") {
    super(`ESI ${status} ${path}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.path = path;
  }
}

class EmptyContractResponseError extends Error {
  constructor(path) {
    super(`ESI 200 空合同明细 ${path}`);
    this.path = path;
  }
}

async function getJson(path, metrics) {
  let lastError;
  for (let attempt = 0; attempt <= requestRetryDelays.length; attempt += 1) {
    metrics.requestCount += 1;
    try {
      const response = await fetch(`${ESI_BASE}/latest${path}`, {
        headers: { accept: "application/json", "user-agent": "Chenxi-LP-Calculator/contract-index" },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) {
        const text = await response.text();
        if (!text.trim()) throw new EmptyContractResponseError(path);
        return { value: JSON.parse(text), pages: Number(response.headers.get("x-pages") || 1) };
      }
      const detail = (await response.text()).slice(0, 180);
      const error = new ContractHttpError(response.status, path, detail);
      if (!retryableStatus(response.status) || attempt === requestRetryDelays.length) throw error;
      lastError = error;
      const retryAfter = Math.min(Number(response.headers.get("retry-after") || 0) * 1000, 30000);
      await sleep(Math.max(requestRetryDelays[attempt], retryAfter));
    } catch (error) {
      lastError = error;
      if (error instanceof EmptyContractResponseError) throw error;
      if (error instanceof ContractHttpError && !retryableStatus(error.status)) throw error;
      if (attempt === requestRetryDelays.length) break;
      await sleep(requestRetryDelays[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`合同接口读取失败 ${path}`);
}

function heartbeat(detail = null) {
  db.prepare("UPDATE contract_sync_state SET heartbeat_at=?,error_message=COALESCE(?,error_message) WHERE id=1").run(new Date().toISOString(), detail);
}

async function sleepWithHeartbeat(milliseconds) {
  let remaining = milliseconds;
  while (remaining > 0) {
    const chunk = Math.min(30000, remaining);
    await sleep(chunk);
    remaining -= chunk;
    heartbeat();
  }
}

function migrateCatalogKeys() {
  const rows = db.prepare("SELECT set_key,set_name,is_blueprint,item_type_ids,source_flags,generation_id,updated_at FROM implant_catalog").all();
  const definitions = new Map();
  let changed = false;
  for (const row of rows) {
    const typeIds = String(row.item_type_ids).split(",").map(Number).filter(Number.isInteger);
    if (new Set(typeIds).size !== 6) continue;
    const signature = canonicalTypeSignature(typeIds);
    if (signature !== row.set_key || signature !== row.item_type_ids || !row.generation_id) changed = true;
    // Existing V1.8 rows gain source_flags through an ALTER default. Until a
    // generation is present, is_blueprint remains the authoritative legacy value.
    const sources = row.generation_id
      ? new Set(String(row.source_flags || "").split(",").filter(Boolean))
      : new Set([row.is_blueprint ? "blueprint" : "direct"]);
    const previous = definitions.get(signature);
    if (previous) sources.forEach(source => previous.sources.add(source));
    else definitions.set(signature, { ...row, set_key: signature, item_type_ids: signature, sources });
  }
  if (!changed) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM implant_catalog").run();
    const insert = db.prepare("INSERT INTO implant_catalog(set_key,set_name,is_blueprint,item_type_ids,source_flags,generation_id,updated_at) VALUES(?,?,?,?,?,?,?)");
    for (const definition of definitions.values()) {
      const flags = [...definition.sources].sort().join(",");
      insert.run(definition.set_key, definition.set_name, definition.sources.has("blueprint") ? 1 : 0, definition.item_type_ids, flags, definition.generation_id || "v1.9-migration", definition.updated_at);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function claim(generationId) {
  const now = new Date();
  const staleHeartbeat = new Date(Date.now() - 2 * 60 * 1000);
  const lockUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare("SELECT status,locked_until,heartbeat_at FROM contract_sync_state WHERE id=1").get();
    const liveOwner = state?.status === "running" && state.locked_until && new Date(state.locked_until) > now && state.heartbeat_at && new Date(state.heartbeat_at) > staleHeartbeat;
    if (liveOwner) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("UPDATE contract_sync_state SET status='running',locked_until=?,started_at=?,heartbeat_at=?,generation_id=?,error_message=NULL WHERE id=1")
      .run(lockUntil, now.toISOString(), now.toISOString(), generationId);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function fetchDirectory(metrics) {
  const first = await getJson(`/contracts/public/${REGION_ID}/?page=1`, metrics);
  if (!Number.isInteger(first.pages) || first.pages < 1 || first.pages > 100) throw new Error(`ESI 返回异常合同页数 ${first.pages}`);
  const pages = [first.value];
  for (let page = 2; page <= first.pages; page += DIRECTORY_CONCURRENCY) {
    const numbers = Array.from({ length: Math.min(DIRECTORY_CONCURRENCY, first.pages - page + 1) }, (_, index) => page + index);
    const results = await Promise.all(numbers.map(number => getJson(`/contracts/public/${REGION_ID}/?page=${number}`, metrics)));
    pages.push(...results.map(result => result.value));
    heartbeat();
  }
  return pages.flat();
}

function saveItemCache(contractId, items, classification, fetchedAt) {
  db.prepare(`INSERT INTO contract_item_cache(contract_id,payload,classifier_version,status,set_signature,set_count,fetched_at,error_message)
    VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(contract_id) DO UPDATE SET payload=excluded.payload,classifier_version=excluded.classifier_version,
    status=excluded.status,set_signature=excluded.set_signature,set_count=excluded.set_count,fetched_at=excluded.fetched_at,error_message=NULL`)
    .run(contractId, JSON.stringify(items), CONTRACT_CLASSIFIER_VERSION, "ready", classification.valid ? classification.signature : null, classification.valid ? classification.setCount : null, fetchedAt);
}

function reclassifyCachedRows() {
  const rows = db.prepare("SELECT contract_id,payload FROM contract_item_cache WHERE classifier_version!=?").all(CONTRACT_CLASSIFIER_VERSION);
  for (const row of rows) {
    try {
      const items = JSON.parse(row.payload);
      saveItemCache(row.contract_id, items, classifyContractItems(items), new Date().toISOString());
    } catch (error) {
      db.prepare("UPDATE contract_item_cache SET classifier_version=?,status='error',error_message=? WHERE contract_id=?")
        .run(CONTRACT_CLASSIFIER_VERSION, error instanceof Error ? error.message : String(error), row.contract_id);
    }
  }
}

async function fetchMissingDetails(candidates, metrics) {
  reclassifyCachedRows();
  const cachedRows = db.prepare("SELECT contract_id,status,classifier_version FROM contract_item_cache").all();
  const cached = new Map(cachedRows.map(row => [row.contract_id, row]));
  const pending = candidates.filter(contract => cached.get(contract.contract_id)?.status !== "ready");
  metrics.cachedContracts = candidates.length - pending.length;
  const failures = [];
  const gone = new Set();
  const unavailable = new Set();
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const contract = pending[cursor++];
      try {
        const { value: items } = await getJson(`/contracts/public/items/${contract.contract_id}/`, metrics);
        saveItemCache(contract.contract_id, items, classifyContractItems(items), new Date().toISOString());
        metrics.fetchedContracts += 1;
      } catch (error) {
        if (error instanceof ContractHttpError && error.status === 404) {
          gone.add(contract.contract_id);
          continue;
        }
        if (error instanceof EmptyContractResponseError) {
          unavailable.add(contract.contract_id);
          db.prepare(`INSERT INTO contract_item_cache(contract_id,payload,classifier_version,status,fetched_at,error_message)
            VALUES(?, '[]', ?, 'empty', ?, ?) ON CONFLICT(contract_id) DO UPDATE SET status='empty',fetched_at=excluded.fetched_at,error_message=excluded.error_message`)
            .run(contract.contract_id, CONTRACT_CLASSIFIER_VERSION, new Date().toISOString(), error.message);
          continue;
        }
        failures.push({ contractId: contract.contract_id, error: error instanceof Error ? error.message : String(error) });
        db.prepare(`INSERT INTO contract_item_cache(contract_id,payload,classifier_version,status,fetched_at,error_message)
          VALUES(?, '[]', ?, 'error', ?, ?) ON CONFLICT(contract_id) DO UPDATE SET status='error',fetched_at=excluded.fetched_at,error_message=excluded.error_message`)
          .run(contract.contract_id, CONTRACT_CLASSIFIER_VERSION, new Date().toISOString(), failures.at(-1).error);
      }
      if ((metrics.fetchedContracts + failures.length) % 24 === 0) heartbeat();
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, pending.length) }, () => worker()));
  metrics.unavailableContracts = unavailable.size;
  return { failures, gone, unavailable };
}

function contractLocation(contract) {
  if (contract.start_location_id === JITA_44_LOCATION_ID) {
    return { solarSystemId: 30000142, name: "吉他 4 - 卫星 4 - 加达里海军组装车间" };
  }
  return { solarSystemId: null, name: `空间站 #${contract.start_location_id}` };
}

function publish({ directory, candidates, generationId, metrics, startedAt }) {
  const now = new Date();
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 40 * 60 * 1000).toISOString();
  const retentionCutoff = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
  const definitions = db.prepare("SELECT set_key FROM implant_catalog").all();
  if (!definitions.length) throw new Error("脑插套装签名目录为空，请先完成全量目录同步");
  const payloads = new Map(definitions.map(row => [row.set_key, []]));
  const cacheRows = db.prepare("SELECT contract_id,status,set_signature,set_count FROM contract_item_cache WHERE status='ready' AND set_signature IS NOT NULL").all();
  const cache = new Map(cacheRows.map(row => [row.contract_id, row]));
  for (const contract of candidates) {
    const item = cache.get(contract.contract_id);
    if (!item || !payloads.has(item.set_signature) || !item.set_count) continue;
    const location = contractLocation(contract);
    payloads.get(item.set_signature).push({
      contract_id: contract.contract_id,
      date_issued: contract.date_issued,
      date_expired: contract.date_expired,
      price: contract.price,
      unit_price: contract.price / item.set_count,
      set_count: item.set_count,
      start_location_id: contract.start_location_id,
      end_location_id: contract.end_location_id,
      solar_system_id: location.solarSystemId,
      location_name: location.name,
    });
  }
  for (const contracts of payloads.values()) contracts.sort((a, b) => a.unit_price - b.unit_price || b.date_issued.localeCompare(a.date_issued));
  metrics.matchedContracts = [...payloads.values()].reduce((sum, contracts) => sum + contracts.length, 0);
  metrics.durationMs = Date.now() - startedAt;

  const upsertHeader = db.prepare(`INSERT INTO contract_headers(contract_id,contract_type,price,date_issued,date_expired,start_location_id,end_location_id,volume,last_seen_generation,last_seen_at,active)
    VALUES(?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(contract_id) DO UPDATE SET contract_type=excluded.contract_type,price=excluded.price,date_issued=excluded.date_issued,
    date_expired=excluded.date_expired,start_location_id=excluded.start_location_id,end_location_id=excluded.end_location_id,volume=excluded.volume,
    last_seen_generation=excluded.last_seen_generation,last_seen_at=excluded.last_seen_at,active=1`);
  const insertSnapshot = db.prepare("INSERT INTO contract_snapshots(set_key,payload,fetched_at,expires_at,status,error_message) VALUES(?,?,?,?, 'ready',NULL)");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE contract_headers SET active=0").run();
    for (const contract of directory) upsertHeader.run(
      contract.contract_id, contract.type, Number(contract.price || 0), contract.date_issued, contract.date_expired,
      contract.start_location_id, contract.end_location_id ?? null, Number(contract.volume || 0), generationId, fetchedAt,
    );
    db.prepare("DELETE FROM contract_item_cache WHERE contract_id IN (SELECT contract_id FROM contract_headers WHERE active=0 AND last_seen_at<?)").run(retentionCutoff);
    db.prepare("DELETE FROM contract_headers WHERE active=0 AND last_seen_at<?").run(retentionCutoff);
    db.prepare("DELETE FROM contract_snapshots").run();
    for (const [signature, contracts] of payloads) insertSnapshot.run(signature, JSON.stringify(contracts), fetchedAt, expiresAt);
    db.prepare(`UPDATE contract_sync_state SET status='idle',locked_until=NULL,finished_at=?,last_success_at=?,heartbeat_at=?,generation_id=?,retry_count=0,
      directory_contracts=?,candidate_contracts=?,cached_contracts=?,fetched_contracts=?,unavailable_contracts=?,matched_contracts=?,request_count=?,duration_ms=?,error_message=NULL WHERE id=1`)
      .run(fetchedAt, fetchedAt, fetchedAt, generationId, directory.length, candidates.length, metrics.cachedContracts, metrics.fetchedContracts,
        metrics.unavailableContracts, metrics.matchedContracts, metrics.requestCount, metrics.durationMs);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function markFailure(error, generationId, metrics, startedAt) {
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(`UPDATE contract_sync_state SET status='error',locked_until=NULL,finished_at=?,heartbeat_at=?,generation_id=?,retry_count=retry_count+1,
    directory_contracts=?,candidate_contracts=?,cached_contracts=?,fetched_contracts=?,unavailable_contracts=?,request_count=?,duration_ms=?,error_message=? WHERE id=1`)
    .run(now, now, generationId, metrics.directoryContracts, metrics.candidateContracts, metrics.cachedContracts,
      metrics.fetchedContracts, metrics.unavailableContracts, metrics.requestCount, Date.now() - startedAt, message);
}

async function runRound() {
  const startedAt = Date.now();
  const generationId = new Date(startedAt).toISOString();
  const metrics = { requestCount: 0, directoryContracts: 0, candidateContracts: 0, cachedContracts: 0, fetchedContracts: 0, unavailableContracts: 0, matchedContracts: 0, durationMs: 0 };
  if (!claim(generationId)) return { skipped: true };
  try {
    const directory = await fetchDirectory(metrics);
    metrics.directoryContracts = directory.length;
    const candidates = directory.filter(contract => contract.type === "item_exchange" && Number(contract.price) > 0);
    metrics.candidateContracts = candidates.length;
    const { failures, gone, unavailable } = await fetchMissingDetails(candidates, metrics);
    if (failures.length) throw new Error(`${failures.length} 份新合同明细读取失败；保留上一轮快照。首个错误：${failures[0].error}`);
    const activeDirectory = directory.filter(contract => !gone.has(contract.contract_id));
    const activeCandidates = candidates.filter(contract => !gone.has(contract.contract_id) && !unavailable.has(contract.contract_id));
    publish({ directory: activeDirectory, candidates: activeCandidates, generationId, metrics, startedAt });
    console.log(`[contract-sync] 增量快照完成：目录 ${activeDirectory.length}，候选 ${activeCandidates.length}，复用 ${metrics.cachedContracts}，新增明细 ${metrics.fetchedContracts}，空明细 ${metrics.unavailableContracts}，匹配 ${metrics.matchedContracts}，请求 ${metrics.requestCount}，耗时 ${Math.round(metrics.durationMs / 1000)} 秒`);
    return { skipped: false, ok: true, durationMs: metrics.durationMs };
  } catch (error) {
    markFailure(error, generationId, metrics, startedAt);
    throw error;
  }
}

export async function runContractSyncRound() {
  migrateCatalogKeys();
  return runRound();
}

export async function runContractSyncDaemon() {
  migrateCatalogKeys();
  console.log("[contract-sync] 任务模块启动：合同目录单次抓取、明细增量缓存、签名匹配，周期 30 分钟");
  let failures = 0;
  while (true) {
    const cycleStartedAt = Date.now();
    try {
      const result = await runRound();
      if (result.skipped) {
        // Do not refresh another process' running lock. Its heartbeat must be
        // allowed to expire so a restarted singleton can safely reclaim it.
        await sleep(30000);
        continue;
      }
      failures = 0;
      await sleepWithHeartbeat(Math.max(1000, CONTRACT_INTERVAL_MS - (Date.now() - cycleStartedAt)));
    } catch (error) {
      failures += 1;
      const wait = retryDelays[Math.min(failures - 1, retryDelays.length - 1)];
      console.error(`[contract-sync] ${error instanceof Error ? error.message : String(error)}；${wait / 1000} 秒后重试`);
      await sleepWithHeartbeat(wait);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.CONTRACT_SYNC_ONCE === "1") {
    try {
      await runContractSyncRound();
    } catch (error) {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    void runContractSyncDaemon();
  }
}
