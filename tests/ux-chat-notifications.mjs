import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const chatId = "text-thread-notice";
const fence = String.fromCharCode(96).repeat(3);
const { page, state, errors, close } = await fixture({
  firstRun: true,
  viewport: { width: 390, height: 844 },
  legacyTextWorkspace: { activeId: chatId, threads: [
    { id: chatId, title: "Workshop notes", modelId: "local", messages: [
      { id: "setup", role: "user", content: "Show the command.", createdAt: 1 },
      { id: "example", role: "assistant", content: "Run this command.\n\n" + fence + "sh\nfern example\n" + fence, createdAt: 2 },
    ] },
    { id: "text-thread-notice-other", title: "Reading list", modelId: "local", messages: [] },
  ] },
  textStatus: {
    models: [{ id: "local", name: "Local model", format: "gguf", installed: true }],
    ggufAvailable: true, job: { id: null, status: "idle" },
  },
});
const button = (name, root = page) => root.getByRole("button", { name, exact: true });
const composer = (root = page) => root.getByRole("textbox", { name: "Message", exact: true });
const notifications = page.getByRole("complementary", { name: "Notifications", exact: true });
const expectHit = (locator) => expect.poll(() => locator.evaluate((control) => {
  const rect = control.getBoundingClientRect();
  return control.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
})).toBe(true);
const emit = (message, id) => page.evaluate(({ message, id }) => {
  window.dispatchEvent(new CustomEvent("fern-notification", { detail: { id, message, kind: "error" } }));
}, { message, id });

try {
  await page.evaluate(() => { window.studio.copyText = async () => { throw new Error("Clipboard unavailable."); }; });
  await composer().fill("Continue with an example.");
  const send = button("Send message");
  const initial = await send.boundingBox();
  await button("Copy code").click();
  await expect(notifications.getByRole("alert")).toHaveText("Could not copy the code. Select it and copy manually.");
  await expect(send).toBeEnabled();
  await expectHit(send);
  await expectHit(button("Attach documents"));
  const withNotice = await send.boundingBox();
  assert(Math.abs(initial.y - withNotice.y) <= 1, "Feedback should keep the settled chat composer in place.");
  await send.click({ timeout: 2_000 });
  await expect.poll(() => state.textRequests.length).toBe(1);
  const stop = button("Stop generation");
  await expect(notifications).toBeVisible();
  await expectHit(stop);
  await stop.click({ timeout: 2_000 });

  await page.setViewportSize({ width: 1500, height: 640 });
  await expect(stop).toHaveCount(0);
  await button("Open split chat").click();
  const picker = page.getByRole("dialog", { name: "Choose a chat", exact: true });
  await picker.getByRole("button", { name: /^Reading list/ }).click();
  const left = page.getByRole("region", { name: "Left chat", exact: true });
  const right = page.getByRole("region", { name: "Right chat", exact: true });
  await composer(left).fill("Left draft.");
  await composer(right).fill("Right draft.");
  for (let id = 100; id < 103; id++) await emit("A chat notice remains available until it is dismissed. ".repeat(3) + id, id);
  const alerts = notifications.getByRole("alert");
  await expect(alerts).toHaveCount(3);
  await expect(alerts.first()).toContainText("102");
  const stacked = await alerts.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  assert(stacked.every((top) => Math.abs(top - stacked[0]) <= 1), "Wide notices should share a row.");
  for (const pane of [left, right]) {
    await expectHit(button("Send message", pane));
    await expectHit(button("Attach chat image", pane));
  }
  const bounds = await notifications.boundingBox();
  assert(bounds.y + bounds.height <= (await left.boundingBox()).y, "The notification rail should stay above both chat panes.");
  await button("Dismiss notification", notifications).last().focus();
  await page.keyboard.press("Enter");
  await expect(notifications.getByRole("alert")).toHaveCount(2);
  await expect(composer(left)).toHaveValue("Left draft.");
  await expect(composer(right)).toHaveValue("Right draft.");

  await page.setViewportSize({ width: 540, height: 568 });
  const switcher = page.getByRole("group", { name: "Chat panes", exact: true });
  for (const [name, pane] of [["Left chat", left], ["Right chat", right]]) {
    await button(name, switcher).click();
    await expect(notifications).toBeVisible();
    await expectHit(button("Send message", pane));
    await expectHit(button("Attach documents", pane));
  }

  await page.setViewportSize({ width: 1500, height: 640 });
  await button("Preferences").click();
  await expect(notifications.getByRole("alert")).toHaveCount(2);
  await expect(notifications).toHaveCSS("position", "fixed");
  assert.deepEqual(errors, []);
  console.log("Chat notices preserve Send, Stop, attachments, and drafts in narrow and split layouts.");
} finally {
  await close();
}
