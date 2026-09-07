import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fixture } from "./ui-fixture.mjs";
const measurements = [];
for (const [imageCount, threadCount] of [
  [100, 100],
  [1000, 500],
]) {
  const { page, state, errors, dir, close } = await fixture({
    imageCount,
    threadCount,
  });
  try {
    await page.evaluate(() => {
      window.inputFrames = [];
      document.querySelector("#prompt").addEventListener("input", () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          window.inputFrames.push(performance.now() - start),
        );
      });
    });
    await page
      .locator("#prompt")
      .pressSequentially(" A deliberate edit to this draft.", { delay: 12 });
    await page.waitForTimeout(350);
    const latency = await page.evaluate(() =>
      window.inputFrames.sort((a, b) => a - b),
    );
    const start = performance.now();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.locator(".thumb").first().waitFor();
    const openLibraryMs = performance.now() - start;
    assert.equal(await page.locator(".thumb").count(), 48);
    const searchStart = performance.now();
    await page
      .getByRole("searchbox", { name: "Filter images" })
      .fill(`prompt ${imageCount}`);
    await page.waitForFunction(
      () => document.querySelectorAll(".thumb").length === 1,
    );
    const filterMs = performance.now() - searchStart;
    await page
      .getByRole("button", { name: "Search threads", exact: true })
      .click();
    assert.equal(
      await page.locator(".thread-browser-list article").count(),
      60,
    );
    await page
      .getByRole("searchbox", { name: "Find a thread" })
      .fill(`number ${threadCount - 1}`);
    assert.equal(await page.locator(".thread-browser-list article").count(), 1);
    await page
      .getByRole("button", { name: "Close threads", exact: true })
      .click();
    state.job = {
      id: "scale-job",
      threadId: "study",
      status: "running",
      startedAt: Date.now() / 1000,
      logs: ["Batch image 1/1", "Step 1/4"],
      output: null,
    };
    const before = { calls: state.statusCalls, listings: state.imageListings };
    await page.waitForTimeout(5500);
    const statusCalls = state.statusCalls - before.calls,
      imageListings = state.imageListings - before.listings;
    assert(
      imageListings < statusCalls,
      "Fast job polls must not repeatedly transfer the gallery",
    );
    assert.deepEqual(errors, []);
    measurements.push({
      imageCount,
      threadCount,
      inputToFrameP95Ms: +latency[Math.floor(latency.length * 0.95)].toFixed(1),
      openLibraryMs: +openLibraryMs.toFixed(1),
      filterMs: +filterMs.toFixed(1),
      renderedGalleryCards: 48,
      renderedThreadRows: 60,
      statusCalls,
      imageListings,
    });
    await writeFile(
      `${dir}/scale-results.json`,
      JSON.stringify(measurements, null, 2),
    );
  } finally {
    await close();
  }
}
console.log(JSON.stringify(measurements, null, 2));
