export type SetupTask = "image" | "chat" | "chat-vision" | "chat-image";

export interface ModelSetup {
  task: SetupTask;
  threadId: string;
  viewing?: boolean;
}

export interface SetupSelection {
  imageModelId?: string;
  textModelId?: string;
}

const storageKey = "fern-model-setup:v1";

export function loadModelSetup(): ModelSetup | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (
      saved &&
      ["image", "chat", "chat-vision", "chat-image"].includes(saved.task) &&
      typeof saved.threadId === "string"
    ) return saved;
  } catch {
    // A fresh setup remains possible if local storage is unavailable.
  }
  return null;
}

export function saveModelSetup(setup: ModelSetup | null) {
  try {
    if (setup) localStorage.setItem(storageKey, JSON.stringify(setup));
    else localStorage.removeItem(storageKey);
  } catch {
    // The in-session draft origin remains available.
  }
}
