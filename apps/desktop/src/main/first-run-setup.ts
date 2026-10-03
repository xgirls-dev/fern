import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow, nativeTheme } from "electron";
import { getAppIconPath } from "./paths";

export class RuntimeSetupCancelled extends Error {}

async function renameRuntime(source: string, target: string): Promise<void> {
  // Windows can briefly retain extraction/scanner handles after tar exits.
  // Retry only sharing/permission failures; leave the old runtime available
  // when replacement cannot complete.
  for (let attempt = 0; ; attempt += 1) {
    try { renameSync(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 40 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function runtimeRevision(): string {
  const manifest = JSON.parse(readFileSync(join(process.resourcesPath, "runtime-release.json"), "utf8").replace(/^\uFEFF/, ""));
  if (!/^[a-f0-9]{64}$/.test(manifest.archiveSha256)) throw new Error("The bundled runtime manifest is invalid. Please reinstall Fern.");
  return manifest.archiveSha256;
}

function runtimeReady(): boolean {
  const root = join(app.getPath("userData"), "runtime");
  try {
    return readFileSync(join(root, ".installed"), "utf8").trim() === runtimeRevision()
      && existsSync(join(root, "python-home", "python.exe"));
  } catch { return false; }
}

async function ensureRuntime(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) throw new RuntimeSetupCancelled("Setup cancelled.");
  if (runtimeReady()) return;
  updateStatus(window, "Installing the Fern AI runtime...");
  const archive = join(process.resourcesPath, "runtime-release.zip");
  if (!existsSync(archive)) {
    throw new Error(
      "The bundled AI runtime archive is missing. Please reinstall Fern.",
    );
  }
  const target = join(app.getPath("userData"), "runtime");
  const stage = join(app.getPath("userData"), "runtime-installing");
  const previous = join(app.getPath("userData"), "runtime-previous");
  const profile = resolve(app.getPath("userData"));
  for (const generated of [target, stage, previous]) {
    if (dirname(resolve(generated)) !== profile) throw new Error("Invalid generated runtime path.");
  }
  const revision = runtimeRevision();
  // All three paths are fixed generated-runtime children of this profile. Model,
  // output, and thread data live elsewhere and are never touched here.
  await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  mkdirSync(stage, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar.exe", ["-xf", archive, "-C", stage], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString("utf8");
    });
    let cancelled = false;
    const cancel = () => { cancelled = true; child.kill(); };
    window.once("closed", cancel);
    child.once("error", (error) => { window.removeListener("closed", cancel); reject(error); });
    child.once("close", async (code) => {
      window.removeListener("closed", cancel);
      if (cancelled) { reject(new RuntimeSetupCancelled("Setup cancelled.")); return; }
      const python = join(stage, "python-home", "python.exe");
      if (code === 0 && existsSync(python)) {
        try {
          writeFileSync(join(stage, ".installed"), revision + "\n", "utf8");
          await rm(previous, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          if (existsSync(target)) await renameRuntime(target, previous);
          try { await renameRuntime(stage, target); }
          catch (error) {
            if (existsSync(previous)) await renameRuntime(previous, target);
            throw error;
          }
          try { await rm(previous, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
          catch (error) { console.warn("Could not remove the previous generated runtime:", error); }
          resolve();
        } catch (error) { reject(error); }
      } else
        reject(
          new Error(
            error.trim() || `Runtime extraction failed with exit code ${code}.`,
          ),
        );
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
  *{box-sizing:border-box}body{margin:0;background:${bg};color:${fg};font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;height:100vh}.card{width:460px;text-align:center}.mark{display:block;width:54px;height:54px;border-radius:16px;margin:0 auto 22px;box-shadow:0 12px 40px #2dd4a344}.progress{display:grid;place-items:center;min-height:70px}.spinner{width:22px;height:22px;border:2px solid ${muted};border-top-color:#2dd4a3;border-radius:50%;margin:24px auto;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}h1{font-size:24px;margin:0 0 10px;text-wrap:balance}p{color:${muted};margin:0}.note{font-size:12px;margin-top:22px}.cancel{margin-top:18px;border:1px solid ${muted};border-radius:6px;padding:7px 12px;background:transparent;color:${fg};font:inherit;cursor:pointer}.cancel:hover{background:${secondary}}</style></head><body><main class="card"><svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#0d0b14"/><path d="M6 20c5.8-3.7 6.8-9.7 8.7-15.3" stroke="#2dd4a3" stroke-width="1.8" stroke-linecap="round"/><path d="m8.3 17.1-3.5-2.8.1 3.4 2.6 1.4Z" fill="#2dd4a3"/><path d="m10.7 13.4-3.6-2.5.2 3.4 2.7 1.2Z" fill="#42d77d"/><path d="m12.3 9.6-2.9-2.2.1 2.8 2.2 1.1Z" fill="#8eea3b"/><path d="m12 16.8 4.7-.6-1.2 3.2-4.1.2Z" fill="#2dd4a3"/><path d="m13.2 12.7 4.1-1-1 3.3-3.7.6Z" fill="#55dc67"/><path d="m14.2 8.7 3.1-1-.7 2.8-2.8.7Z" fill="#a3e635"/><path d="m15 4.6 2.4-1.7v2.7l-2.5 1.5Z" fill="#ff715b"/></svg><h1>Setting up Fern</h1><p id="status" role="status" aria-live="polite">Preparing your private AI studio...</p><div id="progress" class="progress" role="progressbar" aria-label="Fern setup progress" aria-valuetext="Preparing setup"><div class="spinner" aria-hidden="true"></div></div><button class="cancel" type="button">Cancel setup</button><p class="note">Keep this window open. Choose optional models inside Fern after runtime setup.</p></main></body></html>`;
}

function updateStatus(window: BrowserWindow, message: string): void {
  if (window.isDestroyed()) return;
  const script = `const status=document.getElementById("status");if(status){status.textContent=${JSON.stringify(message)};status.setAttribute("aria-label",${JSON.stringify(message)});}const progress=document.getElementById("progress");if(progress){progress.setAttribute("aria-valuetext",${JSON.stringify(message)});}`;
  void window.webContents.executeJavaScript(script);
}

export async function ensureFirstRunSetup(): Promise<BrowserWindow | null> {
  if (runtimeReady()) return null;

  const window = new BrowserWindow({
    width: 560,
    height: 400,
    resizable: false,
    maximizable: false,
    title: "Fern Setup",
    icon: getAppIconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#f7f7f7",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(setupHtmlV2())}`,
  );
  await window.webContents.executeJavaScript('document.querySelector(".cancel").addEventListener("click", () => window.close());');
  window.show();

  await ensureRuntime(window);

  // Keep a window alive until bootstrap creates the main window. Closing the
  // only window here triggers Electron's Windows quit handler during setup.
  return window;
}
