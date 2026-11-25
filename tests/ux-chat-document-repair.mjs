import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const model = { id: "local", name: "Local model", format: "gguf", installed: true };
const threadId = "text-thread-document-repair";
const documents = ["Schedule.txt", "Venue.txt", "Travel.txt", "Overview.txt", "Reading.md", "Lunch.txt", "FAQ.txt", "Contacts.txt"]
  .map((name, index) => ({ id: `doc-${String(index).repeat(64)}`, name, bytes: 40 }));
const [missing, damaged, removed, overview] = documents;
const replacement = { id: `doc-${"a".repeat(64)}`, name: "Venue update.txt", bytes: 40 };
const prompt = "Which room is the workshop in?";
const draft = "Keep my next question here.";
const { page, state, errors, close } = await fixture({
  firstRun: true,
  textStatus: { models: [model], ggufAvailable: true, supportsJobPolling: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: threadId, threads: [{ id: threadId, title: "Workshop", draft: prompt, modelId: model.id, documents, messages: [] }] },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const attachments = page.getByRole("list", { name: "Chat documents", exact: true });
const replace = (name) => button(`Replace ${name}`);
let uploadError;

async function chooseReplacement(name, selected) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), replace(name).press("Enter")]);
  await chooser.setFiles(selected ? { name: selected, mimeType: "text/plain", buffer: Buffer.from("Workshop notes.") } : []);
}

async function savedChat() {
  return (await savedTextWorkspace(page))?.threads.find(({ id }) => id === threadId);
}

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.route("**/api/text/documents", (route) => {
    if (uploadError) return route.fulfill({ status: 400, json: { error: uploadError } });
    const { name } = route.request().postDataJSON();
    assert([missing.name, replacement.name].includes(name));
    return route.fulfill({ status: 201, json: { document: name === missing.name ? missing : replacement } });
  });
  await expect(composer).toHaveValue(prompt);
  await button("Send message").click();
  await expect.poll(() => state.textRequests.length).toBe(1);
  assert.deepEqual(state.textRequests[0].documentIds, documents.map(({ id }) => id));
  await composer.fill(draft);
  const unavailableIds = [missing.id, damaged.id, removed.id];
  state.textStatus.job = { ...state.textStatus.job, status: "failed", unavailableDocumentIds: unavailableIds,
    error: "Some attached documents are missing or unreadable. Replace or remove them, then retry.", finishedAt: Date.now() / 1000 };
  await expect(attachments.getByText("Unavailable", { exact: true })).toHaveCount(3);
  await expect(replace(overview.name)).toHaveCount(0);
  await expect(button("Attach documents")).toBeDisabled();
  await expect.poll(async () => (await savedChat())?.documents.filter((document) => document.unavailable).map(({ id }) => id))
    .toEqual(unavailableIds);
  await page.reload();
  await expect(composer).toHaveValue(draft);
  await expect(attachments.getByText("Unavailable", { exact: true })).toHaveCount(3);

  await chooseReplacement(missing.name);
  await expect(replace(missing.name)).toBeEnabled();
  uploadError = "The selected file could not be read.";
  await chooseReplacement(missing.name, missing.name);
  await expect(page.getByRole("alert").filter({ hasText: uploadError })).toBeVisible();
  await expect(replace(missing.name)).toBeEnabled();
  uploadError = undefined;
  await chooseReplacement(missing.name, missing.name);
  await expect(replace(missing.name)).toHaveCount(0);
  await expect(attachments.getByText(missing.name, { exact: true })).toBeVisible();
  await expect(composer).toBeFocused();

  await chooseReplacement(damaged.name, replacement.name);
  await expect(attachments.getByText(replacement.name, { exact: true })).toBeVisible();
  await expect(attachments.getByText(damaged.name, { exact: true })).toHaveCount(0);
  await button(`Remove ${removed.name} from this chat`).click();
  await expect(attachments.getByText("Unavailable", { exact: true })).toHaveCount(0);
  await expect(composer).toBeFocused();

  await button("Retry response").click();
  await expect.poll(() => state.textRequests.length).toBe(2);
  assert.deepEqual(state.textRequests[1].messages, state.textRequests[0].messages);
  const repairedIds = [missing.id, replacement.id, ...documents.slice(3).map(({ id }) => id)];
  assert.deepEqual(state.textRequests[1].documentIds, repairedIds);
  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The workshop is in Room Cedar.", finishedAt: Date.now() / 1000 };
  await expect(page.getByText("The workshop is in Room Cedar.", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue(draft);
  await expect.poll(async () => (await savedChat())?.documents.map(({ id }) => id)).toEqual(repairedIds);
  assert.deepEqual(errors, []);
  console.log("Missing documents stay identified after reload and can be repaired or removed before retrying the same prompt.");
} finally {
  await close();
}
