import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { fixture, silentWav } from "./ui-fixture.mjs";

const { page, dir, errors, close } = await fixture({ viewport: { width: 1080, height: 720 } });
const wav = silentWav(16_000, 2);
try {
  await page.route("**/audio/*.wav*", (route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const headers = { "Accept-Ranges": "bytes" };
    if (!range) return route.fulfill({ body: wav, contentType: "audio/wav", headers });
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : wav.length - 1, wav.length - 1);
    return route.fulfill({ status: 206, body: wav.subarray(start, end + 1), contentType: "audio/wav",
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${wav.length}` } });
  });
  await page.addInitScript(() => {
    const id = "audio-thread-review";
    const now = Date.now();
    localStorage.setItem("fern-qwen3-tts-threads:v1", JSON.stringify({
      activeId: id,
      threads: [{ id, title: "Studio reads", text: "Draft for the next take", outputs: [
        { name: "one.wav", url: "/audio/one.wav", title: "Station intro", prompt: "You are listening to Fern.", model: "custom-0.6b", language: "English", speaker: "Vivian", duration: 2, sampleRate: 16000, createdAt: now },
        { name: "two.wav", url: "/audio/two.wav", title: "Station sign-off", prompt: "Thanks for listening.", model: "custom-0.6b", language: "English", speaker: "Ryan", duration: 2, sampleRate: 16000, createdAt: now - 1000 },
      ] }],
    }));
    window.savedTake = null;
    window.copiedTake = null;
    window.deletedTakes = [];
    queueMicrotask(() => {
      window.studio.saveOutputAudio = async (name) => { window.savedTake = name; return "/tmp/saved-take.wav"; };
      window.studio.copyText = async (text) => { window.copiedTake = text; };
      window.studio.deleteOutputAudio = async (name) => {
        window.deletedTakes.push(name);
        if (window.deletedTakes.length === 1) throw new Error("The WAV is in use.");
      };
    });
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("button", { name: "Audio thread: Studio reads" }).click();
  const first = page.getByRole("article", { name: "Station intro", exact: true });
  const second = page.getByRole("article", { name: "Station sign-off", exact: true });
  const play = first.getByRole("button", { name: "Play Station intro", exact: true });
  await page.setViewportSize({ width: 864, height: 576 });
  assert((await page.getByRole("heading", { name: "Studio reads", exact: true }).boundingBox()).height >= 16);
  const switchAudio = page.getByRole("button", { name: "Open audio thread", exact: true });
  await switchAudio.press("Enter");
  const audioSearch = page.getByRole("dialog", { name: "Search audio threads", exact: true });
  const query = audioSearch.getByRole("searchbox", { name: "Find an audio thread", exact: true });
  await expect(query).toBeFocused();
  await query.fill("Draft for the next take");
  await expect(audioSearch.locator('[aria-current="true"]')).toContainText("Studio reads");
  await query.press("Escape");
  await expect(audioSearch).toHaveCount(0);
  await expect(switchAudio).toBeFocused();
  await page.getByRole("button", { name: "Latest take", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Play Station intro");
  assert(await play.isVisible());
  const seek = first.getByRole("slider", { name: "Seek Station intro", exact: true });
  const transport = await seek.evaluate((slider) => ({
    height: slider.getBoundingClientRect().height,
    border: getComputedStyle(slider).borderTopWidth,
  }));
  assert.deepEqual(transport, { height: 24, border: "0px" });
  await expect.poll(() => first.locator("audio").evaluate((audio) => audio.seekable.length)).toBeGreaterThan(0);
  await seek.press("End");
  await expect(seek).toHaveAttribute("aria-valuetext", "0:02 of 0:02");
  await expect.poll(() => first.locator("audio").evaluate((audio) => audio.currentTime)).toBe(2);
  await seek.press("Home");
  await expect(seek).toHaveAttribute("aria-valuetext", "0:00 of 0:02");
  await seek.press("ArrowRight");
  await expect(seek).toHaveAttribute("aria-valuetext", "0:00.1 of 0:02");
  await seek.press("Home");
  await page.setViewportSize({ width: 1080, height: 720 });
  await play.click();
  await first.getByRole("button", { name: "Pause Station intro", exact: true }).waitFor();
  await second.getByRole("button", { name: "Play Station sign-off", exact: true }).click();
  await second.getByRole("button", { name: "Pause Station sign-off", exact: true }).waitFor();
  assert.equal(await first.getByRole("button", { name: "Pause Station intro", exact: true }).count(), 0);
  await second.getByRole("button", { name: "Pause Station sign-off", exact: true }).click();
  await first.getByRole("button", { name: "Add Station intro to favorites", exact: true }).click();
  await first.getByRole("button", { name: "Remove Station intro from favorites", exact: true }).waitFor();
  await first.getByRole("button", { name: "Save audio as…", exact: true }).click();
  assert.equal(await page.evaluate(() => window.savedTake), "one.wav");
  await second.getByRole("button", { name: "Use setup", exact: true }).click();
  assert.equal(await page.getByLabel("Text to speak").inputValue(), "Thanks for listening.");
  const speaker = page.getByRole("combobox", { name: /^Preset speaker/ });
  await expect(speaker).toHaveText("Ryan");
  const rename = first.getByRole("button", { name: "Rename Station intro", exact: true });
  await rename.click();
  const takeName = first.getByRole("textbox", { name: "Take name", exact: true });
  await expect(takeName).toBeFocused();
  await takeName.press("Escape");
  await expect(rename).toBeFocused();
  const takeDetails = first.locator("summary").filter({ hasText: "Script and voice settings" });
  await takeDetails.press("Enter");
  await expect(first.getByText("You are listening to Fern.")).toBeVisible();
  await takeDetails.press("Space");
  await expect(first.getByText("You are listening to Fern.")).toBeHidden();

  const overflow = first.getByRole("button", { name: "More actions for Station intro", exact: true });
  const menu = page.getByRole("menu", { name: "Actions for Station intro", exact: true });
  const reuseScript = menu.getByRole("menuitem", { name: "Use script only", exact: true });
  await overflow.press("ArrowDown");
  await expect(reuseScript).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(overflow).toBeFocused();
  await overflow.press("Space");
  await expect(reuseScript).toBeFocused();
  await page.keyboard.press("c");
  await expect(menu.getByRole("menuitem", { name: "Copy script", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.copiedTake)).toBe("You are listening to Fern.");
  await expect(overflow).toBeFocused();
  await overflow.press("ArrowDown");
  await reuseScript.press("Enter");
  const script = page.getByLabel("Text to speak");
  await expect(script).toHaveValue("You are listening to Fern.");
  await expect(script).toBeFocused();
  await expect(speaker).toHaveText("Ryan");

  await page.setViewportSize({ width: 864, height: 510 });
  await overflow.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await overflow.click();
  await expect(menu).toBeVisible();
  const scrollport = await overflow.evaluateHandle((trigger) => {
    for (let ancestor = trigger.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(ancestor).overflowY) && ancestor.scrollHeight > ancestor.clientHeight) return ancestor;
    }
    throw new Error("The compact take needs a scrollable ancestor");
  });
  const beforeScroll = await scrollport.evaluate((element) => element.scrollTop);
  const afterScroll = await scrollport.evaluate((element) => {
    element.scrollTop += element.scrollTop >= 32 ? -32 : 32;
    return element.scrollTop;
  });
  assert.notEqual(afterScroll, beforeScroll);
  await expect(menu).toHaveCount(0);
  assert.equal(await scrollport.evaluate((element) => element.scrollTop), afterScroll, "Closing the menu preserves the new scroll position");
  await scrollport.dispose();
  await page.setViewportSize({ width: 1080, height: 720 });

  await overflow.click();
  await page.screenshot({ path: `${dir}/speech-takes-win32-fixture-light-1080x720.png` });
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.screenshot({ path: `${dir}/speech-takes-win32-fixture-dark-1080x720.png` });
  await menu.getByRole("menuitem", { name: "Delete take", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Move this take to Recycle Bin?", exact: true });
  const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true });
  const moveToTrash = confirmation.getByRole("button", { name: "Move to Recycle Bin", exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(overflow).toBeFocused();
  assert.deepEqual(await page.evaluate(() => window.deletedTakes), []);
  await overflow.click();
  await menu.getByRole("menuitem", { name: "Delete take", exact: true }).click();
  await moveToTrash.click();
  await expect(confirmation.getByRole("alert")).toHaveText("The WAV is in use.");
  const firstCard = page.locator('[data-output-name="one.wav"]');
  await expect(firstCard).toBeAttached();
  await moveToTrash.click();
  await expect(confirmation).toHaveCount(0);
  await expect(firstCard).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Play Station sign-off", exact: true })).toBeFocused();
  await second.getByRole("button", { name: "More actions for Station sign-off", exact: true }).click();
  await page.getByRole("menu", { name: "Actions for Station sign-off", exact: true })
    .getByRole("menuitem", { name: "Delete take", exact: true }).click();
  await moveToTrash.click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Takes 0", exact: true })).toBeFocused();
  assert.deepEqual(await page.evaluate(() => window.deletedTakes), ["one.wav", "one.wav", "two.wav"]);
  assert.deepEqual(errors, []);
  console.log("Speech playback, favorites, export, reuse, keyboard menus, and safe take deletion passed.");
} finally {
  await close();
}
