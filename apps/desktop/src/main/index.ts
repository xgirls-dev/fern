import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from "electron";
import { PythonBackend } from "./python-backend";
import { resolveDataProfile } from "./data-profile";
import { installEditorContextMenu } from "./editor-context-menu";
import { ensureFirstRunSetup, RuntimeSetupCancelled } from "./first-run-setup";
import { getAppIconPath, getOutputsDir, resolveProjectRoot } from "./paths";

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let backend: PythonBackend | null = null;
let backendReady = false;
let isShuttingDown = false;

function allocatePort(): number {
  return randomInt(18_000, 65_000);
}

function resolvePreloadPath(): string {
  const candidates = [
    join(__dirname, "../preload/index.mjs"),
    join(__dirname, "../preload/index.js"),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(
      "Preload script not found. Run `npm run build` or `npm run dev` first.",
    );
  }
  return match;
}

function createWindow(apiBaseUrl?: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    icon: getAppIconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#212121" : "#fafafa",
    frame: process.platform === "linux",
    titleBarStyle:
      process.platform === "darwin"
        ? "hiddenInset"
        : process.platform === "win32"
          ? "hidden"
          : "default",
    ...(process.platform === "win32"
      ? {
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: nativeTheme.shouldUseDarkColors
              ? "#ededed"
              : "#171717",
            height: 44,
          },
        }
      : {}),
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDev,
      spellcheck: true,
    },
  });

  window.once("ready-to-show", () => {
    if (process.env.FERN_E2E_HEADLESS !== "1") window.show();
  });

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) {
      return;
    }

    const key = input.key.toLowerCase();
    const zoomIn =
      input.code === "Equal" ||
      input.code === "NumpadAdd" ||
      key === "+" ||
      key === "=";
    const zoomOut =
      input.code === "Minus" ||
      input.code === "NumpadSubtract" ||
      key === "-" ||
      key === "_";
    const resetZoom =
      input.code === "Digit0" || input.code === "Numpad0" || key === "0";

    if (!zoomIn && !zoomOut && !resetZoom) return;

    event.preventDefault();
    if (resetZoom) {
      window.webContents.setZoomLevel(0);
      return;
    }

    const currentLevel = window.webContents.getZoomLevel();
    window.webContents.setZoomLevel(currentLevel + (zoomIn ? 0.5 : -0.5));
  });

  installEditorContextMenu(window);

  const loadApp = async () => {
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      await window.loadFile(join(__dirname, "../renderer/index.html"));
    }
    if (apiBaseUrl && !window.isDestroyed()) {
      window.webContents.send("studio:api-base-url", apiBaseUrl);
    }
  };

  window.webContents.on("did-finish-load", () => {
    if (apiBaseUrl && !window.isDestroyed()) {
      window.webContents.send("studio:api-base-url", apiBaseUrl);
    }
  });

  void loadApp();

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Outputs Folder",
          click: () => {
            void shell.openPath(getOutputsDir());
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom", accelerator: "CommandOrControl+0" },
        { role: "zoomIn", accelerator: "CommandOrControl+=" },
        { role: "zoomOut", accelerator: "CommandOrControl+-" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.handle(
    "studio:adjust-zoom",
    (event, action: "in" | "out" | "reset") => {
      const contents = event.sender;
      if (action === "reset") {
        contents.setZoomLevel(0);
      } else if (action === "in" || action === "out") {
        contents.setZoomLevel(
          contents.getZoomLevel() + (action === "in" ? 0.5 : -0.5),
        );
      } else {
        throw new Error("Invalid zoom action.");
      }
      return contents.getZoomLevel();
    },
  );

  ipcMain.handle("studio:get-theme", () => {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  });

  ipcMain.handle(
    "studio:set-theme",
    (_event, theme: "light" | "dark" | "system") => {
      nativeTheme.themeSource = theme;
      return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    },
  );

  ipcMain.handle("studio:window-minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("studio:window-toggle-maximize", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) {
      window.unmaximize();
      return false;
    }
    window.maximize();
    return true;
  });

  ipcMain.handle("studio:window-close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("studio:copy-text", (_event, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle("studio:clear-web-cache", async (event) => {
    await Promise.all([
      event.sender.session.clearCache(),
      event.sender.session.clearStorageData({
        storages: ["serviceworkers", "cachestorage"],
      }),
    ]);
  });

  ipcMain.handle("studio:open-outputs-folder", async () => {
    const error = await shell.openPath(getOutputsDir());
    if (error) throw new Error(error);
    return "";
  });

  ipcMain.handle("studio:open-path", async (_event, filePath: string) => {
    return shell.openPath(filePath);
  });

  ipcMain.handle(
    "studio:open-output-image",
    async (_event, imageName: string) => {
      if (
        !imageName ||
        /[\\/]/.test(imageName) ||
        !imageName.toLowerCase().endsWith(".png")
      )
        throw new Error("Invalid image name.");
      const filePath = join(getOutputsDir(), imageName);
      const error = await shell.openPath(filePath);
      if (error) throw new Error(error);
      return "";
    },
  );

  ipcMain.handle(
    "studio:delete-output-image",
    async (_event, imageName: string) => {
      if (
        !imageName ||
        /[\\/]/.test(imageName) ||
        !imageName.toLowerCase().endsWith(".png")
      )
        throw new Error("Invalid image name.");
      await shell.trashItem(join(getOutputsDir(), imageName));
    },
  );

  const audioOutputPath = (audioName: unknown) => {
    if (typeof audioName !== "string" || !/^qwen3-tts-\d+\.wav$/i.test(audioName))
      throw new Error("Invalid audio output name.");
    return join(getOutputsDir(), audioName);
  };

  ipcMain.handle("studio:open-output-audio", async (_event, audioName: unknown) => {
    const error = await shell.openPath(audioOutputPath(audioName));
    if (error) throw new Error(error);
    return "";
  });

  ipcMain.handle("studio:reveal-output-audio", (_event, audioName: unknown) => {
    shell.showItemInFolder(audioOutputPath(audioName));
  });

  ipcMain.handle("studio:delete-output-audio", async (_event, audioName: unknown) => {
    const path = audioOutputPath(audioName);
    if (existsSync(path)) await shell.trashItem(path);
  });

  ipcMain.handle("studio:save-output-audio", async (event, audioName: unknown) => {
    const sourcePath = audioOutputPath(audioName);
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      title: "Save audio take",
      defaultPath: audioName as string,
      filters: [{ name: "WAV Audio", extensions: ["wav"] }],
    };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (resolve(result.filePath).toLowerCase() !== resolve(sourcePath).toLowerCase()) {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(sourcePath, result.filePath);
    }
    return result.filePath;
  });

  ipcMain.handle(
    "studio:show-image-in-folder",
    async (_event, filePath: string) => {
      shell.showItemInFolder(filePath);
    },
  );

  ipcMain.handle("studio:pick-reference-image", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: "Choose reference image",
          properties: ["openFile"],
          filters: [
            { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
          ],
        })
      : await dialog.showOpenDialog({
          title: "Choose reference image",
          properties: ["openFile"],
          filters: [
            { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
          ],
        });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle("studio:pick-text-model-folder", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      title: "Choose an OpenVINO text model folder",
      properties: ["openDirectory"] as Array<"openDirectory">,
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("studio:pick-custom-image-model-folder", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      title: "Choose an OpenVINO image model export folder",
      properties: ["openDirectory"] as Array<"openDirectory">,
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.on("studio:request-api-base-url", (event) => {
    if (backend && backendReady) {
      event.sender.send("studio:api-base-url", backend.baseUrl);
    }
  });

  ipcMain.handle(
    "studio:read-file-as-data-url",
    async (_event, filePath: string) => {
      const { readFile } = await import("node:fs/promises");
      const { extname } = await import("node:path");
      const data = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : "image/jpeg";
      return `data:${mime};base64,${data.toString("base64")}`;
    },
  );

  ipcMain.handle("studio:save-image-as", async (event, defaultName: string) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = window
      ? await dialog.showSaveDialog(window, {
          title: "Save generated image",
          defaultPath: defaultName,
          filters: [{ name: "PNG Image", extensions: ["png"] }],
        })
      : await dialog.showSaveDialog({
          title: "Save generated image",
          defaultPath: defaultName,
          filters: [{ name: "PNG Image", extensions: ["png"] }],
        });

    if (result.canceled || !result.filePath) {
      return null;
    }

    return result.filePath;
  });

  ipcMain.handle(
    "studio:write-image-file",
    async (_event, targetPath: string, sourceUrl: string) => {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(`Could not download image (${response.status}).`);
      }
      const { writeFile } = await import("node:fs/promises");
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(targetPath, buffer);
      return targetPath;
    },
  );

  nativeTheme.on("updated", () => {
    const theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("studio:theme-changed", theme);
      window.setBackgroundColor(theme === "dark" ? "#212121" : "#fafafa");
      if (process.platform === "win32") {
        window.setTitleBarOverlay({
          color: "#00000000",
          symbolColor: theme === "dark" ? "#ededed" : "#171717",
          height: 44,
        });
      }
    }
  });
}

