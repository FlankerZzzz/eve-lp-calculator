import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const hostIndex = args.indexOf("--host");
if (hostIndex >= 0) args[hostIndex] = "--hostname";
if (!args.includes("--hostname")) args.push("--hostname", "0.0.0.0");
const vinext = path.resolve("node_modules", "vinext", "dist", "cli.js");
const sqlitePath = process.env.V2_SQLITE_PATH || path.resolve("docker-data", "v2", "eve-v2.db");
const devEnv = {
  ...process.env,
  V2_SQLITE_PATH: sqlitePath,
  V2_LOG_PATH: process.env.V2_LOG_PATH || path.resolve("docker-data", "v2", "logs"),
};

mkdirSync(path.dirname(sqlitePath), { recursive: true });

const web = spawn(process.execPath, [vinext, "dev", ...args], { stdio: "inherit", env: devEnv });
const sync = spawn(process.execPath, [path.resolve("scripts", "v2", "worker.mjs")], {
  stdio: "inherit",
  env: devEnv,
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
