import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";
const { page, state, errors, dir, close } = await fixture();
const button = (name) => page.getByRole("button", { name, exact: true });
try {
  state.runtime = {
    status: "idle",
    message: "Model loads on first generation",
    logs: [],
  };
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("textbox", { name: "Seed", exact: true }).fill("123456");
  await button("Generate image").click();
  assert.equal(state.payloads.at(-1).seed, 123456);
  state.runtime = { status: "loading", message: "Loading model", logs: [] };
  state.job = {
    id: "loading",
    threadId: "study",
    status: "running",
    startedAt: Date.now() / 1000,
    logs: ["Loading model"],
    output: null,
  };
  await page.waitForTimeout(3300);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await button("Library").click();
  assert(await page.locator(".history-grid").isVisible());
  await button("Stop generation").click();
  assert.equal(state.job.status, "cancelled");
  state.runtime = { status: "idle", message: "Ready", logs: [] };
  const selectedPng = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    return canvas.toDataURL("image/png");
  });
  await page.route("**/outputs/audit-2.png*", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(selectedPng.split(",")[1], "base64"),
    }),
  );
  state.images[1].url = "/outputs/audit-2.png";
  await page.evaluate(async () =>
    (await import("/src/lib/api.ts")).invalidateImages(),
  );
  await page.waitForResponse(
    (response) =>
      response.url().includes("/api/flux2/status") &&
      response.url().includes("images=1"),
  );
  const card = page
    .locator(".thumb-wrap")
    .filter({ has: button("Review audit-2.png") });
  await card.getByRole("button", { name: "Full prompt", exact: true }).click();
  assert(await card.locator(".thumb-prompt.is-expanded").isVisible());
  await page.screenshot({ path: `${dir}/gallery-prompt-actions.png` });
  await card.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await card.getByRole("button", { name: "Select", exact: true }).click();
  assert.equal(
    await page.locator("#prompt").inputValue(),
    "Original image prompt 2",
  );
  await page.locator(".stage-image").waitFor();
  assert.equal(
    await page.locator(".stage-image").getAttribute("alt"),
    "Original image prompt 2",
  );
  await page.waitForTimeout(3300);
  assert.equal(
    await page.locator(".stage-image").getAttribute("alt"),
    "Original image prompt 2",
  );
  await button("Image settings").click();
  await page.locator("summary").filter({ hasText: "Reference Image" }).click();
  assert.equal(
    await page.getByRole("button", { name: /Use Current Output/i }).isEnabled(),
    true,
  );
  await page.getByRole("button", { name: /Use Current Output/i }).click();
  await page.locator(".composer-reference img").waitFor();
  await button("Close image settings").click();
  await page.screenshot({ path: `${dir}/selected-image-seed.png` });
  const title = await page.locator("#create-heading").innerText();
  await page.locator(".sidebar-thread-row").first().hover();
  await page
    .getByRole("button", { name: `Delete thread ${title}`, exact: true })
    .click();
  assert.match(
    await page.locator(".thread-delete-confirm").innerText(),
    /permanently deleted/,
  );
  await button("Delete thread").click();
  await page.waitForTimeout(400);
  assert.equal(state.images.length, 0);
  assert.equal(await page.locator("#prompt").inputValue(), "");
  const workspace = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fern-threads:v1")),
  );
  assert.equal(workspace.threads.length, 1);
  assert.notEqual(workspace.threads[0].id, "study");
  assert.equal(workspace.threads[0].settings.seed, 42);
  await button("Library").click();
  assert.equal(await page.locator(".thumb-wrap").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: lazy/nonmodal runtime, Stop while viewing Library, composer seed payload, full/copy prompt, persistent image selection, editing access and complete thread deletion.",
  );
} catch (error) {
  await page.screenshot({ path: `${dir}/lifecycle-failure.png` });
  throw error;
} finally {
  await close();
}
