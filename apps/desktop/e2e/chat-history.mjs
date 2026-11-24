import { expect } from "@playwright/test";
import { chooseMessageAction, savedTextWorkspace } from "../../../tests/ui-fixture.mjs";

const title = "Kiln trials";
const activeId = "text-thread-history-draft";
const longId = "text-thread-history-kiln";
const phrase = "copper glaze schedule";
const draft = "Keep the inspection notes for the next reply.";
const primer = "A separate unsent draft.";
const target = 113;

function makeMessages(count, prefix, matchIndex = -1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: index % 2 ? "assistant" : "user",
    content: index === matchIndex ? "Keep the **copper glaze** schedule with the latest sample."
      : index % 2 ? `Record the **inspection** for sample ${prefix}.${index}.`
      : `What should we check for sample ${prefix}.${index}?`,
    createdAt: index + 1,
  }));
}

export async function verifyChatHistory(page) {
  const history = makeMessages(480, "kiln", target);
  const threads = [
    { id: activeId, title: "Working notes", draft: primer, messages: [], updatedAt: 100 },
    { id: longId, title, draft, messages: history, updatedAt: 99 },
    ...Array.from({ length: 64 }, (_, index) => ({
      id: `text-thread-history-notebook-${index}`, title: index === 0 ? title : `Notebook ${index}`,
      updatedAt: index + 1, messages: makeMessages(40, `notebook-${index}`),
    })),
  ].map((thread) => ({ modelId: "local", ...thread }));

  await expect.poll(() => savedTextWorkspace(page).then(() => true, () => false)).toBe(true);
  await savedTextWorkspace(page, { activeId, threads });
  await page.evaluate(() => localStorage.setItem("fern-last-workspace:v1", "text"));
  await page.reload();

  const button = (name) => page.getByRole("button", { name, exact: true });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const search = page.getByRole("dialog", { name: "Search threads", exact: true });
  const query = search.getByRole("searchbox", { name: "Find a thread", exact: true });
  const find = page.getByRole("searchbox", { name: "Search this chat", exact: true });
  const feed = page.getByRole("log", { name: "Conversation", exact: true });
  const reply = feed.locator(`[data-chat-message="kiln-${target}"]`);
  const prompt = feed.locator(`[data-chat-message="kiln-${target - 1}"]`);
  const savedHistory = async () =>
    (await savedTextWorkspace(page))?.threads.find(({ id }) => id === longId)?.messages;

  async function searchForReply() {
    await button("Search threads").press("Enter");
    await expect(query).toBeFocused();
    await query.fill(phrase);
  }

  async function revealReply() {
    const result = search.getByRole("button").filter({ hasText: title });
    await expect(result).toHaveCount(1);
    await expect(result).toContainText(phrase);
    await query.press("Enter");
    await expect(composer).toHaveValue(draft);
    await expect(find).toHaveValue(phrase);
    await expect(reply).toHaveAttribute("data-find-match", "true");
    await expect(reply).toBeInViewport();
    await expect.poll(() => page.evaluate(() =>
      [...(CSS.highlights.get("fern-chat-find") ?? [])][0]?.toString())).toBe(phrase);
    await find.press("Escape");
    await expect(find).toHaveCount(0);
    await expect(reply).toBeInViewport();
  }

  await expect(composer).toHaveValue(primer);
  await searchForReply();
  await revealReply();
  await expect.poll(() => feed.locator("[data-chat-message]").count()).toBeLessThan(120);

  await chooseMessageAction(reply, "Delete reply");
  await page.getByRole("group", { name: "Confirm message deletion" })
    .getByRole("button", { name: "Delete", exact: true }).click();
  await expect(reply).toHaveCount(0);
  await expect(prompt).toBeVisible();
  await expect.poll(async () => (await savedHistory())?.[target]?.id).toBe(history[target + 1].id);

  await searchForReply();
  await expect(search.getByRole("status").filter({ hasText: "No matching threads" })).toBeVisible();
  await query.press("Enter");
  await expect(query).toBeFocused();
  await query.press("Escape");
  await expect(button("Search threads")).toBeFocused();

  await button("Undo deletion").press("Enter");
  await expect.poll(async () => (await savedHistory())?.[target]?.id).toBe(history[target].id);
  await searchForReply();
  await revealReply();

  await page.reload();
  await expect(composer).toHaveValue(draft);
  await searchForReply();
  await revealReply();
  const restored = await savedHistory();
  expect(restored.map(({ id, content }) => ({ id, content })))
    .toEqual(history.map(({ id, content }) => ({ id, content })));
  console.log("Long history passed: 66 chats, 3,040 messages, exact search, delete, Undo, and reload.");
}
