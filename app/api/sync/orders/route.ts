import { ensureSchema } from "../../../../db/d1";
import { updateSyncJob } from "../../../../db/sync-state";

export async function POST(request: Request) {
  const db = await ensureSchema();
  const body = await request.json().catch(() => ({})) as { runStartedAt?: string };
  const runStartedAt = body.runStartedAt || new Date().toISOString();
  await updateSyncJob({ kind: "orders", status: "running", phase: "等待全量订单同步器", runStartedAt, response: { message: "伏尔戈全量订单由常驻同步器原子更新" } });
  const job = await db.prepare("SELECT status, run_started_at FROM sync_jobs WHERE kind='orders'").first<{ status: string; run_started_at: string | null }>();
  return Response.json({ delegated: true, running: job?.status === "running", runStartedAt: job?.run_started_at ?? runStartedAt }, { status: 202 });
}
