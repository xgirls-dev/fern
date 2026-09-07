import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

let projectRoot: string | null = null;

function createDataFolders(root: string): void {
  for (const folder of ["models", "outputs", "data"]) {
    mkdirSync(join(root, folder), { recursive: true });
  }
}

function resolveRoot(): string {
  const configured =
    process.env.FERN_ROOT?.trim() || process.env.INTEL_IRIS_ROOT?.trim();
  if (configured) return configured;
  if (app.isPackaged) return join(app.getPath("userData"), "studio-data");
  return join(app.getAppPath(), "..", "..");
}

export function getStoredProjectRoot(): string | null {
  return projectRoot;
}

export async function resolveProjectRoot(): Promise<string> {
  if (!projectRoot) {
    projectRoot = resolveRoot();
    createDataFolders(projectRoot);
  }
  return projectRoot;
}

export function getProjectRoot(): string {
  if (!projectRoot) {
    projectRoot = resolveRoot();
    createDataFolders(projectRoot);
  }
  return projectRoot;
}
