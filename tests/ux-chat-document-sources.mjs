import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const threadId = "text-thread-source-preview";
const draft = "Check travel details next.";
const quoted = "The workshop begins at noon in Room Cedar. The printed label reads CafÃ©.";
const first = {
  number: 1, name: "Schedule.pdf", location: "Page 4", excerpt: quoted,
  reference: { documentId: `doc-${"a".repeat(64)}`, passageIndex: 5, quotedCharacters: quoted.length,
    fingerprint: "b".repeat(64) },
};
const older = { number: 2, name: "Earlier notes.txt", location: "Section 1", excerpt: "Check in at the east entrance." };
const answer = "The workshop begins at noon [1]. See the earlier notes [2].\n\n`array[1]` and [Unknown [1]](https://example.com/) stay as written [3].\n\n| Room | Source |\n| --- | --- |\n| Cedar | [1] |";
const { page, errors, close } = await fixture({
  firstRun: true, viewport: { width: 800, height: 615 },
  legacyTextWorkspace: { activeId: threadId, threads: [{ id: threadId, title: "Workshop", draft, messages: [
    { id: "prompt", role: "user", content: "When is the workshop?", createdAt: 1 },
    { id: "reply", role: "assistant", content: answer, status: "complete", createdAt: 2,
      metrics: { inputTokens: 100, outputTokens: 35, generationSeconds: 2, tokensPerSecond: 17.5, documentSources: [first, older] } },
    { id: "prompt-two", role: "user", content: "Show the source again.", createdAt: 3 },
    { id: "reply-two", role: "assistant", content: "**[1] Schedule.pdf · Page 9**\n\nThe answer uses [1].", status: "complete", createdAt: 4,
      metrics: { inputTokens: 130, outputTokens: 20, generationSeconds: 2, tokensPerSecond: 10, documentSources: [first] } },
  ] }] },
});
const transcript = page.getByRole("log");
const replies = transcript.getByRole("article", { name: "Model response", exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const trigger = (number, file, location) => transcript.getByRole("button", { name: `Open source [${number}], ${file}, ${location}`, exact: true });
const citations = trigger(1, first.name, first.location);
const dialog = page.getByRole("dialog", { name: first.name, exact: true });
const requests = [];
let available = true;
let holdResponses = true;
let release;
const responseDelay = new Promise((resolve) => { release = resolve; });

try {
  await page.route("**/api/text/documents/source?*", async (route) => {
    requests.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    if (holdResponses) await responseDelay;
    // Development React can start a second request after cleaning up the first effect.
    const response = available ? { json: {
      before: { location: "Page 3", text: "The previous page discusses registration. ".repeat(40) },
      quoted, remaining: " A separate afternoon meeting starts at two.",
      after: { location: "Page 5", text: "The following page describes parking. ".repeat(40) },
    } } : { status: 404, json: { error: "The local passage is unavailable." } };
    await route.fulfill(response).catch(() => {});
  });
  await expect(citations).toHaveCount(2);
  await expect(transcript.locator("code")).toHaveText("array[1]");
  await expect(transcript.getByRole("link", { name: "Unknown [1]", exact: true })).toBeVisible();
  await expect(transcript.getByText(/stay as written \[3\]/)).toBeVisible();
  await expect(replies.last().getByText("The answer uses [1].", { exact: true })).toBeVisible();
  await expect(replies.last().getByRole("button", { name: /^Open source/ })).toHaveCount(0);
  await expect.poll(() => requests.length).toBe(0);

  const inline = citations.first();
  await inline.press("Enter");
  await expect(dialog.getByText("Loading local passage…", { exact: true })).toBeVisible();
  await expect(dialog.getByText(quoted, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close document source", exact: true })).toBeFocused();
  holdResponses = false;
  release();
  await expect(dialog.locator("mark")).toHaveText(quoted);
  await expect(dialog.locator("mark")).toBeInViewport();
  await expect.poll(() => dialog.getByRole("region", { name: "Source text" }).evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByRole("heading", { name: "Before the citation · Page 3" })).toBeAttached();
  assert.deepEqual(requests.at(-1), { documentId: first.reference.documentId, passageIndex: "5",
    quotedCharacters: String(quoted.length), fingerprint: first.reference.fingerprint });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(inline).toBeFocused();

  const beforeLegacy = requests.length;
  await trigger(2, older.name, older.location).click();
  const oldDialog = page.getByRole("dialog", { name: older.name, exact: true });
  await expect(oldDialog.getByText("Saved excerpt", { exact: true })).toBeVisible();
  await expect(oldDialog.getByText(older.excerpt, { exact: true })).toBeVisible();
  assert.equal(requests.length, beforeLegacy);
  await oldDialog.getByRole("button", { name: "Close document source", exact: true }).click();

  await page.reload();
  await expect(composer).toHaveValue(draft);
  await replies.last().getByText("Document sources", { exact: true }).click();
  const sourceList = replies.last().locator(".text-document-sources");
  const listTrigger = sourceList.getByRole("button", { name: `Open source [1], ${first.name}, ${first.location}`, exact: true });
  available = false;
  await listTrigger.click();
  await expect(dialog.getByText("The local passage is unavailable. The saved excerpt is still here.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(quoted, { exact: true })).toBeVisible();
  await expect(dialog.locator("mark")).toHaveCount(0);
  assert(requests.length > beforeLegacy);
  const beforeRetry = requests.length;
  available = true;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.locator("mark")).toHaveText(quoted);
  await dialog.getByRole("button", { name: "Close document source", exact: true }).click();
  await expect(listTrigger).toBeFocused();
  assert(requests.length > beforeRetry);
  assert.deepEqual(errors, []);
  console.log("Inline citations and source lists open the exact passage, reject conflicting numbers, preserve focus and drafts, and keep saved excerpts.");
} finally {
  release();
  await close();
}
