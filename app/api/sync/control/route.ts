import { ensureSchema } from "../../../../db/d1";
import { updateSyncJob } from "../../../../db/sync-state";

type SyncKind = "catalog" | "history" | "orders" | "linked" | "rankings";

const kinds = new Set<SyncKind>(["catalog", "history", "orders", "linked", "rankings"]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { kind?: SyncKind; action?: "start" | "pause" | "restart" };
  if (!body.kind || !kinds.has(body.kind) || !body.action) {
    return Response.json({ error: "无效的同步作业或操作" }, { status: 400 });
  }

  const db = await ensureSchema();
  if (body.action === "pause") {
    const running = (await db.prepare("SELECT kind, remaining FROM sync_jobs WHERE status='running'").all<{ kind: SyncKind; remaining: number }>()).results;
    const targets = running.length ? running : [{ kind: body.kind, remaining: 0 }];
    for (const target of targets) {
      await updateSyncJob({ kind: target.kind, status: "paused", phase: "已暂停", remaining: target.remaining, response: { message: "所有同步已强制暂停；点击同步可从当前进度继续" } });
    }
    return Response.json({ ok: true, status: "paused", paused: targets.map(target => target.kind) });
  }

  if (body.action === "restart") {
    const running = await db.prepare("SELECT kind FROM sync_jobs WHERE status='running'").first<{ kind: SyncKind }>();
    if (running) return Response.json({ error: `请先暂停正在运行的 ${running.kind} 同步` }, { status: 409 });
  }

  const others = (await db.prepare("SELECT kind FROM sync_jobs WHERE status='running' AND kind != ?").bind(body.kind).all<{ kind: SyncKind }>()).results;
  const compatible = (body.kind === "linked" && others.every(job => job.kind === "catalog")) || (body.kind === "catalog" && others.every(job => job.kind === "linked"));
  if (others.length && !compatible) return Response.json({ error: `请先暂停正在运行的 ${others[0].kind} 同步` }, { status: 409 });

  const previous = await db.prepare("SELECT status, run_started_at, remaining FROM sync_jobs WHERE kind=?").bind(body.kind).first<{ status: string; run_started_at: string | null; remaining: number }>();
  const isResume = body.action !== "restart" && Boolean(previous?.run_started_at && ["paused", "error", "running"].includes(previous.status));
  const runStartedAt = isResume ? previous!.run_started_at! : new Date().toISOString();
  await updateSyncJob({
    kind: body.kind,
    status: "running",
    phase: "等待后台同步器",
    runStartedAt,
    remaining: isResume ? previous?.remaining ?? 0 : 0,
    response: { message: isResume ? "同步已恢复；独立后台同步器将在 0.5 秒后请求下一批数据" : "已开始新一轮全量同步；进度已清零" },
    allowResume: true,
  });
  return Response.json({ ok: true, kind: body.kind, status: "running", runStartedAt, resumed: isResume }, { status: 202 });
}
