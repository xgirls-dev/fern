import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";
import { openSelect } from "./select-option.mjs";

const { page, state, errors, close } = await fixture();
try {
  await page.locator(".workspace-header").getByRole("button", { name: "Image settings", exact: true }).click();
  await page.locator("#width").fill("720");
  await page.locator("#height").fill("1280");

  state.installedModels = [
    { id: "9b", label: "Klein 9B" },
    { id: "qwen21-turbo", label: "Qwen Image 2.1 Turbo" },
  ];
  await page.waitForResponse((response) =>
    response.url().includes("/api/flux2/status"),
  );
  const modelTrigger = page.getByRole("button", { name: /Image model:/ });
  await modelTrigger.click();
  await page
    .getByRole("menuitemradio", { name: "Qwen Image 2.1 Turbo" })
    .click();

  assert.equal(await page.locator("#width").inputValue(), "736");
  assert.equal(await page.locator("#height").inputValue(), "1280");
  assert.equal(await page.locator("#width").getAttribute("step"), "32");
  assert.equal(await page.locator("#height").getAttribute("step"), "32");
  const resolution = page.getByRole("combobox", { name: "Resolution", exact: true });
  const presets = await openSelect(resolution);
  const labels = await presets.getByRole("option").allTextContents();
  assert(!labels.some((label) => /^(720 × 1280|1280 × 720)\b/.test(label)));
  assert(labels.includes("Custom"));
  await resolution.press("Escape");
  await presets.waitFor({ state: "detached" });

  await modelTrigger.click();
  await page.getByRole("menuitemradio", { name: "Klein 9B", exact: true }).click();
  assert.equal(await page.locator("#width").inputValue(), "720");
  assert.equal(await page.locator("#height").inputValue(), "1280");
  assert.deepEqual(errors, []);
  console.log("Qwen resolution presets, alignment, and model-switch restoration passed");
} finally {
  await close();
}
