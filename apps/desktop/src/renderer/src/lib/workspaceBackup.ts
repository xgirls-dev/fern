import { readWorkspaceReferences, saveThreadWorkspace, writeThreadReference, type ThreadWorkspace } from "./threads";
import { restoreTextThreads, type TextThreadWorkspace } from "./textThreads";
import { seedTextWorkspace } from "./textThreadStorage";
import { saveAudioThreads, type AudioThreadWorkspace } from "./ttsThreads";
import type { ReferenceAttachment } from "./reference";
import type { StudioSettings } from "./types";

const preferenceKeys = [
  "fern-compute-preference:v1",
  "fern-chat-reading:v1",
  "fern-last-workspace:v1",
  "fern-model-setup:v1",
  "fern-prompt-recipes",
  "fern-sidebar-collapsed",
  "fern-terminal-expanded",
  "fern-terminal-height",
];

export interface WorkspaceBackupSnapshot {
  chats: TextThreadWorkspace;
  images: ThreadWorkspace;
  speech: AudioThreadWorkspace;
  settings: StudioSettings;
}

export async function saveWorkspaceBackup(snapshot: WorkspaceBackupSnapshot): Promise<boolean> {
  const preferences = Object.fromEntries(preferenceKeys.flatMap((key) => {
    const value = localStorage.getItem(key);
    return value === null ? [] : [[key, value]];
  }));
  const imageReferences = await readWorkspaceReferences(snapshot.images.threads.map(({ id }) => id));
  return window.studio.saveWorkspaceBackup(JSON.stringify({
    version: 1, ...snapshot, preferences, imageReferences: Object.fromEntries(imageReferences),
  }));
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function threadList(value: unknown) {
  if (!record(value) || typeof value.activeId !== "string" || !Array.isArray(value.threads)) return;
  if (!value.threads.every((thread: unknown): thread is Record<string, unknown> & { id: string } =>
    record(thread) && typeof thread.id === "string" && typeof thread.title === "string")) return;
  const ids = new Set(value.threads.map(({ id }) => id));
  if (ids.size !== value.threads.length || !ids.has(value.activeId)) return;
  return value.threads as Array<Record<string, unknown> & { id: string }>;
}

function assetName(value: unknown, extension: string): value is string {
  return typeof value === "string" && value.toLowerCase().endsWith(extension) &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(value);
}

export async function restoreWorkspaceSeed(): Promise<void> {
  const snapshot = await window.studio.readWorkspaceSeed();
  if (snapshot === null) return;
  const backup: unknown = JSON.parse(snapshot);
  if (!record(backup) || backup.version !== 1 || !record(backup.settings) || !record(backup.preferences) ||
    !record(backup.imageReferences)) throw new Error("This backup has unrecognized workspace data.");

  const chatThreads = threadList(backup.chats);
  const chats = restoreTextThreads(backup.chats);
  const imageThreads = threadList(backup.images);
  const speechThreads = threadList(backup.speech);
  if (!chats || chats.threads.length !== chatThreads?.length ||
    !imageThreads?.every(({ settings, imageNames }) => record(settings) && typeof settings.prompt === "string" &&
      Array.isArray(imageNames) && imageNames.every((name) => assetName(name, ".png"))) ||
    !speechThreads?.every(({ text, outputs }) => typeof text === "string" &&
      Array.isArray(outputs) && outputs.every((output) => record(output) &&
        assetName(output.name, ".wav") &&
        output.url === `/outputs/${output.name}`))) {
    throw new Error("This backup contains invalid threads or media.");
  }

  const imageIds = new Set(imageThreads.map(({ id }) => id));
  const references = Object.entries(backup.imageReferences).map(([id, images]): [string, ReferenceAttachment[]] => {
    if (!imageIds.has(id) || !Array.isArray(images) || images.length > 4 || !images.every((image) =>
      record(image) && typeof image.label === "string" && typeof image.dataUrl === "string" &&
      /^data:image\/(?:png|jpeg|webp);base64,/i.test(image.dataUrl))) {
      throw new Error("This backup contains invalid image references.");
    }
    return [id, images];
  });

  // Seeding runs before the App mounts in the new workspace's own storage partition.
  await seedTextWorkspace(chats);
  await writeThreadReference(null, "");
  for (const [id, images] of references) await writeThreadReference(id, images);
  saveThreadWorkspace(backup.images as ThreadWorkspace);
  saveAudioThreads(backup.speech as AudioThreadWorkspace);
  localStorage.setItem("fern-studio-settings:v3", JSON.stringify(backup.settings));
  for (const key of preferenceKeys) {
    const value = backup.preferences[key];
    if (typeof value === "string") localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }
  await window.studio.finishWorkspaceSeed();
}
