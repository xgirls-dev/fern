import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";
const { page, state, errors, dir, close } = await fixture({ imageGenerationTime: 479.5 });
const button = (name) => page.getByRole("button", { name, exact: true });
try {
  // A failed initial connection followed by a slow status response must keep loading visible.
  let calls = 0;
  let release = false;
  const delayStatus = async (route) => {
    calls++;
    if (calls === 1) return route.abort("connectionrefused");
    while (!release) await new Promise((resolve) => setTimeout(resolve, 50));
    return route.fallback();
  };
  await page.route("**/api/flux2/status*", delayStatus);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#prompt").waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert(await page.locator(".runtime-banner").isVisible());
  assert.equal(await page.locator(".creation-canvas").count(), 1);
  release = true;
  await page.locator(".stage-image").waitFor();
  await page.unroute("**/api/flux2/status*", delayStatus);

  await page.locator(".workspace-header").getByRole("button", { name: "Image settings", exact: true }).click();
  await page
    .getByRole("group", { name: "Inspector view" })
    .getByRole("button", { name: "Selected image", exact: true })
    .click();
  assert.equal(await page.locator(".generation-inspector:visible").count(), 1);
  assert.equal(await page.locator("#width").isVisible(), false);
  assert(await page.locator(".render-metadata").isVisible());
  assert.equal(await page.locator(".preview-metadata-hud-header").count(), 0);
  await page.screenshot({ path: `${dir}/shared-inspector.png` });
  await page
    .getByRole("group", { name: "Inspector view" })
    .getByRole("button", { name: "Next image", exact: true })
    .click();
  assert(await page.locator("#width").isVisible());
  await button("Close image settings").click();

  await button("Images").click();
  const firstCard = page.locator(".thumb-wrap").filter({ has: button(/^Review.*audit-1\.png$/) });
  await firstCard.hover();
  await firstCard.getByRole("button", { name: "Image actions for audit-1.png", exact: true }).click();
  await page.getByRole("menu", { name: "Image actions", exact: true }).getByRole("menuitem", { name: "Remix", exact: true }).click();
  await page.waitForTimeout(300);
  const workspace = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fern-threads:v1")),
  );
  assert.equal(workspace.threads.length, 1);
  assert.match(
    await page.locator("#prompt").inputValue(),
    /Original image prompt/,
  );
  assert.equal(workspace.threads[0].settings.width, 1024);
  await button("Undo").click();
  assert.equal(
    await page.locator("#prompt").inputValue(),
    "Original unfinished draft",
  );

  const row = page.locator(".sidebar-thread-row").first();
  await row.hover();
  const action = row.locator(".sidebar-thread-actions-trigger");
  const actionBox = await action.boundingBox();
  const threadBox = await row.locator(".sidebar-thread-button").boundingBox();
  assert.equal(await action.locator("svg").count(), 1);
  assert(actionBox && actionBox.height >= 26 && actionBox.width >= 26);
  assert(threadBox && threadBox.x + threadBox.width <= actionBox.x + 1, "thread title and action remain separate");

  await button("Images").click();
  await button(/^Review.*audit-1\.png$/).click();
  await button("Render info").click();
  assert(await page.locator(".viewer-info .render-metadata").isVisible());
  await page.getByText("8m", { exact: true }).waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".viewer-details .render-metadata").count(),
    0,
  );
  await page.locator(".image-viewer").getByRole("button", { name: /^Image actions for / }).click();
  await page.locator(".viewer-info h3").click();
  await page.getByRole("menu", { name: "Image actions", exact: true }).waitFor({ state: "detached" });
  await page.screenshot({ path: `${dir}/viewer-polish.png` });
  await button("100%").click();
  assert.equal(
    await page
      .locator(".viewer-canvas img")
      .evaluate((el) => el.getBoundingClientRect().width),
    1920,
  );
  for (const [width, height] of [
    [1080, 720],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(({ width, height }) => {
      const close = document.querySelector('button[aria-label="Close preview"]');
      const box = close?.getBoundingClientRect();
      return window.innerWidth === width && window.innerHeight === height &&
        box?.width > 0 && box.left >= 0 && box.right <= width && box.top >= 0 && box.bottom <= height;
    }, { width, height });
    await page.screenshot({ path: `${dir}/viewer-polish-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await button("Close preview").click();
  await button("Stable title").click();
  await button("Render info").click();
  const selected = page.getByRole("complementary", { name: "Selected image" });
  await selected.getByText("1920 x 1088", { exact: true }).waitFor();
  await selected.getByRole("button", { name: "Use render settings" }).click();
  const nextImage = page.getByRole("complementary", { name: "Next image" });
  assert.equal(await nextImage.getByRole("spinbutton", { name: "Width", exact: true }).inputValue(), "1920");
  assert.equal(await nextImage.getByRole("spinbutton", { name: "Height", exact: true }).inputValue(), "1088");
  assert.equal(await page.locator("#prompt").inputValue(), "Original unfinished draft");
  await button("Close image settings").click();

  await page.evaluate(async () => {
    const { notify } = await import("/src/lib/notifications.ts");
    for (let i = 0; i < 6; i++)
      notify(`Notice ${i}`, i === 5 ? "error" : "info");
  });
  assert.equal(await page.locator(".notification").count(), 3);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(8300);
  assert.equal(await page.locator(".notification").count(), 0);

  state.job = {
    id: "polish",
    threadId: "study",
    status: "running",
    startedAt: Date.now() / 1000,
    output: null,
    logs: ["Batch image 2/4", "Step 2/4"],
  };
  await page.waitForTimeout(3300);
  const spinner = await page
    .locator(".composer-submit .spinner")
    .evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        size: el.getBoundingClientRect().width,
        border: css.borderTopColor,
        color: getComputedStyle(el.parentElement).color,
        opacity: getComputedStyle(el.parentElement).opacity,
      };
    });
  assert.equal(spinner.size, 16);
  assert.equal(spinner.border, spinner.color);
  assert.equal(spinner.opacity, "1");
  assert.equal(
    await page.getByRole("progressbar").getAttribute("aria-valuenow"),
    "38",
  );
  await page.screenshot({ path: `${dir}/generation-polish.png` });
  await button("Toggle theme").click();
  await page.screenshot({ path: `${dir}/generation-polish-dark.png` });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: initial connection gap, shared inspector, prompt-only Remix and Undo, sidebar icons, viewer layout/menu dismissal, capped expiring toasts, visible spinner and batch progress.",
  );
} catch (error) {
  await page.screenshot({ path: `${dir}/polish-failure.png` });
  throw error;
} finally {
  await close();
}
