import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { fixture } from "./ui-fixture.mjs";

const source = "text-thread-transcript-source";
const active = "text-thread-transcript-active";
const archived = "text-thread-transcript-archive";
const title = "Budget [Q4] & Café";
const fence = "`".repeat(3);
const table = "| Item | Total |\n| --- | ---: |\n| Workshop | 12 |";
const { page, state, errors, close } = await fixture({
  firstRun: true, builtRenderer: process.env.FERN_TRANSCRIPT_BUILT === "1",
  textStatus: { models: [{ id: "local", name: "Local model", installed: true, format: "gguf" }], ggufAvailable: true,
    supportsJobPolling: true, job: { id: null, status: "idle" } },
  legacyTextWorkspace: { activeId: active, threads: [
    { id: source, title, modelId: "local", draft: "Separate unsent draft.", systemPrompt: "Private system preferences.", messages: [
      { id: "prompt", role: "user", content: "Compare the workshop costs.", createdAt: 1,
        image: `chat-image-${"f".repeat(32)}.png`, promptAlternatives: [{ id: "old-prompt", content: "Superseded prompt.", createdAt: 0 }] },
      { id: "answer", role: "assistant", modelName: "Local model", content: `**Selected estimate.**\n\n${table}\n\n${fence}js\nconst unfinished = true;`,
        status: "stopped", reasoning: "Private reasoning.", error: "/local/workspace/model.log", createdAt: 2,
        alternatives: [{ id: "older", role: "assistant", content: "Superseded reply.", createdAt: 1 }] },
      { id: "followup", role: "user", content: "Next question after the unfinished code.", createdAt: 3 },
      { id: "illustration", role: "assistant", status: "complete", content: "", createdAt: 4,
        generatedImage: { name: "workshop.png", width: 320, height: 256, modelLabel: "Local image model", prompt: "Workshop poster" } },
    ] },
    { id: active, title: "Current conversation", modelId: "local", messages: [] },
    { id: archived, title: "Archived conversation", modelId: "local", archived: true, messages: [
      { id: "archive-prompt", role: "user", content: "Old archived question.", createdAt: 1 },
    ] },
  ] },
});

const button = (name) => page.getByRole("button", { name, exact: true });
const menu = (name) => button(`Actions for text thread ${name}`);
const item = (name) => page.getByRole("menuitem", { name, exact: true });
const composer = page.getByRole("textbox", { name: "Message", exact: true });
const saved = () => page.evaluate(() => window.transcriptSaves);
const copied = () => page.evaluate(() => window.transcriptCopies);

try {
  await page.route("**/api/text/job", (route) => route.fulfill({ json: state.textStatus.job }));
  await page.evaluate(() => {
    window.transcriptSaves = [];
    window.transcriptCopies = [];
    window.saveOutcome = false;
    window.studio.copyText = async (markdown) => { window.transcriptCopies.push(markdown); };
    window.studio.saveChatTranscript = async (name, markdown) => {
      window.transcriptSaves.push({ name, markdown });
      return window.saveOutcome;
    };
  });

  await menu("Current conversation").click();
  await expect(item("Copy transcript")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await menu(title).press("Enter");
  await expect(item("Rename")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("Duplicate")).toBeFocused();
  await page.keyboard.press("c");
  await expect(item("Copy transcript")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu(title)).toBeFocused();
  await expect(page.getByText("Chat transcript copied.", { exact: true })).toBeVisible();
  await expect(button("Text thread: Current conversation")).toHaveAttribute("aria-current", "page");
  const markdown = (await copied())[0];
  assert(markdown.includes("# Budget \\[Q4\\] \\& Café"));
  assert(markdown.includes("> **Selected estimate.**"));
  assert(markdown.includes("*Response stopped.*"));
  assert(markdown.includes("**Image attachment**"));
  assert(markdown.includes("**Generated image** · Workshop poster"));
  for (const privateText of ["Superseded prompt.", "Superseded reply.", "Private reasoning.", "Separate unsent draft.", "Private system preferences.", "/local/workspace"]) {
    assert(!markdown.includes(privateText));
  }
  const document = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  assert.deepEqual(document.children.map(({ type }) => type),
    ["heading", "heading", "blockquote", "heading", "blockquote", "heading", "blockquote", "heading", "blockquote"]);
  const answer = document.children[4];
  assert(answer.children.some((node) => node.type === "table"));
  assert.equal(answer.children.at(-1).type, "code");
  assert.equal(answer.children.at(-1).value, "const unfinished = true;");

  await menu(title).click();
  await item("Save Markdown…").click();
  await expect.poll(async () => (await saved()).length).toBe(1);
  await expect(page.getByText("Chat transcript saved.", { exact: true })).toHaveCount(0);
  await expect(menu(title)).toBeFocused();
  await page.evaluate(() => { window.saveOutcome = true; });
  await menu(title).click();
  await item("Save Markdown…").click();
  await expect(page.getByText("Chat transcript saved.", { exact: true })).toBeVisible();
  assert.deepEqual(await saved(), [{ name: title, markdown }, { name: title, markdown }]);

  await composer.fill("Start an active response.");
  await button("Send message").click();
  const live = page.getByRole("article", { name: "Response in progress" });
  await expect(live).toBeVisible();
  state.textStatus.job = { ...state.textStatus.job, phase: "Waiting for the first token…",
    partialText: "The estimate so far is 42.", partialReasoning: "Also private reasoning." };
  await expect(live).toContainText("The estimate so far is 42.");
  await composer.fill("Unsent question during streaming.");
  await page.setViewportSize({ width: 864, height: 700 });
  await page.keyboard.press("Control+k");
  const commands = page.getByRole("combobox", { name: "Search commands or threads" });
  await commands.fill("copy chat transcript");
  await expect(page.getByRole("option", { name: /Copy chat transcript/ })).toBeVisible();
  await commands.press("Enter");
  await expect.poll(async () => (await copied()).length).toBe(2);
  const snapshot = (await copied())[1];
  assert(snapshot.includes("Start an active response."));
  assert(snapshot.includes("Response in progress when exported."));
  assert(snapshot.includes("The estimate so far is 42."));
  assert(!snapshot.includes("Also private reasoning."));
  assert(!snapshot.includes("Unsent question during streaming."));
  await expect(composer).toHaveValue("Unsent question during streaming.");

  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "The final estimate is 42." };
  await expect(live).toHaveCount(0);
  await page.setViewportSize({ width: 1220, height: 800 });
  await button("Search threads").click();
  const search = page.getByRole("dialog", { name: "Search threads" });
  await search.getByRole("searchbox", { name: "Find a thread" }).fill("Archived conversation");
  await search.getByRole("button", { name: /Archived conversation/ }).click();
  await menu("Archived conversation").click();
  await item("Copy transcript").click();
  await expect.poll(async () => (await copied()).length).toBe(3);
  assert((await copied())[2].includes("Old archived question."));
  assert.deepEqual(errors, []);
  console.log("Chat exports isolate the selected transcript, preserve interrupted Markdown, and work during streaming and in archived chats.");
} finally {
  await close();
}
