import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { dialog, type BrowserWindow } from "electron";
import { getApiScriptPath, getProjectRoot, getPythonEnvironment, getPythonExecutable } from "./paths";

const runFile = promisify(execFile);
let saving = false;

export async function saveWorkspaceBackup(owner: BrowserWindow, snapshot: unknown): Promise<boolean> {
  if (typeof snapshot !== "string" || !snapshot) throw new Error("The workspace snapshot is unavailable.");
  if (saving) throw new Error("A workspace backup is already in progress.");
  saving = true;
  try {
    const date = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(owner, {
      title: "Save workspace backup",
      defaultPath: `Fern workspace ${date}.fern-backup`,
      filters: [{ name: "Fern workspace backup", extensions: ["fern-backup"] }],
      properties: ["showOverwriteConfirmation"],
    });
    if (canceled || !filePath) return false;

    const directory = await mkdtemp(join(tmpdir(), "fern-workspace-"));
    try {
      const state = join(directory, "workspace.json");
      await writeFile(state, snapshot, { encoding: "utf8", mode: 0o600 });
      try {
        await runFile(getPythonExecutable(), [
          join(dirname(getApiScriptPath()), "workspace_backup.py"), "create", getProjectRoot(), state, filePath,
        ], { env: getPythonEnvironment(), windowsHide: true });
      } catch (error) {
        const detail = (error as { stderr?: string }).stderr?.trim();
        throw new Error(detail || "Could not write the workspace backup.");
      }
      return true;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    saving = false;
  }
}
