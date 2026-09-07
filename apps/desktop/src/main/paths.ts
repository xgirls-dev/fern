import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { getProjectRoot } from "./project-root";

export { getProjectRoot, getStoredProjectRoot, resolveProjectRoot } from "./project-root";

export function getModelsRoot(): string {
  return join(getProjectRoot(), "models");
}

export function getAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.ico")
    : join(app.getAppPath(), "resources", "icon.ico");
}

export function getPythonExecutable(): string {
  if (app.isPackaged) {
    return join(app.getPath("userData"), "runtime", "python-home", "python.exe");
  }
  const root = getProjectRoot();
  const candidates = [
    join(root, ".venv", "Scripts", "python.exe"),
    join(root, ".venv", "bin", "python"),
    process.platform === "win32" ? "python.exe" : "python3",
  ];

  for (const candidate of candidates) {
    if (candidate.includes("python") && !candidate.includes("\\") && !candidate.includes("/")) {
      return candidate;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === "win32" ? "python.exe" : "python3";
}

export function getApiScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "scripts", "api_server.py");
  }
  return join(getProjectRoot(), "scripts", "api_server.py");
}

export function getBootstrapScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "scripts", "bootstrap_install.py");
  }
  return join(getProjectRoot(), "scripts", "bootstrap_install.py");
}

export function getOutputsDir(): string {
  return join(getProjectRoot(), "outputs");
}

export function getPythonEnvironment(): NodeJS.ProcessEnv {
  const bundledPythonHome = app.isPackaged
    ? join(app.getPath("userData"), "runtime", "python-home")
    : undefined;
  const bundledSitePackages = app.isPackaged
    ? join(app.getPath("userData"), "runtime", "site-packages")
    : undefined;
  return {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    FERN_ROOT: getProjectRoot(),
    FERN_MODELS_ROOT: getModelsRoot(),
    // Legacy names remain available for older helper scripts during upgrades.
    INTEL_IRIS_ROOT: getProjectRoot(),
    INTEL_IRIS_MODELS_ROOT: getModelsRoot(),
    ...(bundledPythonHome ? { PYTHONHOME: bundledPythonHome } : {}),
    ...(bundledSitePackages
      ? {
          PYTHONPATH: [bundledSitePackages, process.env.PYTHONPATH]
            .filter(Boolean)
            .join(";"),
        }
      : {}),
  };
}

