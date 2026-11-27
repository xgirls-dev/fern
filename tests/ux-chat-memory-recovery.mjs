import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { chooseSelectOption } from "./select-option.mjs";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const threadId = "text-thread-memory";
const earlierId = "text-thread-earlier-memory";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  legacyTextWorkspace: { activeId: threadId, threads: [{
    id: threadId, title: "Workshop notes", modelId: "local", contextSize: 8192, draft: "Summarize the workshop.", messages: [],
  }, {
    id: earlierId, title: "Earlier local chat", modelId: "local", contextSize: 8192, draft: "Keep this earlier draft.",
    messages: [
      { id: "earlier-prompt", role: "user", content: "Make a quick plan.", createdAt: 1 },
      { id: "earlier-reply", role: "assistant", content: "An earlier partial answer", createdAt: 2,
        status: "failed", error: "ggml_aligned_malloc: insufficient memory\nCould not load /private/older.gguf" },
    ],
  }] },
  textStatus: {
    models: [
      { id: "local", name: "Local GGUF", installed: true, format: "gguf" },
      { id: "small", name: "Smaller OpenVINO model", installed: true },
    ],
    ggufAvailable: true, runtimeAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" },
  },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const reply = page.getByRole("article", { name: "Model response", exact: true }).last();
const settings = page.getByRole("complementary", { name: "Chat settings panel", exact: true });
const context = settings.getByRole("spinbutton", { name: "Context length (tokens)" });
const loading = page.getByRole("article", { name: "Response in progress", exact: true });
const nextDraft = "Keep this follow-up in the composer.";

function failMemory(partialText) {
  state.textStatus.job = { ...state.textStatus.job, status: "failed", errorCode: "out-of-memory",
    error: "runtime: VK_ERROR_OUT_OF_DEVICE_MEMORY /private/model.gguf", partialText, finishedAt: Date.now() / 1000 };
}

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await expect(composer).toHaveValue("Summarize the workshop.");
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  assert.equal(state.textRequests[0].contextSize, 8192);
  await composer.fill(nextDraft);
  state.textStatus.job = { ...state.textStatus.job, phase: "Generating…", partialText: "A useful partial answer" };
  await expect(loading).toContainText("A useful partial answer");

  failMemory("A useful partial answer");
  await expect(reply).toContainText("The model ran out of memory.");
  await expect(reply).toContainText("A useful partial answer");
  await expect(reply).not.toContainText("/private/model.gguf");
  await expect(composer).toHaveValue(nextDraft);
  await expect.poll(async () => (await savedTextWorkspace(page))?.threads.find(({ id }) => id === threadId)?.messages.at(-1)?.errorCode)
    .toBe("out-of-memory");
  await page.evaluate(() => {
    window.studio.copyText = async (text) => { window.memoryDiagnostics = text; };
  });
  await chooseMessageAction(reply, "Copy reply diagnostics");
  await expect.poll(() => page.evaluate(() => window.memoryDiagnostics)).toContain("Failure code: out-of-memory");
  assert(!(await page.evaluate(() => window.memoryDiagnostics)).includes("/private/model.gguf"));

  await page.setViewportSize({ width: 390, height: 620 });
  await expect.poll(() => reply.locator(".text-reply-recovery").evaluate((notice) => {
    const { left, right } = notice.getBoundingClientRect();
    return notice.scrollWidth <= notice.clientWidth && [...notice.querySelectorAll("button")].every((button) => {
      const bounds = button.getBoundingClientRect();
      return bounds.left >= left && bounds.right <= right;
    });
  })).toBe(true);
  await page.setViewportSize({ width: 900, height: 620 });
  await reply.getByRole("button", { name: "Adjust context", exact: true }).press("Enter");
  await expect(context).toBeFocused();
  await expect(context).toHaveValue("8192");
  await context.fill("1024");
  await context.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(reply.getByRole("button", { name: "Choose model", exact: true })).toBeFocused();
  await expect(composer).toHaveValue(nextDraft);
  await reply.getByRole("button", { name: "Retry response", exact: true }).click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  assert.equal(state.textRequests[1].contextSize, 1024);
  assert.equal(state.textRequests[1].modelId, "local");
  assert.deepEqual(state.textRequests[1].messages, state.textRequests[0].messages);

  failMemory("");
  await expect(reply.getByRole("button", { name: "Choose model", exact: true })).toBeVisible();
  await expect(reply.getByRole("button", { name: "Adjust context", exact: true })).toHaveCount(0);
  await reply.getByRole("button", { name: "Choose model", exact: true }).click();
  const model = settings.getByRole("combobox", { name: "Settings model", exact: true });
  await expect(model).toBeFocused();
  await chooseSelectOption(model, "Smaller OpenVINO model");
  await button("Close chat settings").click();
  await expect(composer).toHaveValue(nextDraft);
  await reply.getByRole("button", { name: "Retry response", exact: true }).click();
  await expect.poll(() => state.textRequests.length).toBe(3);
  assert.equal(state.textRequests[2].modelId, "small");
  assert.deepEqual(state.textRequests[2].messages, state.textRequests[0].messages);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The workshop is ready for review.", finishedAt: Date.now() / 1000 };
  await expect(reply).toContainText("The workshop is ready for review.");
  await expect(composer).toHaveValue(nextDraft);
  await expect.poll(async () => {
    const saved = await savedTextWorkspace(page);
    const responses = saved.threads.find(({ id }) => id === threadId).messages.filter(({ role }) => role === "assistant");
    return responses.flatMap((response) => [response, ...(response.alternatives ?? [])]).map(({ content }) => content);
  }).toEqual(expect.arrayContaining(["A useful partial answer", "The workshop is ready for review."]));

  await page.setViewportSize({ width: 1200, height: 760 });
  await button("Text thread: Earlier local chat").click();
  await expect(reply).toContainText("An earlier partial answer");
  await expect(reply).toContainText("The model ran out of memory.");
  await expect(reply).not.toContainText("/private/older.gguf");
  await expect(composer).toHaveValue("Keep this earlier draft.");
  await reply.getByRole("button", { name: "Adjust context", exact: true }).press("Enter");
  await expect(context).toBeFocused();
  await expect(context).toHaveValue("8192");
  assert.equal(state.textRequests.length, 3);
  assert.deepEqual(errors, []);
  console.log("Chat memory recovery preserves the partial answer, prompt, and draft across context and model changes.");
} finally {
  await close();
}