async function bootstrap(): Promise<void> {
  app.setName("Fern");
  app.setAppUserModelId("ai.intel-iris.studio");

  // Honor an explicit profile for isolated runs; normal upgrades preserve the
  // existing data profile and its models, outputs, and preferences.
  const profileOverride = app.commandLine.getSwitchValue("user-data-dir");
  if (profileOverride) {
    app.setPath("userData", resolve(profileOverride));
  } else if (app.isPackaged) {
    app.setPath("userData", resolveDataProfile(app.getPath("appData")));
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  await app.whenReady();

  let setupWindow: BrowserWindow | null = null;
  try {
    await resolveProjectRoot();
    // Development uses the repository's .venv directly. The first-run
    // installer only applies to packaged builds with runtime-release.zip.
    if (app.isPackaged) {
      setupWindow = await ensureFirstRunSetup();
    }
  } catch (error) {
    if (error instanceof RuntimeSetupCancelled) { app.quit(); return; }
    console.error("Fern runtime setup failed:", error);
    if (process.env.FERN_E2E_HEADLESS !== "1") dialog.showErrorBox(
      "Fern",
      error instanceof Error
        ? error.message
        : "Could not complete first-run setup.",
    );
    app.quit();
    return;
  }

  buildMenu();
  registerIpc();

  const port = allocatePort();
  backend = new PythonBackend(port);
  const pendingBaseUrl = `http://127.0.0.1:${port}`;

  mainWindow = createWindow();
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();

  void (async () => {
    try {
      await backend?.start();
      backendReady = Boolean(backend);
      const baseUrl = backend?.baseUrl ?? pendingBaseUrl;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send("studio:api-base-url", baseUrl);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to start the OpenVINO backend.";
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send("studio:backend-error", message);
        }
      }
    }
  })();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && backend) {
      mainWindow = createWindow(backendReady ? backend.baseUrl : undefined);
    }
  });
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  backendReady = false;
  if (backend) {
    await backend.stop();
    backend = null;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void shutdown().finally(() => app.quit());
  }
});

app.on("before-quit", (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    void shutdown().finally(() => app.quit());
  }
});

void bootstrap().catch(async (error) => {
  console.error(error);
  await dialog.showErrorBox(
    "Fern",
    error instanceof Error ? error.message : "Failed to start the desktop app.",
  );
  app.quit();
});
