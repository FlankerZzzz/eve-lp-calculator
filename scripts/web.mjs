import { spawn } from "node:child_process";
const port = process.env.PORT || "3000";
const mode = process.env.NODE_ENV === "production" ? "start" : "dev";
const child = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", mode, "--hostname", "0.0.0.0", "--port", port], { stdio: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", code => process.exit(code ?? 0));
