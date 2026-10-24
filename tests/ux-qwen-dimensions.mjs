import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

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
  const presetValues = await page.locator("#size-preset option").evaluateAll(
    (options) => options.map((option) => option.value),
  );
  assert(!presetValues.includes("720x1280"));
  assert(!presetValues.includes("1280x720"));
  assert(presetValues.includes("custom"));

  await modelTrigger.click();
  await page.getByRole("menuitemradio", { name: "Klein 9B" }).click();
  assert.equal(await page.locator("#width").inputValue(), "720");
  assert.equal(await page.locator("#height").inputValue(), "1280");
  assert.deepEqual(errors, []);
  console.log("Qwen resolution presets, alignment, and model-switch restoration passed");
} finally {
  await close();
}
