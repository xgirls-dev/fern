import assert from "node:assert/strict";
import { fixture } from "./ui-fixture.mjs";

const { page, dir, errors, close } = await fixture({ viewport: { width: 1080, height: 720 } });
const wav = Buffer.alloc(44 + 64_000);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24);
wav.writeUInt32LE(32_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
try {
  await page.route("**/audio/*.wav*", (route) => route.fulfill({ body: wav, contentType: "audio/wav" }));
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
    queueMicrotask(() => {
      window.studio.saveOutputAudio = async (name) => { window.savedTake = name; return "/tmp/saved-take.wav"; };
    });
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("button", { name: "Audio thread: Studio reads" }).click();
  const first = page.getByRole("article", { name: "Station intro", exact: true });
  const second = page.getByRole("article", { name: "Station sign-off", exact: true });
  const play = first.getByRole("button", { name: "Play Station intro", exact: true });
  await page.setViewportSize({ width: 864, height: 576 });
  assert((await page.getByRole("heading", { name: "Studio reads", exact: true }).boundingBox()).height >= 16);
  await page.getByLabel("Open audio thread", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Latest take", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Play Station intro");
  assert(await play.isVisible());
  const transport = await first.getByRole("slider", { name: "Seek Station intro", exact: true }).evaluate((slider) => ({
    height: slider.getBoundingClientRect().height,
    border: getComputedStyle(slider).borderTopWidth,
  }));
  assert.deepEqual(transport, { height: 24, border: "0px" });
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
  assert.equal(await page.getByLabel("Preset speaker").inputValue(), "Ryan");
  const overflow = first.getByLabel("More actions for Station intro");
  const reuseScript = first.getByRole("button", { name: "Use script only" });
  await overflow.focus();
  await page.keyboard.press("Enter");
  await reuseScript.waitFor();
  await reuseScript.focus();
  await page.keyboard.press("Escape");
  await reuseScript.waitFor({ state: "hidden" });
  assert(await overflow.evaluate((element) => document.activeElement === element));
  await page.keyboard.press("Space");
  await reuseScript.click();
  assert.equal(await page.getByLabel("Text to speak").inputValue(), "You are listening to Fern.");
  assert.equal(await page.getByLabel("Preset speaker").inputValue(), "Ryan");
  await page.screenshot({ path: `${dir}/speech-takes-win32-fixture-light-1080x720.png` });
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  await page.screenshot({ path: `${dir}/speech-takes-win32-fixture-dark-1080x720.png` });
  assert.deepEqual(errors, []);
  console.log("Speech playback, favorites, export bridge and both reuse actions passed.");
} finally {
  await close();
}
