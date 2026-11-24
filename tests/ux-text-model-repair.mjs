import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "local-river", name: "River 3B", format: "gguf", ownership: "managed", installed: false,
  error: "The vision projector is missing." };
const target = { id: "river", name: model.name, format: "gguf", bytes: 2e9, minimumFreeBytes: 2_536_870_912,
  installed: false, repairModelId: model.id };
const recommended = { id: "spur", name: "Spur 1B", bytes: 1e9, format: "gguf", installed: false };
const draft = "Keep this follow-up exactly as written.";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: { models: [model], recommendedModels: [recommended, target], defaultModelId: recommended.id,
    ggufAvailable: true, job: { status: "idle", id: null } },
  legacyTextWorkspace: { activeId: "text-thread-broken-model", threads: [
    { id: "text-thread-broken-model", title: "Existing chat", modelId: model.id, draft, messages: [
      { id: "user", role: "user", content: "My last question", createdAt: 1 },
      { id: "model", role: "assistant", content: "The saved answer.", createdAt: 2 },
    ] },
  ] },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: model.name, exact: true }) });
const calls = [];

try {
  await page.route("**/api/text/models/install", (route) => {
    calls.push(route.request().postDataJSON());
    state.textStatus.modelInstall = { id: `repair-${calls.length}`, modelId: target.id, operation: "repair",
      status: "downloading", phase: "Checking downloaded files…", error: null };
    return route.fulfill({ status: 202, json: state.textStatus });
  });
  await expect(composer).toHaveValue(draft);
  await expect(page.getByText(model.error, { exact: true })).toBeVisible();
  await button("Repair model").click();
  const setup = page.getByRole("region", { name: "Draft setup" });
  await expect(setup).toContainText("River 3B · Needs repair");
  await expect(card).toContainText("Current chat");
  await card.getByRole("button", { name: "Repair model", exact: true }).click();
  await expect(card.getByRole("button", { name: "Pause repair", exact: true })).toBeVisible();
  await button("Return to draft").click();
  await expect(composer).toHaveValue(draft);
  await expect(button("View model repair")).toBeVisible();
  await expect(button("Send message")).toBeDisabled();

  Object.assign(state.textStatus.modelInstall, { status: "failed", phase: null, error: "Checksum verification failed." });
  target.hasPartialDownload = true;
  await expect(page.locator(".text-model-readiness")).toContainText("Model repair failed.");
  await button("Open model setup").click();
  await expect(card.getByRole("alert")).toContainText("Checksum verification failed.");
  await card.getByRole("button", { name: "Resume repair", exact: true }).click();
  await expect.poll(() => calls).toEqual([{ modelId: target.id, repair: true }, { modelId: target.id, repair: true }]);

  state.textStatus.models = [{ ...model, installed: true, error: null }];
  state.textStatus.recommendedModels = [recommended, { ...target, installed: true, hasPartialDownload: false }];
  Object.assign(state.textStatus.modelInstall, { status: "complete", phase: "Repaired and verified." });
  await expect(card.getByRole("status")).toHaveText("Ready to load");
  await expect(card.getByText("Repaired and verified.", { exact: true })).toBeVisible();
  await button("Use model in draft").click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(draft);
  await expect(page.getByText("The saved answer.", { exact: true })).toBeVisible();
  await expect(button("Text model: River 3B")).toBeVisible();
  assert.equal(state.textRequests.length, 0);
  await button("Send message").click();
  await expect.poll(() => state.textRequests.at(-1)?.modelId).toBe(model.id);
  assert.deepEqual(errors, []);
  console.log("A failed repair can be retried from chat. The repaired model keeps its identity, saved reply, and draft.");
} finally {
  await close();
}
