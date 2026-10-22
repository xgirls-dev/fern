import { createRoot } from "react-dom/client";
import type { StudioApi, ThemeMode } from "../../preload/types";
import "./styles/globals.css";
import "./styles/studio.css";

const query = new URLSearchParams(window.location.search);
const apiBaseUrl = (
  query.get("api") || localStorage.getItem("fern-browser-test-api") || ""
).replace(/\/$/, "");
const selectedCustomImageFolder = query.get("customImageFolder");

if (!apiBaseUrl) {
  document.querySelector<HTMLElement>("#root")!.innerHTML =
    '<main style="padding:32px;font:14px system-ui"><h1>Fern browser test</h1><p>Provide the local Fern API URL in the <code>api</code> query parameter.</p><p>Example: <code>?api=http://127.0.0.1:18743</code></p></main>';
  throw new Error("Missing API URL for the Fern browser test harness.");
}

localStorage.setItem("fern-browser-test-api", apiBaseUrl);

const backendErrorListeners = new Set<(message: string) => void>();
const themeListeners = new Set<(theme: "light" | "dark") => void>();
let selectedTheme: "light" | "dark" =
  localStorage.getItem("fern-browser-test-theme") === "light" ? "light" : "dark";
let browserZoom = 1;

const resolveTheme = (theme: ThemeMode): "light" | "dark" =>
  theme === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : theme;

const browserStudio: StudioApi = {
  platform: "linux",
  getApiBaseUrl: async () => apiBaseUrl,
  adjustZoom: async (action) => {
    browserZoom = action === "reset"
      ? 1
      : Math.max(0.7, Math.min(1.5, browserZoom + (action === "in" ? 0.1 : -0.1)));
    document.documentElement.style.zoom = String(browserZoom);
    return browserZoom;
  },
  onApiBaseUrl: (listener) => {
    listener(apiBaseUrl);
    return () => undefined;
  },
  onBackendError: (listener) => {
    backendErrorListeners.add(listener);
    return () => backendErrorListeners.delete(listener);
  },
  getTheme: async () => selectedTheme,
  setTheme: async (theme) => {
    selectedTheme = resolveTheme(theme);
    localStorage.setItem("fern-browser-test-theme", selectedTheme);
    themeListeners.forEach((listener) => listener(selectedTheme));
    return selectedTheme;
  },
  onThemeChanged: (listener) => {
    themeListeners.add(listener);
    return () => themeListeners.delete(listener);
  },
  minimizeWindow: async () => undefined,
  toggleMaximizeWindow: async () => false,
  closeWindow: async () => undefined,
  openOutputsFolder: async () => "",
  openPath: async () => "",
  openOutputImage: async () => "",
  deleteOutputImage: async () => undefined,
  openOutputAudio: async () => "",
  revealOutputAudio: async () => undefined,
  deleteOutputAudio: async () => undefined,
  saveOutputAudio: async () => null,
  showImageInFolder: async () => undefined,
  pickReferenceImage: async () => null,
  pickTextModelFolder: async () => null,
  pickCustomImageModelFolder: async () => selectedCustomImageFolder,
  saveImageAs: async () => null,
  writeImageFile: async () => "",
  copyText: async (text) => {
    await navigator.clipboard.writeText(text);
  },
  readFileAsDataUrl: async () => "",
  clearWebCache: async () => undefined,
};

Object.defineProperty(window, "studio", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: browserStudio,
});
document.documentElement.dataset.platform = browserStudio.platform;
document.documentElement.dataset.browserTest = "true";

void import("./App")
  .then(({ App }) => {
    createRoot(document.getElementById("root")!).render(<App />);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    document.querySelector<HTMLElement>("#root")!.innerHTML =
      `<main role="alert" style="padding:32px;font:14px system-ui"><h1>Fern browser test failed to load</h1><pre></pre></main>`;
    document.querySelector<HTMLElement>("#root pre")!.textContent = message;
  });
