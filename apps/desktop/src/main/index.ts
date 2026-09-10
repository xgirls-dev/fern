import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { ensureFirstRunSetup } from "./first-run-setup";
import { getAppIconPath, getOutputsDir, resolveProjectRoot } from "./paths";

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let backend: PythonBackend | null = null;
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

function createWindow(apiBaseUrl: string): BrowserWindow {
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
    window.show();
  });

  installEditorContextMenu(window);

  const loadApp = async () => {
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      await window.loadFile(join(__dirname, "../renderer/index.html"));
    }
    if (!window.isDestroyed()) {
      window.webContents.send("studio:api-base-url", apiBaseUrl);
    }
  };

  window.webContents.on("did-finish-load", () => {
    if (!window.isDestroyed()) {
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
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
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

  ipcMain.on("studio:request-api-base-url", (event) => {
    if (backend) {
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

  // Preserve the data directory used by existing installations so an in-place
  // upgrade does not redownload the model or discard local preferences.
  if (app.isPackaged) {
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

  try {
    await resolveProjectRoot();
    // Development uses the repository's .venv directly. The first-run
    // installer only applies to packaged builds with runtime-release.zip.
    if (app.isPackaged) {
      await ensureFirstRunSetup();
    }
  } catch (error) {
    await dialog.showErrorBox(
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

  mainWindow = createWindow(pendingBaseUrl);

  void (async () => {
    try {
      await backend?.start();
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
      mainWindow = createWindow(backend.baseUrl);
    }
  });
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

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
