import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fixture } from "./ui-fixture.mjs";
const { page, state, errors, dir, close } = await fixture();
const button = (name) => page.getByRole("button", { name, exact: true });
try {
  assert.equal(
    await page.locator(".sidebar-runtime,.thread-search").count(),
    0,
  );
  await button("Search threads").click();
  await page.screenshot({ path: `${dir}/search-dialog.png` });
  assert(
    await page
      .getByRole("searchbox", { name: "Find a thread" })
      .evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Escape");
  await page.locator("#prompt").fill("New draft");
  assert.equal(
    await page.locator("#create-heading").innerText(),
    "Stable title",
  );
  await button("Generate image").click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#create-heading").innerText(), "New draft");
  await page.locator("#prompt").fill("Draft after generation");
  assert.equal(await page.locator("#create-heading").innerText(), "New draft");
  await button("Image settings").click();
  assert.equal(
    await page.locator("#device option").last().innerText(),
    "NVIDIA GPU",
  );
  await page.locator("#size-preset").selectOption("custom");
  assert.equal(await page.locator("#size-preset").inputValue(), "custom");
  await page.locator("#size-preset").selectOption("720x1280");
  assert.equal(await page.locator("#width").inputValue(), "720");
  await page.locator("#size-preset").selectOption("1920x1088");
  assert.equal(await page.locator("#height").inputValue(), "1088");
  await page.locator("#width").fill("1080");
  await button("Close image settings").click();
  await button("Generate image").click();
  await page.waitForTimeout(100);
  assert(
    await page
      .locator("#width")
      .evaluate((el) => el === document.activeElement),
  );
  await page.waitForTimeout(3300);
  assert(await page.locator("#width-error").isVisible());
  await page.locator("#width").fill("1920");
  await page.locator("summary").filter({ hasText: "Style & recipes" }).click();
  await page
    .getByRole("combobox", { name: "Prompt recipe" })
    .selectOption("editorial-portrait");
  await button("Undo").click();
  assert.equal(
    await page.locator("#prompt").inputValue(),
    "Draft after generation",
  );
  await button("Close image settings").click();
  await button("Render info").click();
  assert.equal(await page.locator(".render-metadata").count(), 1);
  assert.equal(await page.locator(".preview-metadata-hud").count(), 0);
  await button("Close render info").click();
  await page.locator(".output-bar summary").click();
  await button("Open output folder").click();
  assert(
    await page.getByText("Opened output folder.", { exact: true }).isVisible(),
  );
  assert.equal(await page.locator(".output-action-message").count(), 0);
  await button("Dismiss notification").click();
  await page.locator(".output-bar summary").click();
  await button("Remix in new thread").click();
  await page.waitForTimeout(400);
  const workspace = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fern-threads:v1")),
  );
  assert.equal(workspace.threads.length, 2);
  assert.equal(
    workspace.threads.find((t) => t.id === "study").settings.prompt,
    "Draft after generation",
  );
  await button("Library").click();
  await page.getByRole("searchbox", { name: "Filter images" }).fill("prompt 2");
  assert.equal(
    await page.locator(".gallery-panel-count").innerText(),
    "1 of 3 images",
  );
  await button("Review audit-2.png").click();
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("fern-threads:v1")).threads.length,
    ),
    2,
  );
  await button("100%").click();
  assert.equal(
    await page
      .locator(".viewer-canvas img")
      .evaluate((el) => el.getBoundingClientRect().width),
    1920,
  );
  await button("Fit").click();
  await page.screenshot({ path: `${dir}/viewer.png` });
  await page.locator(".image-viewer summary").click();
  await button("Delete image").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  assert.equal(await page.locator(".image-viewer").count(), 1);
  await page.locator(".image-viewer summary").click();
  await button("Delete image").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete image", exact: true })
    .click();
  await page.waitForTimeout(400);
  assert.equal(state.images.length, 2);
  assert.equal(await page.locator(".image-viewer").count(), 0);
  await button("Preferences").click();
  await button("Library").click();
  assert.equal(
    await page.getByRole("searchbox", { name: "Filter images" }).inputValue(),
    "prompt 2",
  );
  await page.getByRole("searchbox", { name: "Filter images" }).fill("");
  // A gallery-card deletion must be a full viewport dialog, not clipped inside its card.
  await page.locator(".thumb-wrap").first().locator("summary").click();
  await button("Delete image").click();
  const dialog = await page.getByRole("alertdialog").boundingBox();
  assert(dialog.width > 300);
  await button("Cancel").click();
  await button("New draft").click();
  await button("Search threads").click();
  await page
    .getByRole("searchbox", { name: "Find a thread" })
    .fill("variation");
  assert.equal(await page.locator(".thread-browser-open").count(), 1);
  await page.keyboard.press("Escape");
  for (const [width, height] of [
    [1440, 900],
    [1080, 720],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await button("Image settings").click();
    await page.screenshot({ path: `${dir}/settings-${width}.png` });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1080, height: 720 });
  await button("Toggle theme").click();
  await page.screenshot({ path: `${dir}/dark-preview.png` });
  state.job = {
    id: "batch",
    threadId: "study",
    status: "running",
    startedAt: Date.now() / 1000,
    logs: ["Batch image 1/4", "Step 4/4", "Batch image 2/4"],
    output: null,
  };
  await page.waitForTimeout(3300);
  assert.match(
    await page.locator(".generation-progress-strip").innerText(),
    /Image 2 of 4.*preparing/,
  );
  assert.equal(
    await page.getByRole("progressbar").getAttribute("aria-valuenow"),
    "25",
  );
  state.runtime = {
    status: "failed",
    message: "Device unavailable",
    device: "CPU",
    logs: [],
  };
  await page.waitForTimeout(900);
  await button("Continue to workspace").click();
  await button("Library").click();
  assert(await page.locator("#library-view").isVisible());
  assert.deepEqual(errors, []);
  await writeFile(
    `${dir}/results.json`,
    JSON.stringify({ passed: true, errors, payloads: state.payloads }, null, 2),
  );
  console.log(
    "PASS: UX workflow regression suite, including logo search dialog, safe draft handling, image review/delete, validation, progress, runtime recovery and layouts.",
  );
} catch (error) {
  await page.screenshot({ path: `${dir}/failure.png` });
  throw error;
} finally {
  await close();
}
