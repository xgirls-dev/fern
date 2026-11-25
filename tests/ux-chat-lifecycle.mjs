import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const captureScreens = process.env.FERN_CHAT_LIFECYCLE_SCREENSHOTS === "1";
const model = { id: "local", name: "Local model", format: "gguf", installed: true };
const { page, state, dir, errors, close } = await fixture({
  firstRun: true,
  viewport: { width: 1440, height: 920 },
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: "text-thread-lifecycle", threads: [
    { id: "text-thread-lifecycle", title: "Workshop plan", renamed: true, modelId: model.id, messages: [] },
    { id: "text-thread-handbook", title: "Handbook", modelId: model.id, messages: Array.from({ length: 26 }, (_, index) => ({
      id: "handbook-" + index, role: index % 2 ? "assistant" : "user",
      content: "Workshop handbook note " + (index + 1) + ".", createdAt: index + 1,
    })) },
  ] },
});
const button = (name, root = page) => root.getByRole("button", { name, exact: true });
const composer = (root = page) => root.getByRole("textbox", { name: "Message", exact: true });
const live = (root = page) => root.getByRole("article", { name: "Response in progress", exact: true });
const hint = (root = page) => root.locator(".text-keyboard-hint");
const status = (root = page) => root.locator(".text-composer-hint").getByRole("status");
const update = (fields) => { state.textStatus.job = { ...state.textStatus.job, ...fields }; };
const setTheme = (theme) => page.evaluate((name) => { document.documentElement.dataset.theme = name; }, theme);
async function capture(stage) {
  if (!captureScreens) return;
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await page.screenshot({ path: dir + "/chat-lifecycle-" + stage + "-" + theme + ".png" });
  }
  await setTheme("light");
}
async function send(prompt, root = page) {
  await composer(root).fill(prompt);
  await button("Send message", root).click();
  await expect(live(root)).toContainText("Loading model…");
}

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await expect(page.getByRole("heading", { name: "What can I help with?" })).toBeVisible();
  await capture("01-new");

  await send("Draft a short workshop agenda.");
  await capture("02-loading");
  await expect(status()).toHaveText("Loading model…");
  await expect(status()).toHaveClass(/sr-only/);
  await expect(hint()).toHaveText("Esc to stop");

  const partial = "## Workshop agenda\n\n- Welcome and introductions\n- Hands-on practice";
  update({ phase: "Waiting for the first token…", partialText: partial });
  await expect(live().getByRole("heading", { name: "Workshop agenda" })).toBeVisible();
  await expect(status()).toHaveText("Responding…");
  await expect(status()).not.toHaveClass(/sr-only/);
  await capture("03-streaming");
  update({ status: "complete", partialText: partial + "\n- Questions and next steps", finishedAt: Date.now() / 1000 });
  await expect(live()).toHaveCount(0);
  await expect(page.getByText("Questions and next steps", { exact: true })).toBeVisible();
  await expect(hint()).toHaveText("Enter to send · Shift + Enter for newline");
  await capture("04-completed");

  await send("Draft the opening remarks.");
  update({ phase: "Waiting for the first token…", partialText: "Welcome, everyone. Today we will work through a practical example." });
  await expect(live()).toContainText("Welcome, everyone.");
  await composer().fill("Keep the next draft.");
  await composer().press("Escape");
  await expect(page.getByText("Stopped · Partial response", { exact: true })).toBeVisible();
  await expect(composer()).toHaveValue("Keep the next draft.");
  await capture("05-stopped");

  await send("Give me a list of supplies.");
  update({ status: "failed", partialText: "Start with one notebook per group.",
    error: "The local model ran out of memory.", finishedAt: Date.now() / 1000 });
  const failed = page.getByRole("article", { name: "Model response", exact: true }).last();
  await expect(failed).toContainText("Start with one notebook per group.");
  await expect(failed).toContainText("The local model ran out of memory.");
  await expect(button("Continue response", failed)).toBeEnabled();
  await capture("06-failed");

  await button("Open split chat").click();
  await page.getByRole("dialog", { name: "Choose a chat", exact: true }).getByRole("button", { name: /^Handbook/ }).click();
  await page.setViewportSize({ width: 864, height: 620 });
  const right = page.getByRole("region", { name: "Right chat", exact: true });
  await expect(hint(right)).toBeHidden();
  await send("Add a note to the handbook.", right);
  await expect(hint(right)).toHaveText("Esc to stop");
  await expect(hint(right)).toBeVisible();
  await expect(status(right)).toHaveClass(/sr-only/);
  const history = right.getByRole("log", { name: "Conversation" });
  await history.press("Home");
  await expect(status(right)).not.toHaveClass(/sr-only/);
  await expect(status(right)).toHaveText("Loading model…");
  await expect(hint(right)).toBeVisible();
  await capture("07-compact-split-reading");
  await button("Jump to latest message", right).click();
  await expect(status(right)).toHaveClass(/sr-only/);
  await capture("08-compact-split-loading");
  assert.deepEqual(errors, []);
  console.log("The chat lifecycle keeps local progress visible, preserves recovery actions, and shows status when reading older messages.");
} finally {
  await close();
}
