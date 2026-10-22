import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  root: resolve(desktopRoot, "src/renderer"),
  plugins: [react()],
  build: {
    outDir: resolve(desktopRoot, "../../.cache/fern-browser-test-dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(desktopRoot, "src/renderer/browser-test.html"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      allow: [resolve(desktopRoot, "../..")],
    },
  },
});
