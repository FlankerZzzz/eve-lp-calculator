import { ensureSchema } from "./d1";

type SyncUpdate = {
  kind: string; status: "idle" | "running" | "paused" | "complete" | "error"; phase?: string; runStartedAt?: string;
  processedDelta?: number; remaining?: number; endpoint?: string; httpStatus?: number; response?: unknown; error?: string;
  allowResume?: boolean;
};

function compact(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.slice(0, 1200);
}

export async function updateSyncJob(update: SyncUpdate) {
  const db = await ensureSchema();
  const current = await db.prepare("SELECT status, remaining FROM sync_jobs WHERE kind=?").bind(update.kind).first<{ status: string; remaining: number }>();
  if (current?.status === "paused" && update.status !== "paused" && !update.allowResume) return;
  const now = new Date().toISOString();
  const response = update.response === undefined ? null : compact(update.response);
  await db.prepare(`
    INSERT INTO sync_jobs (kind, status, phase, run_started_at, processed, remaining, last_endpoint, last_http_status, last_response, error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind) DO UPDATE SET
      status=excluded.status, phase=COALESCE(excluded.phase, sync_jobs.phase),
      run_started_at=COALESCE(excluded.run_started_at, sync_jobs.run_started_at),
      processed=CASE WHEN excluded.run_started_at IS NOT NULL AND excluded.run_started_at != sync_jobs.run_started_at THEN excluded.processed ELSE sync_jobs.processed + excluded.processed END,
      remaining=excluded.remaining, last_endpoint=COALESCE(excluded.last_endpoint, sync_jobs.last_endpoint),
      last_http_status=COALESCE(excluded.last_http_status, sync_jobs.last_http_status),
      last_response=COALESCE(excluded.last_response, sync_jobs.last_response), error=excluded.error, updated_at=excluded.updated_at
  `).bind(update.kind, update.status, update.phase ?? null, update.runStartedAt ?? null, update.processedDelta ?? 0, update.remaining ?? current?.remaining ?? 0, update.endpoint ?? null, update.httpStatus ?? null, response, update.error ?? null, now).run();
  if (update.endpoint || update.response !== undefined || update.error) {
    await db.prepare("INSERT INTO sync_events (kind, phase, endpoint, http_status, response, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(update.kind, update.phase ?? null, update.endpoint ?? null, update.httpStatus ?? null, compact(update.error ?? update.response ?? ""), now).run();
    await db.prepare("DELETE FROM sync_events WHERE id NOT IN (SELECT id FROM sync_events ORDER BY id DESC LIMIT 120)").run();
  }
}
