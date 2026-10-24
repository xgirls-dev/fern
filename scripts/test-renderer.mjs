import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const chrome = process.env.FERN_CHROME_PATH || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(existsSync);
const tests = process.argv.length > 2 ? process.argv.slice(2) : readdirSync("tests").filter((name) => name.startsWith("ux-") && name.endsWith(".mjs") && !name.includes("live")).sort();
const results = [];
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [resolve("tests", test)], {
    env: { ...process.env, ...(chrome ? { FERN_CHROME_PATH: chrome } : {}) },
    stdio: "inherit", timeout: 180_000, windowsHide: true,
  });
  results.push({ test, passed: result.status === 0, seconds: (Date.now() - started) / 1000, error: result.error?.message });
}
mkdirSync("artifacts/ux-verification", { recursive: true });
writeFileSync(`artifacts/ux-verification/${process.argv.length > 2 ? `results-${Date.now()}` : "results"}.json`, JSON.stringify(results, null, 2));
console.log(`\nRenderer checks: ${results.filter((result) => result.passed).length}/${results.length} passed.`);
process.exitCode = results.some((result) => !result.passed) ? 1 : 0;
