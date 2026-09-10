import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const { createServer } = await import("vite");
const server = process.env.FERN_UI_URL
  ? null
  : await createServer({
      configFile: false,
      root: fileURLToPath(
        new URL("../apps/desktop/src/renderer", import.meta.url),
      ),
      server: { host: "127.0.0.1", port: 0 },
    });
await server?.listen();
const previewUrl = process.env.FERN_UI_URL || server.resolvedUrls.local[0];
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
  viewport: { width: 1440, height: 920 },
  reducedMotion: "reduce",
});
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const screenshots =
  process.env.FERN_UI_SCREENSHOTS || "artifacts/ux-verification/navigation";
await mkdir(screenshots, { recursive: true });
const settings = {
  prompt: "Architectural study",
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
const threads = ["Architecture", "Portrait", "Landscape"].map((title, i) => ({
  id: `thread-${i}`,
  title,
  renamed: true,
  updatedAt: 3 - i,
  settings: { ...settings, prompt: title },
  previewName: null,
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
      },
      { get: (object, key) => object[key] ?? (async () => null) },
    );
    if (!localStorage.getItem("fern-threads:v1"))
      localStorage.setItem(
        "fern-threads:v1",
        JSON.stringify({ activeId: threads[0].id, threads }),
      );
  },
  { threads },
);
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#c9c2b5"/><rect x="240" y="100" width="500" height="800" fill="#f1ede5"/></svg>';
let images = [0, 1, 2].map((i) => ({
  name: `image-${i}.svg`,
  threadId: "thread-0",
  url: "data:image/svg+xml," + encodeURIComponent(svg),
  mtime: i + 1,
  width: 1024,
  height: 1024,
  prompt: "Architectural study",
  seed: i,
}));
let job = {
  id: "job",
  threadId: "thread-0",
  status: "idle",
  logs: [],
  startedAt: null,
  finishedAt: null,
  output: null,
  error: null,
};
let stops = 0;
const model = {
  runtimeReady: true,
  selectedDevice: "CPU",
  runtimeBackend: "OpenVINO",
  supportsReferenceImage: true,
  adapters: [{ id: "CPU", label: "CPU", available: true, runtimeReady: true }],
};
await page.route("**/api/flux2/status*", (r) =>
  r.fulfill({
    json: {
      job,
      images,
      model,
      runtime: { status: "ready", message: "Ready", logs: [] },
      defaults: {
        device: "CPU",
        width: 1024,
        height: 1024,
        steps: 4,
        guidance: 1,
      },
    },
  }),
);
await page.route("**/api/threads/delete", (r) => {
  const id = r.request().postDataJSON().thread_id;
  const deleted = images
    .filter((image) => image.threadId === id)
    .map((image) => image.name);
  images = images.filter((image) => image.threadId !== id);
  return r.fulfill({ json: { deleted } });
});
await page.route("**/api/flux2/stop", (r) => {
  stops++;
  job = { ...job, status: "cancelled" };
  return r.fulfill({ json: { ok: true } });
});
const thread = (name) => page.getByRole("button", { name, exact: true });
const rename = (name) =>
  page.getByRole("button", { name: `Rename thread ${name}`, exact: true });
const remove = (name) =>
  page.getByRole("button", { name: `Delete thread ${name}`, exact: true });
