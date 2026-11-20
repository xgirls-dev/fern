import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const model = { id: "gemma", name: "Gemma", installed: true, format: "gguf" };
const { page, state, errors, close } = await fixture({
  textStatus: { models: [model], runtimeAvailable: true, ggufAvailable: true, job: { id: null, status: "idle" } },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const message = page.getByRole("textbox", { name: "Message", exact: true });
const complete = async (content) => {
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: content,
    result: { inputTokens: 1, outputTokens: 1, generationSeconds: 1, tokensPerSecond: 1 } };
  await page.getByText(content, { exact: true }).waitFor();
};
const send = async (content, response) => {
  await message.fill(content);
  await button("Send message").click();
  await complete(response);
};

try {
  await page.locator(".sidebar-new-button").click();
  await page.getByRole("menuitem", { name: /New text thread|Chat/ }).click();
  await send("First prompt", "First response.");
  await send("Original follow-up", "Original answer.");
  await message.fill("Keep this draft");
  await button("Edit message").first().click();
  await page.getByRole("textbox", { name: "Edited message" }).fill("Revised opening");
  await button("Resend").click();
  assert.deepEqual(state.textRequests[2].messages, [{ role: "user", content: "Revised opening" }]);
  await complete("Revised response.");
  assert.equal(await message.inputValue(), "Keep this draft");
  assert.equal(await page.getByText("Original answer.", { exact: true }).count(), 0);
  await page.reload();
  await page.getByLabel("Conversation versions", { exact: true }).selectOption({ label: "Original follow-up" });
  await page.getByText("Original answer.", { exact: true }).waitFor();
  assert.equal(state.textRequests.length, 3);
  await page.getByLabel("Conversation versions", { exact: true }).selectOption({ label: "Revised opening" });
  await page.getByText("Revised response.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Editing earlier prompts saves conversation versions, preserves the draft, and restores either version after reload.");
} finally {
  await close();
}
