import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectronBinary } from "./ensure-electron.mjs";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(desktopDir, "..", "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

ensureElectronBinary(workspaceRoot);

const electronVite = join(workspaceRoot, "node_modules", "electron-vite", "bin", "electron-vite.js");
const child = spawn(process.execPath, [electronVite, "dev"], {
  cwd: desktopDir,
  env,
  stdio: "inherit",
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  child.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  // electron-vite often reports code 1 after a normal window close in dev.
  if (shuttingDown || signal === "SIGINT" || signal === "SIGTERM" || code === 1) {
    process.exit(0);
    return;
  }
  process.exit(code ?? 0);
});
