import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const documents = [
  "Workshop planning and roundtable facilitation notes.pdf",
  "Speaker schedule and volunteer handover notes.pdf",
  "Room changes and accessibility requirements.pdf",
  "List of tables and workshop equipment.pdf",
  "Workshop registration and travel schedule.pdf",
  "Discussion topics and project references.pdf",
  "Agenda revision and decision log.pdf",
  "Equipment inventory and power supply logistics.pdf",
].map((name, index) => ({ id: "doc-" + String(index).repeat(64), bytes: 2048, name }));
const model = { id: "local", name: "Gemma 4 E4B Instruct", format: "gguf", supportsReasoning: true, installed: true };
const activeId = "text-thread-workshop";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  viewport: { width: 800, height: 520 },
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId, threads: [
    { id: activeId, title: "Workshop draft", modelId: model.id, messages: [] },
    { id: "text-thread-program", title: "Program review", modelId: model.id, documents, messages: [
      { id: "program-prompt", role: "user", content: "Review the workshop program.", createdAt: 100 },
      { id: "program-reply", role: "assistant", content: "The draft starts with a welcome and ends with closing questions.", createdAt: 101 },
    ] },
  ] },
});
const right = page.getByRole("region", { name: "Right chat", exact: true });
const field = right.getByRole("textbox", { name: "Message", exact: true });
const files = right.getByRole("list", { name: "Chat documents", exact: true });
const button = (name, root = page) => root.getByRole("button", { name, exact: true });
const partial = "Start by confirming the equipment list and reserving a room for breakout groups. Check that the room can accommodate every group.";
const draft = Array.from({ length: 15 }, (_, index) =>
  `${index + 1}. Confirm the room schedule and the supplies for this part of the workshop.`).join("\n");

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await button("Open split chat").click();
  await page.getByRole("dialog", { name: "Choose a chat", exact: true }).getByRole("button", { name: /^Program review/ }).click();
  await expect(files.getByRole("listitem")).toHaveCount(8);
  await field.fill("What still needs to be prepared?");
  await button("Send message", right).click();
  const live = right.getByRole("article", { name: "Response in progress", exact: true });
  await expect(live).toContainText("Loading model…");
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…", partialText: partial };
  const reply = live.getByText(partial, { exact: true });
  await expect(reply).toBeVisible();
  await field.fill(draft);

  const stop = button("Stop generation", right);
  await expect(stop).toBeEnabled();
  await expect.poll(() => stop.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return hit === element || element.contains(hit);
  })).toBe(true);
  await expect(reply).toBeInViewport({ ratio: 1 });
  await expect(live.getByText(model.name, { exact: true })).toBeInViewport({ ratio: 1 });
  await stop.click();
  await expect(right.getByText("Stopped · Partial response", { exact: true })).toBeVisible();
  await expect(right.getByText(partial, { exact: true })).toBeInViewport();
  await expect(field).toHaveValue(draft);

  const remove = files.getByRole("button", { name: /^Remove / });
  await remove.first().focus();
  for (let index = 1; index < documents.length; index += 1) await page.keyboard.press("Tab");
  await expect(remove.last()).toBeFocused();
  await expect(remove.last()).toBeInViewport({ ratio: 1 });
  await expect.poll(() => files.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  assert.deepEqual(errors, []);
  console.log("The live reply, Stop, multiline draft, and eight document controls fit the minimum split chat.");
} finally {
  await close();
}
