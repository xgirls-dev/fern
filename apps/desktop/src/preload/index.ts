import { contextBridge, ipcRenderer } from "electron";
import type { StudioApi } from "./types";

let cachedApiBaseUrl: string | null = null;
let cachedBackendError: string | null = null;
const apiUrlWaiters = new Set<(url: string) => void>();
const backendErrorListeners = new Set<(message: string) => void>();

ipcRenderer.on("studio:api-base-url", (_event, url: string) => {
  cachedApiBaseUrl = url;
  for (const resolve of apiUrlWaiters) {
    resolve(url);
  }
  apiUrlWaiters.clear();
});

ipcRenderer.on("studio:backend-error", (_event, message: string) => {
  cachedBackendError = message;
  for (const listener of backendErrorListeners) {
    listener(message);
  }
});

function waitForApiBaseUrl(timeoutMs = 90_000): Promise<string> {
  if (cachedApiBaseUrl) {
    return Promise.resolve(cachedApiBaseUrl);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      apiUrlWaiters.delete(resolve);
      reject(new Error("Timed out waiting for the OpenVINO backend."));
    }, timeoutMs);

    apiUrlWaiters.add((url) => {
      clearTimeout(timer);
      resolve(url);
    });

    ipcRenderer.send("studio:request-api-base-url");
  });
}

const studioApi: StudioApi = {
  platform: process.platform,
  getApiBaseUrl: () => waitForApiBaseUrl(),

  onApiBaseUrl: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) =>
      listener(url);
    ipcRenderer.on("studio:api-base-url", handler);
    if (cachedApiBaseUrl) {
      listener(cachedApiBaseUrl);
    }
    return () => ipcRenderer.off("studio:api-base-url", handler);
  },

  onBackendError: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) =>
      listener(message);
    ipcRenderer.on("studio:backend-error", handler);
    if (cachedBackendError) {
      listener(cachedBackendError);
    }
    return () => ipcRenderer.off("studio:backend-error", handler);
  },

  getTheme: () => ipcRenderer.invoke("studio:get-theme"),
  setTheme: (theme) => ipcRenderer.invoke("studio:set-theme", theme),
  onThemeChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      theme: "light" | "dark",
    ) => listener(theme);
    ipcRenderer.on("studio:theme-changed", handler);
    return () => ipcRenderer.off("studio:theme-changed", handler);
  },

  minimizeWindow: () => ipcRenderer.invoke("studio:window-minimize"),
  toggleMaximizeWindow: () =>
    ipcRenderer.invoke("studio:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("studio:window-close"),

  openOutputsFolder: () => ipcRenderer.invoke("studio:open-outputs-folder"),
  openPath: (filePath) => ipcRenderer.invoke("studio:open-path", filePath),
  openOutputImage: (imageName) =>
    ipcRenderer.invoke("studio:open-output-image", imageName),
  deleteOutputImage: (imageName) =>
    ipcRenderer.invoke("studio:delete-output-image", imageName),
  showImageInFolder: (filePath) =>
    ipcRenderer.invoke("studio:show-image-in-folder", filePath),
  pickReferenceImage: () => ipcRenderer.invoke("studio:pick-reference-image"),
  saveImageAs: (defaultName) =>
    ipcRenderer.invoke("studio:save-image-as", defaultName),
  writeImageFile: (targetPath, sourceUrl) =>
    ipcRenderer.invoke("studio:write-image-file", targetPath, sourceUrl),
  copyText: (text) => ipcRenderer.invoke("studio:copy-text", text),
  readFileAsDataUrl: (filePath) =>
    ipcRenderer.invoke("studio:read-file-as-data-url", filePath),
  clearWebCache: () => ipcRenderer.invoke("studio:clear-web-cache"),
};

contextBridge.exposeInMainWorld("studio", studioApi);
