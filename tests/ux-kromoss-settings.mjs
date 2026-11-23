import { chooseSelectOption } from "./select-option.mjs";
import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const model = {
  id: "kromoss-opd-dmd2", label: "Kromoss OPD · DMD2", installed: true, category: "image",
  defaultWidth: 512, defaultHeight: 512, defaultSteps: 8, defaultGuidance: 1,
};
const { page, errors, close } = await fixture({ installedModels: [model] });
const button = (name) => page.getByRole("button", { name, exact: true });
const width = page.getByLabel("Width", { exact: true });
const height = page.getByLabel("Height", { exact: true });
const steps = page.getByRole("spinbutton", { name: "Step count", exact: true });

try {
  await page.locator(".composer-model-trigger").click();
  await page.getByRole("menuitemradio", { name: model.label, exact: true }).click();
  await button("Image settings").last().click();
  await chooseSelectOption(page.getByLabel("Resolution", { exact: true }), "1024 × 768 · Landscape 4:3");
  assert.deepEqual([await width.inputValue(), await height.inputValue()], ["1024", "768"]);
  await chooseSelectOption(page.getByLabel("Resolution", { exact: true }), "Custom");
  await width.fill("2064");
  await height.fill("912");
  await page.locator("summary").filter({ hasText: "Advanced" }).click();
  assert.equal(await steps.inputValue(), "8");
  await steps.fill("60");
  await page.getByLabel("Image prompt", { exact: true }).fill("A red mug on a tabletop.");
  const submission = page.waitForRequest((request) => request.url().endsWith("/api/flux2/generate"));
  await button("Generate image").click();
  const payload = (await submission).postDataJSON();
  assert.deepEqual([payload.model, payload.width, payload.height, payload.steps, payload.guidance],
    [model.id, 2064, 912, 60, 1]);
  assert.deepEqual(errors, []);
  console.log("Kromoss presets, custom canvas and custom steps passed through the renderer.");
} finally {
  await close();
}