try {
  await page.goto(previewUrl);
  await page.locator(".stage-image").waitFor();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await thread("Toggle theme").click();
    for (const width of [1440, 1080]) {
      await page.setViewportSize({ width, height: width === 1440 ? 920 : 720 });
      await page.mouse.move(width - 10, 300);
      await page.locator("#prompt").focus();
      await page.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector('[aria-label="Delete thread Portrait"]'),
          ).opacity === "0",
      );
      const rows = await page.locator(".sidebar-thread-row").evaluateAll((es) =>
        es.map((e) => {
          const b = e.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom };
        }),
      );
      assert(
        rows[1].top - rows[0].bottom >= 4,
        "Thread rows must have a visible gap",
      );
      const header = await page.locator(".workspace-header").boundingBox();
      const tab = await thread("Preview").boundingBox();
      assert(
        tab.y - header.y - header.height >= 10,
        "View tabs must be inset from the header",
      );
      await thread("Portrait").hover();
      await page.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector('[aria-label="Delete thread Portrait"]'),
          ).opacity === "1",
      );
      const action = await remove("Portrait").boundingBox();
      assert(action.width >= 24 && action.height >= 24);
      await page.screenshot({
        path: `${screenshots}/${theme}-${width}-hover.png`,
        animations: "disabled",
      });
      await thread("Portrait").focus();
      await page.mouse.move(width - 10, 300);
      await page.keyboard.press("Tab");
      assert(
        await rename("Portrait").evaluate((e) => e === document.activeElement),
      );
      await page.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector('[aria-label="Rename thread Portrait"]'),
          ).opacity === "1",
      );
      assert.notEqual(
        await rename("Portrait").evaluate(
          (e) => getComputedStyle(e).outlineStyle,
        ),
        "none",
      );
      await page.keyboard.press("Tab");
      assert(
        await thread("Archive thread Portrait").evaluate(
          (e) => e === document.activeElement,
        ),
      );
      await page.keyboard.press("Tab");
      assert(
        await remove("Portrait").evaluate((e) => e === document.activeElement),
      );
    }
  }
  await rename("Portrait").click();
  await page.getByRole("textbox", { name: "Thread name" }).fill("Do not save");
  await page.keyboard.press("Escape");
  assert(await thread("Portrait").isVisible());
  assert.equal(await thread("Do not save").count(), 0);
  await rename("Portrait").click();
  await page
    .getByRole("textbox", { name: "Thread name" })
    .fill("Portrait revised");
  await page.keyboard.press("Enter");
  assert(await thread("Portrait revised").isVisible());
  await thread("Portrait revised").hover();
  await remove("Portrait revised").click();
  assert(await thread("Cancel").evaluate((e) => e === document.activeElement));
  await page.screenshot({
    path: `${screenshots}/delete-confirm.png`,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  assert(await thread("Portrait revised").isVisible());
  await thread("Portrait revised").hover();
  await remove("Portrait revised").click();
  await thread("Delete thread").click();
  await page.locator(".thread-delete-confirm").waitFor({ state: "detached" });
  assert.equal(await thread("Portrait revised").count(), 0);
  assert.equal(
    await page.locator("#prompt").inputValue(),
    "Architecture",
    "Deleting an inactive thread preserves the active draft",
  );
  await page.reload();
  await page.locator("#prompt").waitFor();
  assert.equal(await thread("Portrait revised").count(), 0);
  job = { ...job, status: "running", startedAt: Date.now() / 1000 - 30 };
  await page.locator(".generation-stop").waitFor();
  await thread("Architecture").hover();
  assert(await remove("Architecture").isDisabled());
  await thread("Stop generation").click();
  await page.waitForFunction(() => !document.querySelector(".generation-stop"));
  assert.equal(stops, 1);
  await thread("Architecture").hover();
  await remove("Architecture").click();
  await thread("Delete thread").click();
  await page.locator(".thread-delete-confirm").waitFor({ state: "detached" });
  assert.equal(await page.locator("#prompt").inputValue(), "Landscape");
  await thread("Library").click();
  assert.equal(
    await page.locator(".thumb").count(),
    0,
    "Thread deletion removes generated images",
  );
  await thread("Landscape").click();
  await thread("Landscape").hover();
  await remove("Landscape").click();
  await thread("Delete thread").click();
  await page.locator(".thread-delete-confirm").waitFor({ state: "detached" });
  assert.equal(await page.locator(".sidebar-thread-button").count(), 1);
  assert.equal(await page.locator("#prompt").inputValue(), "");
  await page.reload();
  await page.locator("#prompt").waitFor();
  assert.equal(await page.locator(".sidebar-thread-button").count(), 1);
  await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem("fern-threads:v1"));
    const t = value.threads[0];
    value.threads = Array.from({ length: 45 }, (_, i) => ({
      ...t,
      id: `long-${i}`,
      title: `A very long thread title with useful context ${i}`,
      updatedAt: 45 - i,
    }));
    value.activeId = "long-0";
    localStorage.setItem("fern-threads:v1", JSON.stringify(value));
  });
  await page.reload();
  await page.locator("#prompt").waitFor();
  assert(
    await page
      .locator(".sidebar-threads")
      .evaluate((e) => e.scrollHeight > e.clientHeight),
  );
  await page.locator(".sidebar-thread-button").last().focus();
  const footer = await thread("Preferences").boundingBox();
  assert(
    footer.y + footer.height <= 720,
    "Long lists cannot push navigation offscreen",
  );
  await page.screenshot({
    path: `${screenshots}/long-list-keyboard.png`,
    animations: "disabled",
  });
  await thread("Preferences").click();
  assert.equal(await page.locator("[role=dialog]").count(), 0);
  await thread("Collapse sidebar").click();
  await thread("Expand sidebar").click();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: spacing geometry; hover and keyboard action visibility; rename save/cancel; delete cancel/inactive/active/last/reload; running protection; owned images deleted; 45-thread scroll/focus; preferences and sidebar navigation; both themes and desktop sizes.",
  );
} finally {
  await browser.close();
  await server?.close();
}
