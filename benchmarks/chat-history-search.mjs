import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "../tests/ui-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "renderer";
assert(["renderer", "electron"].includes(mode), "Choose renderer or electron.");
const executable = mode === "electron" ? process.env.FERN_E2E_EXECUTABLE : undefined;
const visible = mode === "electron" && process.env.FERN_E2E_VISIBLE === "1";
const runs = positiveInteger("FERN_BENCH_RUNS", 5);
const warmRuns = positiveInteger("FERN_BENCH_WARM_RUNS", 20);
const reopen = process.env.FERN_BENCH_SEARCH_REOPEN === "1";
const opener = process.env.FERN_BENCH_SEARCH_OPENER ?? "pointer";
const input = process.env.FERN_BENCH_SEARCH_INPUT ?? "fill";
assert(["pointer", "keyboard"].includes(opener), "Choose pointer or keyboard for FERN_BENCH_SEARCH_OPENER.");
assert(["fill", "keys"].includes(input), "Choose fill or keys for FERN_BENCH_SEARCH_INPUT.");
const activeId = "text-thread-search-0";
const retainedDraft = "Keep this unsent draft.";
const queries = [
  { chat: 41, row: 25, phrase: "obsidian violet marker" },
  { chat: 79, row: 25, phrase: "ultramarine signal card" },
];

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer.`);
  return value;
}

function title(chat) {
  return `Workshop ${String(chat).padStart(3, "0")}`;
}

const threads = Array.from({ length: 100 }, (_, chat) => ({
  id: `text-thread-search-${chat}`, modelId: "local", title: title(chat), updatedAt: chat + 1,
  draft: chat === 0 ? retainedDraft : "",
  messages: chat === 0 ? [] : Array.from({ length: 32 }, (_, row) => {
    const match = queries.find((query) => query.chat === chat && query.row === row);
    return {
      id: `message-${chat}-${row}`, role: row % 2 ? "assistant" : "user", createdAt: row + 1,
      content: row % 2 ? [
        `## Layout ${chat}.${row}`,
        "Use **numbered samples** for this iteration. The reference [checklist](https://example.com) has the full sequence.",
        "- Compare the outer dimensions and finished weight.",
        "- Use a dry brush first, then check the measurements again.",
        "| Material | Count |\n| --- | --- |\n| *Cotton* | 12 |\n| Nylon | 18 |",
        match ? `The **${match.phrase.replace(" ", "** ")} is the original.` : "",
      ].join("\n\n") : "Summarize the notes and include a table.",
    };
  }),
}));
const workspace = { activeId, threads };

async function openRenderer() {
  return fixture({
    builtRenderer: true, firstRun: true, legacyTextWorkspace: workspace,
    platform: process.platform, viewport: { width: 1440, height: 920 },
    textStatus: {
      models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }],
      ggufAvailable: true, job: { id: null, status: "idle" },
    },
  });
}

async function openElectron(scratch) {
  const data = path.join(scratch, "data");
  const env = {
    ...process.env, FERN_ROOT: data, INTEL_IRIS_ROOT: data, FERN_E2E_HEADLESS: visible ? "0" : "1",
    FERN_TEXT_MODEL_REGISTRY: path.join(scratch, "text-models.json"),
    FERN_CUSTOM_IMAGE_REGISTRY: path.join(scratch, "image-models.json"),
    HF_HOME: path.join(scratch, "huggingface"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: [
      ...(executable ? [] : [path.join(root, "apps", "desktop", "out", "main", "index.js")]),
      `--user-data-dir=${path.join(scratch, "profile")}`,
    ],
    env, cwd: root, timeout: 180_000,
  });
  try {
    let page;
    await expect.poll(async () => {
      for (const window of app.windows()) {
        if (await window.evaluate(() => typeof window.studio?.getApiBaseUrl === "function").catch(() => false)) {
          page = window;
          return true;
        }
      }
      return false;
    }, { timeout: 180_000 }).toBe(true);
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), Boolean(executable));
    await (await app.browserWindow(page)).evaluate((window) => window.webContents.setBackgroundThrottling(false));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const api = await page.evaluate(() => window.studio.getApiBaseUrl());
    await expect.poll(() => fetch(`${api}/api/health`).then((response) => response.ok, () => false), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => savedTextWorkspace(page).then(() => true, () => false)).toBe(true);
    await savedTextWorkspace(page, workspace);
    await page.reload();
    return { page, errors, close: () => app.close() };
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

