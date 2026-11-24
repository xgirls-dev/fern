import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import { getApiScriptPath, getProjectRoot, getPythonEnvironment, getPythonExecutable } from "./paths";
import type { WorkspaceProfiles } from "./workspace-profiles";

const runFile = promisify(execFile);

async function runWorkspaceBackupTool(...args: string[]) {
  try {
    const { stdout } = await runFile(getPythonExecutable(), [
      join(dirname(getApiScriptPath()), "workspace_backup.py"), ...args,
    ], { env: getPythonEnvironment(), windowsHide: true });
    return JSON.parse(stdout) as { createdAt: string; fileCount: number; size: number };
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim();
    throw new Error(detail || "Could not open or write the workspace backup.");
  }
}

async function saveWorkspaceBackup(owner: BrowserWindow, snapshot: unknown): Promise<boolean> {
  if (typeof snapshot !== "string" || !snapshot) throw new Error("The workspace snapshot is unavailable.");
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
    await runWorkspaceBackupTool("create", getProjectRoot(), state, filePath);
    return true;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerWorkspaceIpc(workspaces: WorkspaceProfiles, getWindow: () => BrowserWindow | null): void {
  let backupSelection: { token: string; path: string; name: string; fingerprint: string } | undefined;
  let workspaceAction = false;
  const workspaceWindow = (event: Electron.IpcMainInvokeEvent) => {
    const mainWindow = getWindow();
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Open Fern to manage its workspaces.");
    }
    return mainWindow;
  };
  const runWorkspaceAction = async <T,>(run: () => Promise<T>) => {
    if (workspaceAction) throw new Error("A workspace operation is already in progress.");
    workspaceAction = true;
    try { return await run(); }
    finally { workspaceAction = false; }
  };
  const fingerprint = async (path: string) => {
    const info = await stat(path, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  };
  const restartWorkspace = () => {
    setImmediate(() => {
      app.relaunch();
      app.quit();
    });
  };

  ipcMain.handle("studio:save-workspace-backup", (event, snapshot: unknown) =>
    runWorkspaceAction(() => saveWorkspaceBackup(workspaceWindow(event), snapshot)));
  ipcMain.handle("studio:list-workspaces", (event) => {
    workspaceWindow(event);
    return workspaces.summary();
  });
  ipcMain.handle("studio:choose-workspace-backup", (event) => runWorkspaceAction(async () => {
    const owner = workspaceWindow(event);
    backupSelection = undefined;
    const { canceled, filePaths: [path] } = await dialog.showOpenDialog(owner, {
      title: "Choose a workspace backup",
      filters: [{ name: "Fern workspace backup", extensions: ["fern-backup"] }],
      properties: ["openFile"],
    });
    if (canceled || !path) return null;
    const before = await fingerprint(path);
    const details = await runWorkspaceBackupTool("inspect", path);
    if (before !== await fingerprint(path)) throw new Error("The backup changed. Choose it again.");
    const token = randomUUID();
    const name = [...basename(path).replace(/\.fern-backup$/i, "").trim()].slice(0, 100).join("") || "Recovered workspace";
    backupSelection = { token, path, name, fingerprint: before };
    return { token, name, ...details };
  }));
  ipcMain.handle("studio:restore-workspace-backup", (event, token: string) => runWorkspaceAction(async () => {
    workspaceWindow(event);
    const selection = backupSelection;
    if (!selection || token !== selection.token) throw new Error("Choose the backup again.");
    if (selection.fingerprint !== await fingerprint(selection.path)) throw new Error("The backup changed. Choose it again.");
    await workspaces.create(selection.name, async (directory) => {
      await runWorkspaceBackupTool("stage", selection.path, directory);
      if (selection.fingerprint !== await fingerprint(selection.path)) throw new Error("The backup changed. Choose it again.");
    });
    backupSelection = undefined;
    restartWorkspace();
  }));
  ipcMain.handle("studio:switch-workspace", (event, id: string) => runWorkspaceAction(async () => {
    workspaceWindow(event);
    if (id === workspaces.summary().active) return;
    await workspaces.switchTo(id);
    restartWorkspace();
  }));
  ipcMain.handle("studio:read-workspace-seed", (event) => {
    workspaceWindow(event);
    return workspaces.seed();
  });
  ipcMain.handle("studio:finish-workspace-seed", (event) => runWorkspaceAction(async () => {
    workspaceWindow(event).webContents.session.flushStorageData();
    await workspaces.finish();
  }));
  ipcMain.handle("studio:return-from-failed-restore", (event) => runWorkspaceAction(async () => {
    workspaceWindow(event);
    await workspaces.returnFromFailedRestore();
    restartWorkspace();
  }));
}
