import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import {
  getAppIconPath,
  getBootstrapScriptPath,
  getModelsRoot,
  getPythonEnvironment,
  getPythonExecutable,
  getProjectRoot,
} from "./paths";

function modelReady(): boolean {
  const openVinoDir = join(getModelsRoot(), "flux2-klein-9b-circulus-int4");
  const openVinoFiles = [
    "model_index.json",
    "transformer/openvino_model.xml",
    "transformer/openvino_model.bin",
    "text_encoder/openvino_model.xml",
    "text_encoder/openvino_model.bin",
    "vae_decoder/openvino_model.xml",
    "vae_decoder/openvino_model.bin",
  ];
  return openVinoFiles.every((file) => existsSync(join(openVinoDir, file)));
}

function runtimeReady(): boolean {
  const root = join(app.getPath("userData"), "runtime");
  return (
    existsSync(join(root, ".installed")) &&
    existsSync(join(root, "python-home", "python.exe"))
  );
}

async function ensureRuntime(window: BrowserWindow): Promise<void> {
  if (runtimeReady()) return;
  updateStatus(window, "Installing the Fern AI runtime...");
  const archive = join(process.resourcesPath, "runtime-release.zip");
  if (!existsSync(archive)) {
    throw new Error("The bundled AI runtime archive is missing. Please reinstall Fern.");
  }
  const target = join(app.getPath("userData"), "runtime");
  mkdirSync(target, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar.exe", ["-xf", archive, "-C", target], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      const python = join(target, "python-home", "python.exe");
      if (code === 0 && existsSync(python)) {
        writeFileSync(join(target, ".installed"), "Fern runtime ready\n", "utf8");
        resolve();
      }
      else reject(new Error(error.trim() || `Runtime extraction failed with exit code ${code}.`));
    });
  });
}

function setupHtmlV2(): string {
  const dark = nativeTheme.shouldUseDarkColors;
  const bg = dark ? "#0a0a0a" : "#f7f7f7";
  const fg = dark ? "#f2f2f2" : "#171717";
  const muted = dark ? "#a1a1aa" : "#64646d";
  const secondary = dark ? "#171717" : "#ededed";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>
  *{box-sizing:border-box}body{margin:0;background:${bg};color:${fg};font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;height:100vh}.card{width:460px;text-align:center}.mark{display:block;width:54px;height:54px;border-radius:16px;margin:0 auto 22px;box-shadow:0 12px 40px #2dd4a344}.progress{display:grid;place-items:center;min-height:70px}.spinner{width:22px;height:22px;border:2px solid ${muted};border-top-color:#2dd4a3;border-radius:50%;margin:24px auto;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}h1{font-size:24px;margin:0 0 10px;text-wrap:balance}p{color:${muted};margin:0}.note{font-size:12px;margin-top:22px}.cancel{margin-top:18px;border:1px solid ${muted};border-radius:6px;padding:7px 12px;background:transparent;color:${fg};font:inherit;cursor:pointer}.cancel:hover{background:${secondary}}</style></head><body><main class="card"><svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#0d0b14"/><path d="M6 20c5.8-3.7 6.8-9.7 8.7-15.3" stroke="#2dd4a3" stroke-width="1.8" stroke-linecap="round"/><path d="m8.3 17.1-3.5-2.8.1 3.4 2.6 1.4Z" fill="#2dd4a3"/><path d="m10.7 13.4-3.6-2.5.2 3.4 2.7 1.2Z" fill="#42d77d"/><path d="m12.3 9.6-2.9-2.2.1 2.8 2.2 1.1Z" fill="#8eea3b"/><path d="m12 16.8 4.7-.6-1.2 3.2-4.1.2Z" fill="#2dd4a3"/><path d="m13.2 12.7 4.1-1-1 3.3-3.7.6Z" fill="#55dc67"/><path d="m14.2 8.7 3.1-1-.7 2.8-2.8.7Z" fill="#a3e635"/><path d="m15 4.6 2.4-1.7v2.7l-2.5 1.5Z" fill="#ff715b"/></svg><h1>Setting up Fern</h1><p id="status" role="status" aria-live="polite">Preparing your private AI studio...</p><div id="progress" class="progress" role="progressbar" aria-label="Fern setup progress" aria-valuetext="Preparing setup"><div class="spinner" aria-hidden="true"></div></div><button class="cancel" type="button" onclick="window.close()">Cancel setup</button><p class="note">Keep this window open. Fern downloads one shared OpenVINO model for every device.</p></main></body></html>`;
}

function updateStatus(window: BrowserWindow, message: string): void {
  if (window.isDestroyed()) return;
  const script = `const status=document.getElementById("status");if(status){status.textContent=${JSON.stringify(message)};status.setAttribute("aria-label",${JSON.stringify(message)});}const progress=document.getElementById("progress");if(progress){progress.setAttribute("aria-valuetext",${JSON.stringify(message)});}`;
  void window.webContents.executeJavaScript(script);
}

export async function ensureFirstRunSetup(): Promise<void> {
  if (runtimeReady() && modelReady()) return;

  const window = new BrowserWindow({
    width: 560,
    height: 400,
    resizable: false,
    maximizable: false,
    title: "Fern Setup",
    icon: getAppIconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#f7f7f7",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(setupHtmlV2())}`);
  window.show();

  await ensureRuntime(window);

  const python = getPythonExecutable();
  const script = getBootstrapScriptPath();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      python,
      [script, "--adapter", "auto", "--models-root", getModelsRoot()],
      {
        cwd: getProjectRoot(),
        env: getPythonEnvironment(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdoutBuffer = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { message?: string };
          if (event.message) updateStatus(window, event.message);
        } catch {
          // Dependency progress output is not part of the setup status protocol.
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `First-run setup failed with exit code ${code}.`));
    });
    window.once("closed", () => {
      if (!child.killed) child.kill();
      reject(new Error("Setup was canceled. Relaunch Fern to continue."));
    });
  });

  if (!window.isDestroyed()) window.close();
}

