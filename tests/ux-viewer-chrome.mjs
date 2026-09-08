import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";
const { page, dir, errors, close } = await fixture();
try {
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: "Review audit-1.png", exact: true })
    .click();
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
        const popup = details.querySelector(".image-menu-content");
        details.querySelector("summary").focus();
        details.querySelector("summary").click();
        const visible = [];
        for (let frame = 0; frame < 15; frame++) {
          await new Promise(requestAnimationFrame);
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
