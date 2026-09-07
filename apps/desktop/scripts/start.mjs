import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectronBinary } from "./ensure-electron.mjs";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(desktopDir, "..", "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopDir,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });
    child.on("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
    });
    child.on("error", reject);
  });
}

async function ensureBuild() {
  console.log("Building Fern…");
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
}

async function main() {
  if (!existsSync(join(workspaceRoot, "node_modules", "electron"))) {
    console.log("Installing desktop dependencies...");
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install"], {
      cwd: workspaceRoot,
    });
  }

  ensureElectronBinary(workspaceRoot);
  await ensureBuild();

  const electronVite = join(workspaceRoot, "node_modules", "electron-vite", "bin", "electron-vite.js");
  const child = spawn(process.execPath, [electronVite, "preview"], {
    cwd: desktopDir,
    env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
