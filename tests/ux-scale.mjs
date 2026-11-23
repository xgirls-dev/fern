import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fixture } from "./ui-fixture.mjs";
const measurements = [];
const builtRenderer = process.env.FERN_UI_BUILT === "1";
for (const [imageCount, threadCount] of [
  [100, 100],
  [1000, 500],
]) {
  const { page, state, errors, dir, close } = await fixture({
    imageCount,
    threadCount,
    builtRenderer,
  });
  try {
    await page.locator(".stage-image").waitFor();
    await page.evaluate(() => {
      window.inputFrames = [];
      window.rendererTimings = {};
      const measureGallery = (element, event, key, ready) => {
        element.addEventListener(event, () => {
          const start = performance.now();
          const observer = new MutationObserver(() => {
            if (!ready()) return;
            observer.disconnect();
            requestAnimationFrame(() => {
              window.rendererTimings[key] = performance.now() - start;
            });
          });
          observer.observe(document.querySelector("#root"), { childList: true, subtree: true });
        }, { once: true });
      };
      const navigation = document.querySelector('button[aria-label="Images"]');
      measureGallery(navigation, "click", "openLibraryMs", () => document.querySelector(".thumb"));
      navigation.addEventListener("click", () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (!navigation.matches('[aria-busy="true"], [aria-current="page"]')) return;
          observer.disconnect();
          requestAnimationFrame(() => {
            window.rendererTimings.openLibraryAcknowledgmentMs = performance.now() - start;
          });
        });
        observer.observe(navigation, { attributeFilter: ["aria-busy", "aria-current"] });
      }, { once: true });

      document.querySelector("#prompt").addEventListener("input", () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          window.inputFrames.push(performance.now() - start),
        );
      });
    });
    const prompt = page.locator("#prompt");
    await prompt.focus();
    await page.keyboard.press("End");
    const edits = Array.from({ length: 24 }, (_, index) => ` ${index}`);
    for (const [index, text] of edits.entries()) {
      await page.keyboard.insertText(text);
      await page.waitForFunction((count) => window.inputFrames.length >= count, index + 1);
    }
    assert.equal(await prompt.inputValue(), "Original unfinished draft" + edits.join(""));
    const latency = await page.evaluate(() =>
      window.inputFrames.sort((a, b) => a - b),
    );
    assert.equal(latency.length, edits.length, "Each edit needs one input frame sample");
    await page.getByRole("button", { name: "Images", exact: true }).click();
    await page.locator(".thumb").first().waitFor();
    await page.waitForFunction(() => window.rendererTimings.openLibraryMs !== undefined &&
      window.rendererTimings.openLibraryAcknowledgmentMs !== undefined);
    assert.equal(await page.locator(".thumb").count(), 48);
    assert.equal(await page.locator('[role="menu"][aria-label="Image actions"]').count(), 0, "Closed card menus must stay unmounted");
    await page.evaluate(() => {
      document.querySelector('[aria-label="Filter images"]').addEventListener("input", () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (document.querySelectorAll(".thumb").length !== 1) return;
          observer.disconnect();
          requestAnimationFrame(() => { window.rendererTimings.filterMs = performance.now() - start; });
        });
        observer.observe(document.querySelector("#recent-renders"), { childList: true, subtree: true });
      }, { once: true });
    });
    await page
      .getByRole("searchbox", { name: "Filter images" })
      .fill(`prompt ${imageCount}`);
    await page.waitForFunction(
      () => document.querySelectorAll(".thumb").length === 1,
    );
    await page.waitForFunction(() => window.rendererTimings.filterMs !== undefined);
    const timings = await page.evaluate(() => window.rendererTimings);
    await page
      .getByRole("button", { name: "Search threads", exact: true })
      .click();
    const threadSearch = page.getByRole("searchbox", { name: "Find a thread" });
    await threadSearch.waitFor();
    assert.equal(
      await page.locator(".thread-browser-list article").count(),
      60,
    );
    await threadSearch.fill(`number ${threadCount - 1}`);
    assert.equal(await page.locator(".thread-browser-list article").count(), 1);
    await page
      .getByRole("button", { name: "Close thread search", exact: true })
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
      renderer: builtRenderer ? "production" : "development",
      inputSamples: latency.length,
      inputToFrameMedianMs: +latency[Math.floor(latency.length / 2)].toFixed(1),
      inputToFrameP95Ms: +latency[Math.ceil(latency.length * 0.95) - 1].toFixed(1),
      openLibraryAcknowledgmentMs: +timings.openLibraryAcknowledgmentMs.toFixed(1),
      openLibraryMs: +timings.openLibraryMs.toFixed(1),
      filterMs: +timings.filterMs.toFixed(1),
      renderedGalleryCards: 48,
      renderedThreadRows: 60,
      statusCalls,
      imageListings,
    });
    await writeFile(
      `${dir}/scale-results${builtRenderer ? "-production" : ""}.json`,
      JSON.stringify(measurements, null, 2),
    );
  } finally {
    await close();
  }
}
console.log(JSON.stringify(measurements, null, 2));
