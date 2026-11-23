import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";
const { page, dir, errors, close } = await fixture();
try {
  await page.getByRole("button", { name: "Images", exact: true }).click();
  const firstImage = page.getByRole("button", { name: /^Review.*audit-1\.png$/, exact: true });
  await firstImage.waitFor();
  for (const [width, height] of [[1440, 920], [864, 547], [800, 491]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: width <= 900 ? "Expand sidebar" : "Collapse sidebar", exact: true }).waitFor();
    const { title, toolbar, firstTile, create, caption, scrollport } = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
      return {
        title: rect(".library-view-header h2"),
        toolbar: rect(".gallery-panel-tools button"),
        firstTile: rect(".history-grid .thumb"),
        create: rect(".library-view-header .workspace-header-actions button:last-child"),
        caption: rect(".history-grid .thumb-meta"),
        scrollport: rect(".gallery-panel-body"),
      };
    });
    assert(Math.abs(title.x - toolbar.x) < 1 && Math.abs(title.x - firstTile.x) < 1,
      `Align title, filters and image grid at ${width} × ${height}: ${title.x}, ${toolbar.x}, ${firstTile.x}`);
    assert(create.width < 160 && create.y < title.y + title.height && title.y < create.y + create.height, "Keep creation beside the title");
    assert(caption.y + caption.height <= scrollport.y + scrollport.height, "Keep the first row's artwork and its review controls visible");
  }
  await firstImage.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const focusRing = await firstImage.evaluate((image) => {
    const style = getComputedStyle(image);
    return { width: style.outlineWidth, offset: style.outlineOffset };
  });
  assert.deepEqual(focusRing, { width: "2px", offset: "-3px" });
  await firstImage.press("Enter");
  const viewer = page.getByRole("dialog", { name: /^Review image \d+ of \d+:/ });
  const imageActions = viewer.getByRole("button", { name: "Image actions for audit-1.png", exact: true });
  const menu = viewer.getByRole("menu", { name: "Image actions", exact: true });
  await imageActions.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Remix in new thread" })).toBeFocused();
  await expect(viewer.getByRole("button", { name: "Previous", exact: true })).toBeEnabled();
  await page.keyboard.press("ArrowLeft");
  await expect(imageActions).toBeVisible();
  await page.keyboard.press("c");
  await expect(menu.getByRole("menuitem", { name: "Copy prompt" })).toBeFocused();
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "detached" });
  await expect(imageActions).toBeFocused();
  await page.getByText("Prompt copied.", { exact: true }).waitFor();
  await imageActions.click();
  await menu.getByRole("menuitem", { name: "Delete image", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Move image to Recycle Bin?", exact: true });
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await confirmation.waitFor({ state: "detached" });
  await expect(imageActions).toBeFocused();
  await page.evaluate(() => { window.studio.deleteOutputImage = async () => { throw new Error("Image is in use."); }; });
  await imageActions.click();
  await menu.getByRole("menuitem", { name: "Delete image", exact: true }).click();
  await confirmation.getByRole("button", { name: "Delete image", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toHaveText("Image is in use.");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(imageActions).toBeFocused();
  for (const [width, height] of [
    [1440, 900],
    [1080, 720],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const geometry = await page.evaluate(() => ({
      title: document.querySelector(".titlebar").getBoundingClientRect().bottom,
      backdrop: document
        .querySelector(".lightbox-backdrop")
        .getBoundingClientRect().top,
      close: document
        .querySelector('[aria-label="Close preview"]')
        .getBoundingClientRect().top,
    }));
    assert(geometry.backdrop >= geometry.title);
    assert(geometry.close >= geometry.title + 12);
    for (let repeat = 0; repeat < 2; repeat++) {
      const positions = await imageActions.evaluate(async (trigger) => {
        trigger.focus();
        trigger.click();
        const popupSelector = '[role="menu"][aria-label="Image actions"]';
        const visible = [];
        for (let frame = 0; frame < 15; frame++) {
          await new Promise(requestAnimationFrame);
          const popup = trigger.closest(".image-viewer").querySelector(popupSelector);
          if (popup?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
            const { x, y, right, bottom } = popup.getBoundingClientRect();
            visible.push({ x, y, right, bottom });
          }
        }
        return visible;
      });
      assert(positions.length > 0);
      assert(
        positions.every((p) => Math.abs(p.x - positions[0].x) < 1 && Math.abs(p.y - positions[0].y) < 1),
        JSON.stringify({ width, repeat, positions }),
      );
      assert(
        positions.every((p) => p.y >= geometry.title && p.x >= 0 && p.right <= width && p.bottom <= height),
        JSON.stringify({ width, geometry, positions }),
      );
      if (width === 390 && repeat === 0) await page.screenshot({ path: `${dir}/viewer-image-actions-390.png` });
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      await expect(imageActions).toBeFocused();
    }
    await page.screenshot({ path: `${dir}/viewer-chrome-${width}.png` });
  }
  const closePreview = viewer.getByRole("button", { name: "Close preview", exact: true });
  await closePreview.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: /^Close preview$/ })).toBeVisible();
  await closePreview.focus();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(firstImage).toBeFocused();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: viewer stays below the native title bar; dropdown first visible frame is stable and within the viewport on open/reopen at three sizes.",
  );
} finally {
  await close();
}
