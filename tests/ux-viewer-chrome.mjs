import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";
const { page, dir, errors, close } = await fixture();
try {
  await page.getByRole("button", { name: "Images", exact: true }).click();
  const firstImage = page.getByRole("button", { name: /^Review.*audit-1\.png$/, exact: true });
  await firstImage.waitFor();
  for (const [width, height] of [[1440, 920], [864, 547], [800, 491]]) {
    await page.setViewportSize({ width, height });
    const title = await page.getByRole("heading", { name: "Images", exact: true }).boundingBox();
    const toolbar = await page.getByRole("button", { name: "Select", exact: true }).boundingBox();
    const firstTile = await page.locator(".history-grid .thumb").first().boundingBox();
    const create = await page.getByRole("button", { name: "Create image", exact: true }).boundingBox();
    assert(Math.abs(title.x - toolbar.x) < 1 && Math.abs(title.x - firstTile.x) < 1, "Align title, filters and image grid");
    assert(create.width < 160 && create.y < title.y + title.height && title.y < create.y + create.height, "Keep creation beside the title");
    const caption = await page.locator(".history-grid .thumb-meta").first().boundingBox();
    const scrollport = await page.locator(".gallery-panel-body").boundingBox();
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
  const imageActions = viewer.getByLabel("Image actions for audit-1.png");
  await imageActions.focus();
  await page.keyboard.press("Enter");
  await viewer.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await viewer.locator(".image-menu-content").waitFor({ state: "detached" });
  assert(await imageActions.evaluate((element) => element === document.activeElement));
  await imageActions.click();
  await viewer.getByRole("button", { name: "Delete image", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Delete image", exact: true });
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await confirmation.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Image actions for audit-1.png");
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
      const positions = await page.evaluate(async () => {
        const details = document.querySelector(".image-viewer details");
        details.querySelector("summary").focus();
        details.querySelector("summary").click();
        const visible = [];
        for (let frame = 0; frame < 15; frame++) {
          await new Promise(requestAnimationFrame);
          const popup = details.querySelector(".image-menu-content");
          if (!popup) continue;
          const css = getComputedStyle(popup);
          if (
            details.open &&
            css.visibility === "visible" &&
            popup.checkVisibility()
          ) {
            const r = popup.getBoundingClientRect();
            visible.push({
              x: r.x,
              y: r.y,
              right: r.right,
              bottom: r.bottom,
              inline: popup.style.top,
              anchor: details.getBoundingClientRect().bottom,
              vh: innerHeight,
            });
          }
        }
        return visible;
      });
      assert(positions.length > 0);
      assert(
        positions.every(
          (p) =>
            Math.abs(p.x - positions[0].x) < 1 &&
            Math.abs(p.y - positions[0].y) < 1,
        ),
        JSON.stringify({ width, repeat, positions }),
      );
      if (positions.some((p) => p.bottom > height))
        console.log(
          await page
            .locator(".image-viewer .image-menu-content")
            .evaluate((el) => {
              const a = [];
              for (let p = el; p; p = p.parentElement) {
                const c = getComputedStyle(p);
                a.push({
                  cls: p.className,
                  top: c.top,
                  pos: c.position,
                  filter: c.filter,
                  backdrop: c.backdropFilter,
                  transform: c.transform,
                  contain: c.contain,
                  will: c.willChange,
                  rect: p.getBoundingClientRect().toJSON(),
                });
              }
              return a;
            }),
        );
      assert(
        positions.every(
          (p) =>
            p.y >= geometry.title &&
            p.x >= 0 &&
            p.right <= width &&
            p.bottom <= height,
        ),
        JSON.stringify({ width, geometry, positions }),
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.locator(".image-viewer details[open]").count(),
        0,
      );
    }
    await page.screenshot({ path: `${dir}/viewer-chrome-${width}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: viewer stays below the native title bar; dropdown first visible frame is stable and within the viewport on open/reopen at three sizes.",
  );
} finally {
  await close();
}
