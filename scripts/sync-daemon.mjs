import { runContractSyncDaemon } from "./contract-sync-daemon.mjs";
import { runOrderSyncDaemon } from "./order-sync-daemon.mjs";
import { runSyncWorker } from "./sync-worker.mjs";

console.log("[sync] 统一同步服务启动：调度、订单、历史、榜单与合同任务共用单一容器");

try {
  await Promise.all([
    runSyncWorker(),
    runOrderSyncDaemon(),
    runContractSyncDaemon(),
  ]);
} catch (error) {
  console.error(`[sync] 任务模块意外退出：${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
}
