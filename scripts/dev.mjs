import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const hostIndex = args.indexOf("--host");
if (hostIndex >= 0) args[hostIndex] = "--hostname";
if (!args.includes("--hostname")) args.push("--hostname", "0.0.0.0");
const hostnameIndex = args.indexOf("--hostname");
const hostname = hostnameIndex >= 0 ? args[hostnameIndex + 1] : "0.0.0.0";
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? args[portIndex + 1] : "3000";
const vinext = path.resolve("node_modules", "vinext", "dist", "cli.js");
const sqlitePath = process.env.SQLITE_PATH || path.resolve(".data", "eve-lp.db");
const workerHostname = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
const devEnv = {
  ...process.env,
  SQLITE_RUNTIME: process.env.SQLITE_RUNTIME || "1",
  SQLITE_PATH: sqlitePath,
  SYNC_INTERNAL_TOKEN: process.env.SYNC_INTERNAL_TOKEN || "eve-lp-dev-sync-v1",
};

mkdirSync(path.dirname(sqlitePath), { recursive: true });

const web = spawn(process.execPath, [vinext, "dev", ...args], { stdio: "inherit", env: devEnv });
const sync = spawn(process.execPath, [path.resolve("scripts", "sync-daemon.mjs")], {
  stdio: "inherit",
  env: { ...devEnv, SYNC_BASE_URL: process.env.SYNC_BASE_URL || `http://${workerHostname}:${port}` },
});

function shutdown(code = 0) {
  if (!web.killed) web.kill();
  if (!sync.killed) sync.kill();
  process.exit(code);
}

web.on("exit", code => shutdown(code ?? 0));
sync.on("exit", code => { if (code) shutdown(code); });
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
