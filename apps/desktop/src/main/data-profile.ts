import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Older installers allowed a custom data folder. Keep it independent of the
// executable location and retain the whole Chromium profile (threads/IndexedDB).
export function savedDataRoot(profile: string): string | null {
  for (const name of ["fern-studio.json", "iris-studio.json"]) {
    try {
      const root = JSON.parse(readFileSync(join(profile, name), "utf8")).projectRoot;
      if (typeof root === "string" && isAbsolute(root) && existsSync(root)) return root;
    } catch { /* Missing or invalid configuration: use this profile's default. */ }
  }
  return null;
}

function hasImages(profile: string): boolean {
  try {
    return readdirSync(join(savedDataRoot(profile) ?? join(profile, "studio-data"), "outputs"))
      .some((name: string) => name.toLowerCase().endsWith(".png"));
  } catch { return false; }
}

export function resolveDataProfile(appData: string): string {
  const branded = join(appData, "Fern");
  const legacy = join(appData, "Iris OpenVINO Studio");
  if (!existsSync(legacy)) return branded;
  if (!existsSync(branded)) return legacy;
  // An empty directory created by a newer build must not hide an established
  // installation. Never merge or delete profiles when both contain user data.
  if (!savedDataRoot(branded) && !hasImages(branded) &&
      (savedDataRoot(legacy) || hasImages(legacy))) return legacy;
  return branded;
}
