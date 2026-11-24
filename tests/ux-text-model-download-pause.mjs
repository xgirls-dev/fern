import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "river", name: "River 3B", format: "gguf", bytes: 2e9, installed: false };
const draft = "Keep my first chat draft.";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  legacyTextWorkspace: { activeId: "text-thread-paused-install", threads: [
    { id: "text-thread-paused-install", title: "First chat", draft, messages: [] },
  ] },
  textStatus: { models: [], recommendedModels: [model], defaultModelId: model.id, ggufAvailable: true,
    job: { id: null, status: "idle" } },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: model.name, exact: true }) });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
let installs = 0;
const pauseIds = [];
const setPhase = (status, phase) => {
  state.textStatus.modelInstall = { ...state.textStatus.modelInstall, status, phase };
};

try {
  await page.route("**/api/text/models/install", (route) => {
    assert.equal(route.request().postDataJSON().modelId, model.id);
    state.textStatus.modelInstall = { id: "install-" + (++installs), modelId: model.id,
      status: "downloading", phase: installs === 1 ? "Downloading weights…" : "Resuming weights…", error: null };
    return route.fulfill({ status: 202, json: state.textStatus });
  });
  await page.route("**/api/text/models/install/pause", (route) => {
    pauseIds.push(route.request().postDataJSON().jobId);
    setPhase("pausing", "Pausing download…");
    return route.fulfill({ status: 202, json: { modelInstall: state.textStatus.modelInstall } });
  });
  await expect(composer).toHaveValue(draft);
  await button("Browse models").click();
  await card.getByRole("button", { name: "Download", exact: true }).click();
  const pause = card.getByRole("button", { name: "Pause download", exact: true });
  await pause.press("Enter");
  const pausing = card.getByRole("button", { name: "Pausing…", exact: true });
  await expect(pausing).toBeDisabled();
  await expect(pausing).toBeFocused();
  await pausing.press("Enter");
  assert.deepEqual(pauseIds, ["install-1"]);
  await expect(card.getByRole("progressbar")).toBeVisible();

  setPhase("paused", "Download paused.");
  model.hasPartialDownload = true;
  const resume = card.getByRole("button", { name: "Resume download", exact: true });
  await expect(resume).toBeFocused();
  await expect(resume).toBeEnabled();
  await expect(card).toContainText("Downloaded files are kept");
  await expect(card.getByRole("progressbar")).toHaveCount(0);
  await button("Return to draft").click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(draft);
  await expect(button("Send message")).toBeDisabled();
  await expect(button("Resume model download")).toBeVisible();
  assert.equal(state.textRequests.length, 0);

  // A new backend process sees staged bytes even when its live install record is gone.
  state.textStatus.modelInstall = { id: null, status: "idle", phase: null, error: null };
  await page.reload();
  await expect(composer).toHaveValue(draft);
  await button("Browse models").click();
  await resume.click();
  await expect.poll(() => installs).toBe(2);
  await expect(card).toContainText("Resuming weights…");
  await expect(pause).toBeVisible();
  setPhase("preparing", "Preparing downloaded model files…");
  await expect(card).toContainText("Preparing downloaded model files…");
  await expect(pause).toHaveCount(0);
  await expect(resume).toHaveCount(0);
  model.installed = true;
  state.textStatus.models = [model];
  setPhase("complete", "Installed and verified.");
  await button("Use model in draft").click();
  await expect(composer).toHaveValue(draft);
  await expect(composer).toBeFocused();
  await expect(button("Send message")).toBeEnabled();
  assert.equal(state.textRequests.length, 0);
  assert.deepEqual(errors, []);
  console.log("Model setup preserves focus and drafts while pausing, resuming after reload, and preparing files.");
} finally {
  await close();
}
