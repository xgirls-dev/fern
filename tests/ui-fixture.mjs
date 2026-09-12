import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export async function fixture({ imageCount = 3, threadCount = 1 } = {}) {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(
      new URL("../apps/desktop/src/renderer", import.meta.url),
    ),
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const { chromium } = await import(
    process.env.FERN_PLAYWRIGHT_MODULE || "playwright"
  );
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.FERN_CHROME_PATH
      ? { executablePath: process.env.FERN_CHROME_PATH }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const settings = {
    prompt: "Original unfinished draft",
    device: "AUTO",
    width: 1024,
    height: 1024,
    steps: 4,
    guidance: 1,
    seed: 42,
    batchSize: 1,
    seedLocked: true,
    theme: "light",
  };
  const threads = Array.from({ length: threadCount }, (_, i) => ({
    id: i ? `thread-${i}` : "study",
    title: i ? `Study number ${i}` : "Stable title",
    renamed: false,
    updatedAt: threadCount - i,
    settings,
    previewName: "audit-1.png",
    imageNames: [],
    referenceLabel: "",
  }));
  await page.addInitScript(
    ({ threads }) => {
      window.studio = new Proxy(
        {
          platform: "win32",
          getApiBaseUrl: async () => location.origin,
          onApiBaseUrl: () => () => {},
          onBackendError: () => () => {},
          onThemeChanged: () => () => {},
          copyText: async () => {},
          openOutputImage: async () => "",
          openOutputsFolder: async () => "",
          deleteOutputImage: async (name) => {
            await fetch("/fixture/delete", { method: "POST", body: name });
          },
        },
        { get: (o, k) => o[k] ?? (async () => null) },
      );
      if (!localStorage.getItem("fern-threads:v1"))
        localStorage.setItem(
          "fern-threads:v1",
          JSON.stringify({ activeId: "study", threads }),
        );
    },
    { threads },
  );
  const svg =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1088"><rect width="1920" height="1088" fill="#bac7b8"/><circle cx="960" cy="460" r="300" fill="#48624f"/><text x="600" y="920" font-size="64">VERIFICATION FIXTURE</text></svg>',
    );
  const state = {
    job: { id: null, threadId: null, status: "idle", logs: [], output: null },
    runtime: { status: "ready", message: "Ready", logs: [] },
    images: Array.from({ length: imageCount }, (_, i) => ({
      name: `audit-${i + 1}.png`,
      url: svg,
      mtime: i + 1,
      threadId: "study",
      prompt: `Original image prompt ${i + 1}`,
      referenceUsed: false,
      seed: i,
      width: 1920,
      height: 1088,
      steps: 4,
      guidance: 1,
      generationTime: 65,
      device: "CPU",
    })),
    installedModels: [{ id: "9b", label: "Klein 9B" }],
    payloads: [],
    imageListings: 0,
    statusCalls: 0,
  };
  await page.route("**/api/threads/delete", (r) => {
    const payload = r.request().postDataJSON();
    const deleted = state.images
      .filter((image) => image.threadId === payload.thread_id)
      .map((image) => image.name);
    state.images = state.images.filter(
      (image) => !deleted.includes(image.name),
    );
    return r.fulfill({ json: { deleted } });
  });
  await page.route("**/api/flux2/stop", (r) => {
    state.job = { ...state.job, status: "cancelled" };
    return r.fulfill({ json: { job: state.job } });
  });
  await page.route("**/fixture/delete", (r) => {
    state.images = state.images.filter(
      (i) => i.name !== r.request().postData(),
    );
    return r.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/flux2/status*", (r) => {
    const include =
      new URL(r.request().url()).searchParams.get("images") !== "0";
    state.statusCalls++;
    if (include) state.imageListings++;
    return r.fulfill({
      json: {
        job: state.job,
        images: include ? state.images : null,
        runtime: state.runtime,
        installedModels: state.installedModels,
        model: {
          runtimeReady: state.modelReady ?? true,
          selectedDevice: "CPU",
          runtimeBackend: "OpenVINO",
          supportsReferenceImage: true,
          adapters: [
            { id: "CPU", label: "CPU", available: true, runtimeReady: true },
            {
              id: "NVIDIA_GPU",
              label: "NVIDIA GPU",
              available: false,
              note: "A long runtime explanation that must not be in the option.",
            },
          ],
        },
        defaults: {
          device: "CPU",
          width: 1024,
          height: 1024,
          steps: 4,
          guidance: 1,
        },
      },
    });
  });
  await page.route("**/api/flux2/generate", (r) => {
    state.payloads.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true } });
  });
  const dir = process.env.FERN_UI_SCREENSHOTS || "artifacts/ux-verification";
  await mkdir(dir, { recursive: true });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator("#prompt").waitFor();
  return {
    page,
    state,
    errors,
    dir,
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}
