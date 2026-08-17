import { spawn } from "node:child_process";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const hostIndex = args.indexOf("--host");
if (hostIndex >= 0) args[hostIndex] = "--hostname";
if (!args.includes("--hostname")) args.push("--hostname", "0.0.0.0");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? args[portIndex + 1] : "3000";
const vinext = path.resolve("node_modules", ".bin", process.platform === "win32" ? "vinext.cmd" : "vinext");

const web = spawn(vinext, ["dev", ...args], { stdio: "inherit", shell: process.platform === "win32" });
const worker = spawn(process.execPath, [path.resolve("scripts", "sync-worker.mjs")], {
  stdio: "inherit",
  env: { ...process.env, SYNC_BASE_URL: `http://localhost:${port}` },
});

function shutdown(code = 0) {
  if (!web.killed) web.kill();
  if (!worker.killed) worker.kill();
  process.exit(code);
}

web.on("exit", code => shutdown(code ?? 0));
worker.on("exit", code => { if (code) shutdown(code); });
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
