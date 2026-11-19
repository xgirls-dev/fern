import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { app } from "electron";
import { getProjectRoot } from "./project-root";

export { getProjectRoot, getStoredProjectRoot, resolveProjectRoot } from "./project-root";

export function getModelsRoot(): string {
  return join(getProjectRoot(), "models");
}

function getSourceRoot(): string {
  let candidate = resolve(app.getAppPath());
  while (true) {
    if (
      existsSync(join(candidate, "scripts", "api_server.py")) &&
      existsSync(join(candidate, "apps", "desktop", "package.json"))
    ) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("Could not locate the Fern source root from the Electron app path.");
}

export function getAppIconPath(): string {
  const icon = process.platform === "linux" ? "icon.png" : "icon.ico";
  return app.isPackaged
    ? join(process.resourcesPath, icon)
    : join(app.getAppPath(), "resources", icon);
}

export function getPythonExecutable(): string {
  if (app.isPackaged) {
    if (process.platform === "linux") {
      return join(process.resourcesPath, "runtime", "python-home", "bin", "python3.12");
    }
    return join(app.getPath("userData"), "runtime", "python-home", "python.exe");
  }
  const root = getSourceRoot();
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
  return join(getSourceRoot(), "scripts", "api_server.py");
}

export function getBootstrapScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "scripts", "bootstrap_install.py");
  }
  return join(getSourceRoot(), "scripts", "bootstrap_install.py");
}

export function getOutputsDir(): string {
  return join(getProjectRoot(), "outputs");
}

export function getPythonEnvironment(): NodeJS.ProcessEnv {
  const useExtractedRuntime = app.isPackaged && process.platform === "win32";
  const bundledPythonHome = useExtractedRuntime
    ? join(app.getPath("userData"), "runtime", "python-home")
    : undefined;
  const bundledSitePackages = useExtractedRuntime
    ? join(app.getPath("userData"), "runtime", "site-packages")
    : undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
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
            .join(delimiter),
        }
      : {}),
  };
  if (app.isPackaged && process.platform === "linux") {
    // The system Python configuration must not override the packaged interpreter.
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
    env.PYTHONNOUSERSITE = "1";
  }
  return env;
}

