import { randomUUID } from "node:crypto";
import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function publishWallpaperConnection(port: number, outputs: string): (() => void) | undefined {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (process.platform !== "linux" || !runtimeDir || !isAbsolute(runtimeDir)) return;

  const info = statSync(runtimeDir);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) return;

  const descriptor = join(runtimeDir, "fern-wallpapers.json");
  const temporary = join(runtimeDir, `fern-wallpapers-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ port, pid: process.pid, outputs }), { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, descriptor);
  } finally {
    rmSync(temporary, { force: true });
  }

  return () => {
    try {
      rmSync(descriptor, { force: true });
    } catch (error) {
      console.warn("Could not remove the Omarchy wallpaper connection:", error);
    }
  };
}
