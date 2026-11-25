import { expect } from "@playwright/test";
import { chooseMessageAction, fixture, savedTextWorkspace } from "./ui-fixture.mjs";

const id = "text-thread-interrupted-undo";
const draft = "Preserve this draft";
const originalIds = ["prompt", "reply", "follow-up"];
const deletedIds = ["prompt", "follow-up"];
const { page, errors, close } = await fixture({ firstRun: true,
  legacyTextWorkspace: { activeId: id, threads: [{
    id, title: "Interrupt an Undo", draft, modelId: "local",
    messages: [
      { id: "prompt", role: "user", content: "Can I recover my answer?", createdAt: 1 },
      { id: "reply", role: "assistant", content: "Here is the recovered answer.", createdAt: 2, alternatives: [
        { id: "reply-older", role: "assistant", content: "A previous answer version.", createdAt: 1.5 },
      ] },
      { id: "follow-up", role: "user", content: "This message stays in place.", createdAt: 3 },
    ],
  }] },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const reply = page.getByRole("article", { name: "Model response" });
const savedIds = async () => (await savedTextWorkspace(page)).threads.find((thread) => thread.id === id).messages.map(({ id }) => id);

async function deleteReply() {
  await chooseMessageAction(reply, "Delete reply");
  await page.getByRole("group", { name: "Confirm message deletion" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(reply).toHaveCount(0);
}

async function interruptWrites() {
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === "fern-text-workspace") throw new DOMException("Fixture blocks chat writes", "AbortError");
      return put.apply(this, args);
    };
  });
}

try {
  await expect(reply).toBeVisible();
  const initial = await savedTextWorkspace(page);

  await deleteReply();
  await expect.poll(savedIds).toEqual(deletedIds);
  await interruptWrites();
  await button("Undo deletion").press("Enter");
  await expect(reply).toBeVisible();
  await expect(button("Retry saving chats")).toBeVisible();
  await expect.poll(savedIds).toEqual(deletedIds);
  await page.reload();
  await expect(composer).toHaveValue(draft);
  await expect(reply).toBeVisible();
  await expect.poll(savedIds).toEqual(originalIds);

  await interruptWrites();
  await reply.getByRole("button", { name: "Previous response version" }).click();
  await expect(reply).toContainText("A previous answer version.");
  await chooseMessageAction(reply, "Delete this version");
  await page.getByRole("group", { name: "Confirm message deletion" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(reply).toContainText("Here is the recovered answer.");
  await expect(button("Retry saving chats")).toBeVisible();
  await page.reload();
  await expect(reply).toContainText("Here is the recovered answer.");
  await expect(reply.getByRole("button", { name: "Previous response version" })).toHaveCount(0);
  await expect.poll(savedIds).toEqual(originalIds);

  await interruptWrites();
  await deleteReply();
  await expect(button("Retry saving chats")).toBeVisible();
  await expect.poll(savedIds).toEqual(originalIds);
  await page.reload();
  await expect(composer).toHaveValue(draft);
  await expect(reply).toHaveCount(0);
  await expect.poll(savedIds).toEqual(deletedIds);

  await savedTextWorkspace(page, initial);
  await page.reload();
  await expect(reply).toBeVisible();
  await page.evaluate(() => {
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", { ...complete,
      set(listener) {
        if (this.db.name === "fern-text-workspace" && this.mode === "readwrite") return;
        complete.set.call(this, listener);
      },
    });
  });
  await deleteReply();
  // IndexedDB commits the deletion, but the app is still waiting for its callback.
  await expect.poll(savedIds).toEqual(deletedIds);
  await button("Undo deletion").press("Enter");
  await expect(reply).toBeVisible();
  await page.reload();
  await expect(composer).toHaveValue(draft);
  await expect(reply).toBeVisible();
  await expect.poll(savedIds).toEqual(originalIds);

  await expect.poll(() => page.evaluate(() => localStorage.getItem("fern-text-transcript-edit-checkpoint:v1"))).toBeNull();
  expect(errors).toEqual([]);
  console.log("Chat deletion and Undo survive interrupted writes and a commit that reaches disk before reload.");
} finally {
  await close();
}
