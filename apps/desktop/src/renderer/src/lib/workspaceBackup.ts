import { readWorkspaceReferences, type ThreadWorkspace } from "./threads";
import type { TextThreadWorkspace } from "./textThreads";
import type { AudioThreadWorkspace } from "./ttsThreads";
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