async function measure(field, query) {
  // Browser timestamps sample paint opportunities from the first input event.
  await field.evaluate((input, { expectedTitle, phrase }) => {
    const list = document.querySelector(".thread-browser-list");
    window.fernHistoryMeasurement = new Promise((resolve) => {
      let frame;
      let start;
      let enteredAt;
      let lastFrame;
      let firstFrameMs;
      let firstResultFrameMs;
      let maxFrameGapMs = 0;
      const cleanup = () => input.removeEventListener("input", onInput, true);
      const timeout = setTimeout(() => {
        cleanup();
        cancelAnimationFrame(frame);
        resolve({ error: `Timed out waiting for ${expectedTitle}` });
      }, 30_000);
      const tick = () => {
        const now = performance.now();
        firstFrameMs ??= now - start;
        maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame);
        lastFrame = now;
        if (enteredAt !== undefined) {
          const found = Array.from(list.querySelectorAll(".thread-browser-open strong"))
            .some((element) => element.textContent === expectedTitle);
          if (found) {
            firstResultFrameMs ??= now - start;
            if (!list.querySelector(".thread-browser-empty[role=status]")) {
              clearTimeout(timeout);
              cleanup();
              resolve({ firstFrameMs, firstResultFrameMs, completeFrameMs: now - start, maxFrameGapMs,
                enterQueryMs: enteredAt - start, completeAfterQueryMs: now - enteredAt });
              return;
            }
          }
        }
        frame = requestAnimationFrame(tick);
      };
      const onInput = () => {
        const now = performance.now();
        if (input.value === phrase) enteredAt = now;
        if (start === undefined) {
          start = lastFrame = now;
          frame = requestAnimationFrame(tick);
        }
      };
      input.addEventListener("input", onInput, true);
    });
  }, { expectedTitle: title(query.chat), phrase: query.phrase });
  if (input === "keys") await field.pressSequentially(query.phrase);
  else await field.fill(query.phrase);
  const sample = await field.page().evaluate(() => window.fernHistoryMeasurement);
  assert(!sample.error, sample.error);
  return sample;
}

function summarize(samples) {
  return Object.fromEntries(Object.keys(samples[0]).map((key) => {
    const sorted = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
    return [key, { median, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) }];
  }));
}

const revision = process.env.FERN_BENCH_REVISION || (
  !executable ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() : null
);
const startedAt = new Date().toISOString();
const cold = [];
const warm = [];
let userAgent;
const scratch = await mkdtemp(path.join(os.tmpdir(), "fern-history-bench-"));
try {
  for (let run = 0; run < runs; run += 1) {
    const { page, errors, close } = mode === "renderer" ? await openRenderer() : await openElectron(path.join(scratch, String(run)));
    try {
      userAgent ??= await page.evaluate(() => navigator.userAgent);
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(retainedDraft);
      const openSearch = page.getByRole("button", { name: "Search threads", exact: true });
      const open = () => opener === "keyboard" ? openSearch.press("Enter") : openSearch.click();
      await open();
      const field = page.getByRole("searchbox", { name: "Find a thread", exact: true });
      await expect(field).toBeFocused();
      cold.push(await measure(field, queries[0]));
      for (let index = 0; index < warmRuns; index += 1) {
        if (reopen) {
          await field.press("Escape");
          await expect(field).toHaveCount(0);
          await open();
        }
        await expect(field).toBeFocused();
        if (!reopen && input === "keys") await field.press("ControlOrMeta+a");
        warm.push(await measure(field, queries[(index + 1) % queries.length]));
      }
      const lastQuery = queries[warmRuns % queries.length];
      await field.press("Enter");
      await expect(page.getByRole("searchbox", { name: "Search this chat" })).toHaveValue(lastQuery.phrase);
      await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get("fern-chat-find") ?? [])][0]?.toString()))
        .toBe(lastQuery.phrase);
      assert.deepEqual(errors, []);
      console.error(`Completed history search run ${run + 1}/${runs}`);
    } finally {
      await close();
    }
  }
  console.log(JSON.stringify({
    mode: mode === "renderer" ? mode : executable ? "packaged-electron" : "built-electron",
    revision, startedAt, visible, userAgent, opener, input, reopen,
    host: { os: os.version(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.availableParallelism(), memoryBytes: os.totalmem() },
    fixture: { threads: threads.length, messages: threads.reduce((count, thread) => count + thread.messages.length, 0) },
    summary: { cold: summarize(cold), warm: summarize(warm) }, cold, warm,
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
