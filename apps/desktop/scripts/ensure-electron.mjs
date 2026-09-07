import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function getElectronExecutable(electronDir) {
  if (process.platform === "win32") {
    return join(electronDir, "dist", "electron.exe");
  }
  if (process.platform === "darwin") {
    return join(electronDir, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }
  return join(electronDir, "dist", "electron");
}

export function ensureElectronBinary(workspaceRoot) {
  const electronDir = join(workspaceRoot, "node_modules", "electron");
  const installer = join(electronDir, "install.js");
  const pathFile = join(electronDir, "path.txt");
  const executable = getElectronExecutable(electronDir);

  if (existsSync(pathFile) && existsSync(executable)) {
    return;
  }

  if (!existsSync(installer)) {
    throw new Error(
      "Electron is not installed. Run npm install from the repository root, then run npm run dev again.",
    );
  }

  console.log("Electron runtime missing; downloading it for source development...");
  const result = spawnSync(process.execPath, [installer], {
    cwd: workspaceRoot,
    env: { ...process.env },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || !existsSync(pathFile) || !existsSync(executable)) {
    throw new Error(
      "Electron runtime download did not complete. Check your network connection and run npm run dev again.",
    );
  }
}
