import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture } from "./ui-fixture.mjs";

const { page, state, errors, dir, close } = await fixture({
  firstRun: true,
  textStatus: {
    models: [{ id: "local", name: "Local model", installed: true, format: "gguf", supportsReasoning: true }],
    ggufAvailable: true, job: { id: null, status: "idle" },
  },
});
const button = (name) => page.getByRole("button", { name, exact: true });
const mode = page.getByRole("combobox", { name: "Response mode" });
const options = page.getByRole("listbox");
const composer = page.getByRole("textbox", { name: "Message", exact: true });

try {
  await expect(mode).toHaveText("Instant");
  await mode.focus();
  await page.keyboard.press("ArrowDown");
  await expect(options).toBeVisible();
  await expect(options.getByRole("option", { name: "Instant" })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: `${dir}/chat-select-keyboard.png` });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(mode).toHaveText("Reasoning");
  await expect(mode).toBeFocused();

  await mode.press("Space");
  await expect(options).toBeVisible();
  await page.keyboard.press("Home");
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(mode).toHaveText("Reasoning");
  await expect(mode).toBeFocused();
  await expect(page.locator("select")).toHaveCount(0);

  await button("Models").hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "Install and manage models" })).toBeVisible();
  const modelButton = button("Text model: Local model");
  await modelButton.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: /^Local model$/ })).toBeVisible();
  await button("New chat").hover();
  await expect(page.locator(".ui-tooltip")).toHaveText("New chat");
  await expect(page.locator(".ui-tooltip")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.locator(".ui-tooltip")).toHaveCount(0);
  await button("Open split chat").focus();
  await page.keyboard.press("Tab");
  await expect(button("New chat")).toBeFocused();
  await expect(page.locator(".ui-tooltip")).toHaveText("New chat");
  await composer.fill("Keep the selected mode.");
  await button("Attach documents").hover();
  await expect(page.getByText("Attach documents for this chat", { exact: true })).toBeVisible();
  await button("Send message").click();
  assert.equal(state.textRequests[0].mode, "reasoning");
  await expect(mode).toBeDisabled();

  state.textStatus.job = { ...state.textStatus.job, status: "complete", partialText: "A complete reply.",
    partialReasoning: "Check that the controls are consistent." };
  const response = page.getByRole("article", { name: "Model response" });
  const copy = response.getByRole("button", { name: "Copy message", exact: true });
  const actions = response.getByRole("button", { name: "More message actions" });
  const reasoning = response.locator(".ui-disclosure");
  const reasoningTrigger = reasoning.locator("summary");
  await response.focus();
  await page.keyboard.press("Tab");
  await expect(reasoningTrigger).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(copy).toBeFocused();
  await expect(page.locator(".ui-tooltip").filter({ hasText: /^Copy message$/ })).toBeVisible();
  await copy.blur();
  await actions.hover();
  const menuHint = page.locator(".ui-tooltip").filter({ hasText: /^More message actions$/ });
  await expect(menuHint).toBeVisible();
  await actions.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Message actions" });
  await expect(menu).toBeVisible();
  await expect(menuHint).toBeHidden();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(actions).toBeFocused();

  await reasoningTrigger.press("Enter");
  await expect(reasoning).toHaveAttribute("open", "");
  await expect(reasoning.getByText("Check that the controls are consistent.")).toBeVisible();
  await expect(reasoningTrigger).toBeFocused();
  await reasoningTrigger.press("Space");
  await expect(reasoning).not.toHaveAttribute("open");
  await expect(reasoningTrigger).toBeFocused();

  await button("Duplicate chat").hover();
  await expect(page.getByRole("tooltip").filter({ hasText: /^Duplicate chat$/ })).toBeVisible();
  await button("Collapse sidebar").click();
  const threadSwitcher = page.getByRole("combobox", { name: "Open text thread", exact: true });
  await threadSwitcher.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: /^Open text thread$/ })).toBeVisible();
  await threadSwitcher.press("ArrowDown");
  await expect(options).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(threadSwitcher).toBeFocused();
  await button("Expand sidebar").click();
  await button("Chat settings").press("Enter");
  const settings = page.getByRole("complementary", { name: "Chat settings panel" });
  const views = settings.getByRole("group", { name: "Chat inspector views" });
  await expect(views.getByRole("button", { name: "Model", exact: true })).toHaveAttribute("aria-pressed", "true");
  const advanced = settings.locator(".ui-disclosure--section", { hasText: "Advanced model loading" });
  await advanced.locator("summary").press("Enter");
  await expect(advanced).toHaveAttribute("open", "");
  const precision = settings.getByRole("combobox", { name: "KV key precision" });
  await expect(precision).toHaveText("Runtime default");
  await precision.press("ArrowDown");
  await expect(options).toBeVisible();
  await expect(options.getByRole("option", { name: "Runtime default", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(precision).toBeFocused();
  await expect(precision).toHaveText("Runtime default");
  await expect(advanced).toHaveAttribute("open", "");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${dir}/chat-disclosure-keyboard.png` });
  const imageView = views.getByRole("button", { name: "Image", exact: true });
  await imageView.press("Space");
  await expect(imageView).toHaveAttribute("aria-pressed", "true");
  await expect(imageView).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(button("Chat settings")).toBeFocused();

  await page.setViewportSize({ width: 768, height: 740 });
  await button("Toggle theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await button("Chat settings").press("Enter");
  const sampling = settings.locator(".ui-disclosure--section", { hasText: "Advanced sampling" });
  await sampling.locator("summary").press("Space");
  await expect(sampling).toHaveAttribute("open", "");
  await expect(sampling.locator(".ui-disclosure-caret")).toHaveCSS("transform", "matrix(0, 1, -1, 0, 0, 0)");
  await expect(sampling.getByLabel("Top K", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${dir}/chat-disclosure-compact-dark.png` });
  assert.deepEqual(errors, []);
  console.log("Shared select, menu, tooltip, disclosure, and segmented controls support keyboard navigation and focus restoration.");
} finally {
  await close();
}
