import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const model = { id: "gguf", name: "Local GGUF", format: "gguf", installed: true };
const threadId = "text-thread-load-model";
const draft = "Keep this text while the model loads.";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: {
    models: [model], ggufAvailable: true, supportsModelLoad: true, supportsModelUnload: true,
    supportsJobPolling: true, supportsPendingStop: true, job: { id: null, status: "idle" },
  },
  legacyTextWorkspace: { activeId: threadId, threads: [{ id: threadId, title: "Model load", draft, modelId: model.id, messages: [] }] },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const loads = [];
const stops = [];
let releaseAdmission;
const admission = new Promise((resolve) => { releaseAdmission = resolve; });

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.route("**/api/text/models/load", async (route) => {
    const request = route.request().postDataJSON();
    loads.push(request);
    const job = {
      id: request.requestId, threadId: request.threadId, modelId: request.modelId, modelLoad: true,
      status: "running", phase: "Loading model…", partialText: "", startedAt: Date.now() / 1000,
    };
    if (loads.length === 1) {
      await admission;
      return route.fulfill({ status: 202, json: { textJob: { ...job, status: "stopped", startedAt: null } } });
    }
    state.textStatus.job = job;
    return route.fulfill({ status: 202, json: { textJob: job } });
  });
  await page.route("**/api/text/stop", (route) => {
    const request = route.request().postDataJSON();
    stops.push(request);
    if (request.requestId === loads[0].requestId) return route.fulfill({ status: 202, json: { cancelledBeforeStart: true } });
    const job = { ...state.textStatus.job, status: "stopped", finishedAt: Date.now() / 1000, residentModel: null };
    state.textStatus.job = job;
    return route.fulfill({ status: 202, json: { textJob: job } });
  });
  await expect(composer).toHaveValue(draft);
  await button("Chat settings").click();
  const load = button("Load model");
  const loadPosition = await load.boundingBox();
  await load.click();
  await expect(button("Cancel model load")).toBeVisible();
  const cancelPosition = await button("Cancel load").boundingBox();
  assert(loadPosition && cancelPosition && Math.abs(loadPosition.y - cancelPosition.y) < 1);
  await expect.poll(() => loads.length).toBe(1);
  assert.equal(loads[0].threadId, threadId);
  assert.equal(loads[0].modelId, model.id);
  assert.equal(loads[0].contextSize, 8192);
  assert(!Object.hasOwn(loads[0], "messages"));
  await expect(page.getByRole("log").getByRole("article")).toHaveCount(0);
  await composer.fill(draft + " Keep writing.");
  await composer.press("Escape");
  await expect.poll(() => stops.length).toBe(1);
  assert.equal(stops[0].requestId, loads[0].requestId);
  assert.equal(stops[0].threadId, threadId);
  await expect(load).toBeEnabled();
  releaseAdmission();
  await expect(composer).toHaveValue(draft + " Keep writing.");
  await expect(page.getByRole("log").getByRole("article")).toHaveCount(0);

  await load.click();
  await expect(page.getByText("Loading model…", { exact: true }).and(page.getByRole("status"))).toBeVisible();
  await page.setViewportSize({ width: 720, height: 650 });
  await expect(composer).toBeHidden();
  await button("Cancel load").click();
  await expect(load).toBeEnabled();
  await expect(load).toBeFocused();
  assert.equal(stops[1].requestId, loads[1].requestId);
  await page.setViewportSize({ width: 1440, height: 900 });

  await load.click();
  await expect(button("Cancel model load")).toBeVisible();
  state.textStatus.job = { ...state.textStatus.job, status: "failed", error: "The model file could not be read.", finishedAt: Date.now() / 1000 };
  await expect(page.getByRole("alert")).toContainText("The model file could not be read.");
  await expect(load).toBeEnabled();
  await load.click();
  await expect(button("Cancel model load")).toBeVisible();
  const resident = { modelId: model.id, backend: "cpu", device: "CPU", gguf: { contextSize: 8192, loadOptions: {} } };
  state.textStatus.residentModel = resident;
  state.textStatus.job = { ...state.textStatus.job, status: "complete", residentModel: resident, finishedAt: Date.now() / 1000 };
  await expect(button("Unload model")).toBeEnabled();
  await expect(button("Manage models")).toBeFocused();
  await expect(page.getByRole("log").getByRole("article")).toHaveCount(0);
  await expect(composer).toHaveValue(draft + " Keep writing.");
  await expect.poll(async () => {
    const thread = (await savedTextWorkspace(page))?.threads.find((item) => item.id === threadId);
    return [thread?.draft, thread?.messages.length];
  }).toEqual([draft + " Keep writing.", 0]);
  assert.equal(state.textRequests.length, 0);

  await page.getByRole("spinbutton", { name: /^Context length/ }).fill("4096");
  await expect(button("Reload model")).toBeEnabled();
  await button("Reload model").click();
  await expect.poll(() => loads.length).toBe(5);
  assert.equal(loads[4].contextSize, 4096);
  assert.deepEqual(errors, []);
  console.log("Explicit model loads, cancellation, failure, reload settings, and draft preservation passed.");
} finally {
  releaseAdmission();
  await close();
}
