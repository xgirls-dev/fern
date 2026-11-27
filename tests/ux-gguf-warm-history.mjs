import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const threadId = "text-thread-warm-history";
const model = { id: "local", name: "Local model", installed: true, format: "gguf" };
const resident = { modelId: model.id, device: "CPU", backend: "llama.cpp CPU", gguf: { contextSize: 8192, loadOptions: {} } };
const history = Array.from({ length: 318 }, (_, index) => ({
  id: `note-${index}`, role: index % 2 ? "assistant" : "user", content: `Notebook entry ${index}.`, createdAt: index + 1,
}));
const { page, state, errors, close } = await fixture({
  firstRun: true,
  legacyTextWorkspace: { activeId: threadId, threads: [{ id: threadId, title: "Warm history", modelId: model.id,
    contextSize: 8192, maxNewTokens: 128, messages: history }] },
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, residentModel: resident, job: { id: null, status: "idle" } },
});

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const reply = page.getByRole("article", { name: "Model response", exact: true }).last();
  async function sendPrompt(prompt, count) {
    await composer.fill(prompt);
    await send.click();
    await expect.poll(() => state.textRequests.length).toBe(count);
    await expect(page.getByRole("article", { name: "Response in progress", exact: true })).toContainText("Loading model…");
    return state.textRequests.at(-1).messages;
  }
  async function complete(answer, inputTokens) {
    state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: answer, residentModel: resident,
      finishedAt: Date.now() / 1000, result: { modelName: model.name, backend: resident.backend, device: resident.device,
        inputTokens, outputTokens: 4, generationSeconds: 1, tokensPerSecond: 4,
        context: { size: 8192, compactedMessages: 0, images: 0 } } };
    await expect(reply).toContainText(answer);
  }

  const first = await sendPrompt("Update the notebook.", 1);
  assert.equal(first.length, 313);
  assert.equal(first[0].content, "Notebook entry 6.");
  await complete("The notebook is current.", 4300);

  const second = await sendPrompt("What should I review?", 2);
  assert.deepEqual(second.slice(0, first.length), first, "Keep the exact resident prefix across the scheduled history shift.");
  assert.equal(second.length, first.length + 2);
  await complete("Review the agenda.", 4324);
  await reply.getByRole("button", { name: "Regenerate response", exact: true }).click();
  await expect.poll(() => state.textRequests.length).toBe(3);
  assert.deepEqual(state.textRequests.at(-1).messages, second, "Regenerate uses the same context while the model is resident.");
  await expect(page.getByRole("article", { name: "Response in progress", exact: true })).toContainText("Loading model…");
  await complete("Read the agenda.", 7790);

  const third = await sendPrompt("What comes next?", 4);
  assert.equal(third.length, 301, "Use the bounded recent window when the resident context has no headroom.");
  assert.equal(third[0].content, "Notebook entry 22.");
  await complete("Confirm the room.", 4400);
  assert.deepEqual(errors, []);
  console.log("Warm GGUF history retains the complete prompt prefix when it fits and advances the window when headroom runs out.");
} finally {
  await close();
}
