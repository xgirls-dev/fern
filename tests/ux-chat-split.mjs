import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const models = [
  { id: "gemma", name: "Gemma", installed: true, format: "gguf", maxContextSize: 65536, supportsVision: true, supportsTools: true },
  { id: "qwen", name: "Qwen", installed: true, format: "gguf", maxContextSize: 65536, supportsVision: true, supportsTools: true },
];
const { page, state, errors, dir, close } = await fixture({
  imageCount: 0, threadCount: 0, viewport: { width: 1500, height: 900 },
  textStatus: { models, runtimeAvailable: true, ggufAvailable: true, imageToolModels: [{ id: "4b", label: "Klein 4B" }],
    job: { id: null, status: "idle" } },
});
const document = { id: `doc-${"a".repeat(64)}`, name: "Research notes.txt", bytes: 35 };
await page.addInitScript((doc) => {
  if (sessionStorage.getItem("fern-split-fixture")) return;
  sessionStorage.setItem("fern-split-fixture", "true");
  localStorage.setItem("fern-last-workspace:v1", "text");
  localStorage.setItem("fern-text-threads:v1", JSON.stringify({
    activeId: "text-thread-writing",
    threads: [
      { id: "text-thread-writing", title: "Writing draft", messages: [], modelId: "gemma" },
      { id: "text-thread-research", title: "Research sources", messages: [], modelId: "qwen", documents: [doc] },
    ],
  }));
}, document);
await page.reload();

const region = (name) => page.getByRole("region", { name, exact: true });
const button = (name, root = page) => root.getByRole("button", { name, exact: true });
const message = (root) => root.getByRole("textbox", { name: "Message", exact: true });
const left = region("Left chat");
const right = region("Right chat");
const divider = page.getByRole("separator", { name: "Resize chat panes", exact: true });
const choose = page.getByRole("dialog", { name: "Choose a chat", exact: true });
const complete = async (answer, pane) => {
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: answer,
    result: { inputTokens: 18, outputTokens: 4, generationSeconds: 1, tokensPerSecond: 4 } };
  await pane.getByText(answer, { exact: true }).waitFor();
};
const settings = (pane) => pane.getByRole("complementary", { name: "Chat settings panel", exact: true });
const searchFor = async (name) => {
  await choose.getByRole("searchbox", { name: "Find a chat" }).fill(name);
  await choose.getByRole("button", { name: new RegExp(name) }).click();
};

try {
  await button("Open split chat", region("Text conversation")).click();
  await searchFor("Research sources");
  await left.waitFor();
  await right.getByText(document.name, { exact: true }).waitFor();
  assert.equal(await left.getByText(document.name, { exact: true }).count(), 0);
  const leftBox = await left.boundingBox();
  const rightBox = await right.boundingBox();
  assert(leftBox.x + leftBox.width <= rightBox.x, "The chats should appear in separate columns.");
  assert.equal(leftBox.y, rightBox.y);

  await divider.press("ArrowRight");
  assert.equal(await divider.getAttribute("aria-valuenow"), "55");
  const bar = await divider.boundingBox();
  const dragY = bar.y + Math.min(bar.height / 2, 35);
  await page.mouse.move(bar.x + bar.width / 2, dragY);
  await page.mouse.down();
  await page.mouse.move(bar.x - 65, dragY, { steps: 7 });
  await page.mouse.up();
  await page.waitForFunction(() => Number(document.querySelector(".chat-split-divider")?.getAttribute("aria-valuenow")) < 55);
  const savedSplit = Number(await divider.getAttribute("aria-valuenow"));
  assert(savedSplit >= 35 && savedSplit < 55);

  await button("Chat settings", left).click();
  await button("Chat settings", right).click();
  assert.notEqual(await settings(left).getAttribute("id"), await settings(right).getAttribute("id"));
  await settings(left).getByRole("spinbutton", { name: /^Context length/ }).fill("12345");
  await settings(right).getByRole("spinbutton", { name: /^Context length/ }).fill("23456");
  await button("Image", settings(left)).click();
  await settings(left).getByLabel("Width", { exact: true }).fill("320");
  await button("Image", settings(right)).click();
  await settings(right).getByLabel("Width", { exact: true }).fill("576");
  const widthIds = await Promise.all([settings(left), settings(right)].map((pane) => pane.getByLabel("Width", { exact: true }).getAttribute("id")));
  assert.notEqual(...widthIds);
  await button("Close chat settings", settings(left)).click();
  await button("Close chat settings", settings(right)).click();

  await message(left).fill("Continue the left draft");
  await message(right).fill("Answer the right prompt");
  await button("Send message", right).click();
  const rightRequest = state.textRequests[0];
  assert.equal(rightRequest.threadId, "text-thread-research");
  assert.equal(rightRequest.contextSize, 23456);
  assert.equal(rightRequest.modelId, "qwen");
  assert.equal(rightRequest.imageSettings.width, 576);
  assert.deepEqual(rightRequest.documentIds, [document.id]);
  await button("Stop generation", right).waitFor();
  assert(await button("Send message", left).isDisabled());
  assert.equal(await message(left).inputValue(), "Continue the left draft");
  await complete("Right answer.", right);

  await button("Send message", left).click();
  const leftRequest = state.textRequests[1];
  assert.equal(leftRequest.threadId, "text-thread-writing");
  assert.equal(leftRequest.contextSize, 12345);
  assert.equal(leftRequest.modelId, "gemma");
  assert.equal(leftRequest.imageSettings.width, 320);
  assert.equal(leftRequest.documentIds, undefined);
  await complete("Left answer.", left);

  await page.reload();
  await right.getByText("Right answer.", { exact: true }).waitFor();
  await left.getByText("Left answer.", { exact: true }).waitFor();
  assert.equal(Number(await divider.getAttribute("aria-valuenow")), savedSplit);
  await page.screenshot({ path: `${dir}/chat-split-wide.png` });
  await page.setViewportSize({ width: 864, height: 620 });
  const switcher = page.getByRole("group", { name: "Chat panes", exact: true });
  await button("Right chat", switcher).click();
  await left.waitFor({ state: "hidden" });
  await right.getByText("Right answer.", { exact: true }).waitFor();
  await button("Left chat", switcher).click();
  await right.waitFor({ state: "hidden" });
  await left.getByText("Left answer.", { exact: true }).waitFor();

  await page.setViewportSize({ width: 1500, height: 900 });
  await button("Close pane", right).click();
  await region("Text conversation").getByText("Left answer.", { exact: true }).waitFor();
  const research = button("Text thread: Research sources");
  const canvas = page.locator(".chat-split-layout");
  await research.dragTo(canvas, { targetPosition: { x: 70, y: 225 } });
  await left.getByText("Right answer.", { exact: true }).waitFor();
  await right.getByText("Left answer.", { exact: true }).waitFor();

  await button("Choose another chat for this pane", right).click();
  await button("New chat in this pane", choose).click();
  await right.getByRole("heading", { name: "New text thread", exact: true }).waitFor();
  await left.getByText("Right answer.", { exact: true }).waitFor();
  await button("Close pane", left).click();
  await region("Text conversation").getByRole("heading", { name: "New text thread", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Split chats preserve independent drafts, image settings, models, documents, responses, pane sizes, and narrow navigation.");
} finally {
  await close();
}
