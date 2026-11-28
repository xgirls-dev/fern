import { chooseSelectOption, openSelect } from "./select-option.mjs";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
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
  await page.locator(".workspace-header").getByRole("button", { name: "Image settings", exact: true }).click();
  assert.equal(await page.locator("#device").count(), 0);
  await chooseSelectOption(page.locator("#size-preset"), "Custom");
  assert.equal(await page.locator("#size-preset").innerText(), "Custom");
  await chooseSelectOption(page.locator("#size-preset"), "720 × 1280 · Portrait 9:16");
  assert.equal(await page.locator("#width").inputValue(), "720");
  await chooseSelectOption(page.locator("#size-preset"), "1920 × 1088 · Wide");
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
  await page.locator("#width-error").waitFor({ state: "visible", timeout: 10_000 });
  assert(await page.locator("#width-error").isVisible());
  await page.locator("#width").fill("1920");
  await page.locator("summary").filter({ hasText: "Style & recipes" }).click();
  await chooseSelectOption(page.getByRole("combobox", { name: "Prompt recipe" }), "Editorial portrait · Fern");
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
  await page.locator(".output-bar").getByRole("button", { name: /^Image actions for / }).click();
  await page.getByRole("menu", { name: "Image actions", exact: true }).getByRole("menuitem", { name: "Open output folder", exact: true }).click();
  await page.getByText("Opened output folder.", { exact: true }).waitFor();
  assert.equal(await page.locator(".output-action-message").count(), 0);
  await button("Dismiss notification").click();
  await page.locator(".output-bar").getByRole("button", { name: /^Image actions for / }).click();
  await page.getByRole("menu", { name: "Image actions", exact: true }).getByRole("menuitem", { name: "Remix in new thread", exact: true }).click();
  await page.waitForTimeout(400);
  const workspace = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fern-threads:v1")),
  );
  assert.equal(workspace.threads.length, 2);
  assert.equal(
    workspace.threads.find((t) => t.id === "study").settings.prompt,
    "Draft after generation",
  );
  await button("Images").click();
  await page.getByRole("searchbox", { name: "Filter images" }).fill("prompt 2");
  assert.equal(
    await page.locator(".gallery-panel-count").innerText(),
    "1 of 3 images",
  );
  await button(/^Review.*audit-2\.png$/).click();
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
  await page.locator(".image-viewer").getByRole("button", { name: /^Image actions for / }).click();
  await page.getByRole("menu", { name: "Image actions", exact: true }).getByRole("menuitem", { name: "Delete image", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  assert.equal(await page.locator(".image-viewer").count(), 1);
  await page.locator(".image-viewer").getByRole("button", { name: /^Image actions for / }).click();
  await page.getByRole("menu", { name: "Image actions", exact: true }).getByRole("menuitem", { name: "Delete image", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete image", exact: true })
    .click();
  await page.waitForTimeout(400);
  assert.equal(state.images.length, 2);
  assert.equal(await page.locator(".image-viewer").count(), 0);
  await button("Preferences").click();
  const devicePreference = page.getByLabel("Generation device");
  assert.equal(await devicePreference.innerText(), "Available GPU");
  assert.deepEqual(await (await openSelect(devicePreference)).getByRole("option").allTextContents(), ["Available GPU", "CPU"]);
  await devicePreference.press("Escape");
  await chooseSelectOption(devicePreference, "CPU");
  await page.getByText("Image creation in chat is unavailable with CPU selected.", { exact: true }).waitFor();
  await chooseSelectOption(devicePreference, "Available GPU");
  assert.equal(await devicePreference.innerText(), "Available GPU");
  assert.equal(await page.locator("#device").count(), 0);
  await button("Images").click();
  assert.equal(
    await page.getByRole("searchbox", { name: "Filter images" }).inputValue(),
    "prompt 2",
  );
  await page.getByRole("searchbox", { name: "Filter images" }).fill("");
  const imageSearch = page.getByRole("searchbox", { name: "Filter images" });
  await imageSearch.fill("no matching image");
  await page.getByText("No matching images", { exact: true }).waitFor();
  await button("Clear search").click();
  assert.equal(await imageSearch.inputValue(), "");
  assert.equal(await imageSearch.evaluate((element) => element === document.activeElement), true, "clearing a search returns focus to the search field");
  // A gallery-card deletion must be a full viewport dialog, not clipped inside its card.
  await page.locator(".thumb-wrap").first().getByRole("button", { name: /^Image actions for / }).click();
  await page.getByRole("menu", { name: "Image actions", exact: true }).getByRole("menuitem", { name: "Delete image", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
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
    await page.locator(".workspace-header").getByRole("button", { name: "Image settings", exact: true }).click();
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
  const activeImageThreadId = await page.locator('.sidebar-thread-button[aria-current="page"]').getAttribute("data-thread-id");
  state.job = {
    id: "batch",
    threadId: activeImageThreadId,
    status: "running",
    startedAt: Date.now() / 1000,
    logs: ["Batch image 1/4", "Step 4/4", "Batch image 2/4"],
    output: null,
  };
  try {
    await page.locator(".generation-progress-strip").waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    console.error(`Progress diagnostic: active=${activeImageThreadId} calls=${state.statusCalls} job=${JSON.stringify(state.job)}`);
    throw error;
  }
  assert.match(
    await page.locator(".generation-progress-strip").innerText(),
    /Image 2 of 4.*preparing/,
  );
  await expect(page.locator(".workspace-header").getByRole("button", { name: "Stop generation" })).toBeVisible();
  await expect(page.locator(".creation-canvas .generation-progress-strip")).toHaveCount(0);
  await page.screenshot({ path: `${dir}/image-progress-compact.png` });
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.screenshot({ path: `${dir}/image-progress-wide.png` });
  await page.setViewportSize({ width: 1080, height: 720 });
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
  assert.equal(await page.getByRole("dialog").count(), 0);
  await button("Images").click();
  await page.locator("#library-view").waitFor();
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
