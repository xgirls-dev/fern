import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";
const { page, state, errors, close } = await fixture();
const button = (name) => page.getByRole("button", { name, exact: true });
try {
  await button("Image settings").click();
  await page.locator("summary").filter({ hasText: "Style & recipes" }).click();
  await page
    .getByRole("combobox", { name: "Prompt recipe" })
    .selectOption("editorial-portrait");
  await page.locator(".sidebar-new-button").click();
  await button("Undo").click();
  assert.equal(await page.locator("#prompt").inputValue(), "");
  await page.waitForTimeout(350);
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fern-threads:v1")).threads.find(
          (t) => t.id === "study",
        ).settings.prompt,
    ),
    "Original unfinished draft",
  );
  await page.locator("#prompt").fill("Reusable draft");
  await page.locator("summary").filter({ hasText: "Style & recipes" }).click();
  await button("Save current").click();
  await page
    .getByRole("textbox", { name: "Recipe name" })
    .fill("Keep this recipe");
  await button("Save recipe").click();
  await button("Remove").click();
  await page.locator(".sidebar-new-button").click();
  await button("Undo").click();
  assert(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("fern-prompt-recipes")).some(
        (recipe) => recipe.name === "Keep this recipe",
      ),
    ),
  );
  await button("Close image settings").click();
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 2;
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "valid.png", mimeType: "image/png", buffer: png });
  await page.locator(".composer-reference img").waitFor();
  const originalReference = await page
    .locator(".composer-reference img")
    .getAttribute("src");
  await page.locator('input[type="file"]').setInputFiles({
    name: "too-large.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  assert.match(await page.locator(".composer-error").innerText(), /10 MB/);
  assert.equal(
    await page.locator(".composer-reference img").getAttribute("src"),
    originalReference,
  );
  await page.route("**/references/original.png", (r) =>
    r.fulfill({ contentType: "image/png", body: png }),
  );
  state.images[0] = {
    ...state.images[0],
    referenceUsed: true,
    referenceUrl: "/references/original.png",
  };
  // Wait for a listing that contains the new fixture provenance, not a lightweight status poll.
  await page.evaluate(async () => (await import("/src/lib/api.ts")).invalidateImages());
  await page.waitForResponse(response => response.url().includes("/api/flux2/status") && response.url().includes("images=1"));
  await button("Library").click();
  await button("Review audit-1.png").click();
  await page.locator(".image-viewer summary").click();
  await button("Remix in new thread").click();
  await page.locator(".composer-reference img").waitFor();
  assert.equal(
    await page.locator(".composer-reference img").getAttribute("src"),
    originalReference,
  );
  await button("Library").click();
  await page.evaluate(() => {
    window.studio.openOutputsFolder = async () => {
      throw new Error("Access denied");
    };
  });
  await button("Open folder").click();
  assert.match(
    await page.locator(".notification.is-error").innerText(),
    /Access denied/,
  );
  await button("Open command palette").click();
  const search = page.getByRole("combobox", { name: "Search Fern commands" });
  await search.focus();
  const before = await search.getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  const after = await search.getAttribute("aria-activedescendant");
  assert.notEqual(before, after);
  assert.equal(
    await page.locator(`#${after}`).getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Escape");
  await button("Stable title").click();
  state.job = {
    id: "logs",
    threadId: "study",
    status: "running",
    startedAt: Date.now() / 1000,
    logs: Array.from({ length: 80 }, (_, i) => `Activity ${i}`),
    output: null,
  };
  await page.waitForTimeout(3300);
  await page.locator(".activity-terminal-header").click();
  await page.locator(".activity-terminal-body").evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  state.job.logs = [...state.job.logs, "A later entry"];
  await page.waitForTimeout(900);
  assert(
    await page
      .locator(".activity-terminal-body")
      .evaluate((el) => el.scrollTop < 10),
  );
  await button("Jump to latest").click();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: cross-thread recipe Undo, recipe recovery after navigation, early reference limits/preservation, original reference restoration, OS errors, palette semantics, and log scroll retention.",
  );
} finally {
  await close();
}
