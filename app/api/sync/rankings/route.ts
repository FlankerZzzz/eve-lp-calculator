import { ensureSchema } from "../../../../db/d1";
import { updateSyncJob } from "../../../../db/sync-state";

const RANKING_HOURS = [9, 15, 18, 21];
const chinaParts = (date = new Date()) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).formatToParts(date).filter(part => ["year", "month", "day", "hour", "minute"].includes(part.type)).map(part => [part.type, Number(part.value)]));
const chinaDate = () => {
  const parts = chinaParts();
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};
const dueRankingSlot = (date = new Date()) => {
  const parts = chinaParts(date);
  const hour = RANKING_HOURS.filter(candidate => candidate <= parts.hour).at(-1);
  if (hour === undefined) return null;
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`;
};

export async function GET() {
  const db = await ensureSchema();
  const row = await db.prepare("SELECT snapshot_date, calculated_at FROM ranking_snapshots ORDER BY calculated_at DESC LIMIT 1").first<{ snapshot_date: string; calculated_at: string }>();
  const slot = dueRankingSlot();
  const due = slot !== null && (!row?.calculated_at || new Date(row.calculated_at).getTime() < new Date(slot).getTime());
  return Response.json({ snapshotDate: row?.snapshot_date ?? null, calculatedAt: row?.calculated_at ?? null, due, slot, schedule: RANKING_HOURS });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { action?: string; runStartedAt?: string; processed?: number; remaining?: number; popular?: unknown[]; highRatio?: unknown[] };
  const db = await ensureSchema();
  const job = await db.prepare("SELECT status, run_started_at FROM sync_jobs WHERE kind='rankings'").first<{ status: string; run_started_at: string | null }>();
  if (job?.status !== "running" || !body.runStartedAt || job.run_started_at !== body.runStartedAt) return Response.json({ error: "榜单作业已暂停或已被新作业替换" }, { status: 409 });
  if (body.action === "progress") {
    await updateSyncJob({ kind: "rankings", status: "running", phase: "逐企业计算榜单", processedDelta: body.processed ?? 0, remaining: body.remaining ?? 0, endpoint: "/api/data/offers?view=detail", httpStatus: 200, response: { message: "正在计算全局候选项" } });
    return Response.json({ ok: true });
  }
  if (body.action !== "complete" || !Array.isArray(body.popular) || !Array.isArray(body.highRatio)) return Response.json({ error: "无效操作" }, { status: 400 });
  const now = new Date().toISOString();
  const date = chinaDate();
  const statements = [db.prepare("DELETE FROM ranking_snapshots")];
  for (const [kind, rows] of [["popular", body.popular], ["highRatio", body.highRatio]] as const) {
    rows.slice(0, 100).forEach((row, index) => statements.push(db.prepare("INSERT INTO ranking_snapshots (list_kind, rank, snapshot_date, calculated_at, payload) VALUES (?, ?, ?, ?, ?)").bind(kind, index + 1, date, now, JSON.stringify(row))));
  }
  await db.batch(statements);
  await updateSyncJob({ kind: "rankings", status: "complete", phase: "本时段榜单已更新", remaining: 0, endpoint: "/api/sync/rankings", httpStatus: 200, response: { snapshotDate: date, slot: dueRankingSlot(), popular: body.popular.length, highRatio: body.highRatio.length } });
  return Response.json({ ok: true, snapshotDate: date, calculatedAt: now });
}
