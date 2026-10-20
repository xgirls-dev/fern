import type { StudioSettings } from "./types";
import { normalizeQwenDimension } from "./imageDimensions";

const THREADS_KEY = "fern-threads:v1";
const REFERENCES_DB = "fern-thread-references";

// Retired model IDs can remain in old threads and gallery metadata.
export function normalizeImageSettings(settings: StudioSettings): StudioSettings {
  if (settings.model === "tame-pony-v25-sdxl" || settings.model === "tame-pony-v25-sdxl-int8") {
    const dimension = (value: number) =>
      Number.isFinite(value) ? Math.max(512, Math.min(1536, Math.round(value / 8) * 8)) : 1024;
    return {
      ...settings,
      model: settings.model,
      width: dimension(settings.width),
      height: dimension(settings.height),
      steps: Number.isFinite(settings.steps) ? Math.max(1, Math.min(50, Math.round(settings.steps))) : 30,
      guidance: Number.isFinite(settings.guidance) ? Math.max(0, Math.min(10, settings.guidance)) : 7,
      batchSize: Number.isFinite(settings.batchSize) ? Math.max(1, Math.min(4, Math.round(settings.batchSize))) : 1,
      device: ["AUTO", "INTEL_GPU", "NVIDIA_GPU", "CPU"].includes(settings.device) ? settings.device : "AUTO",
    };
  }
  if (settings.model === "qwen21-turbo") {
    const device: StudioSettings["device"] = ["AUTO", "INTEL_GPU", "CPU"].includes(settings.device) ? settings.device : "AUTO";
    return { ...settings, model: "qwen21-turbo", width: normalizeQwenDimension(settings.width), height: normalizeQwenDimension(settings.height), steps: 8, guidance: 1, batchSize: 1, device };
  }
  if (settings.model === "flux3-klein") {
    return {
      ...settings,
      model: "flux3-klein",
      width: 1024,
      height: 1024,
      steps: 16,
      guidance: 0,
      batchSize: 1,
      device: ["AUTO", "INTEL_GPU", "NVIDIA_GPU", "CPU"].includes(settings.device) ? settings.device : "AUTO",
    };
  }
  if (settings.model === "9b" || settings.model === "4b") return settings;
  const dimension = (value: number) =>
    Number.isFinite(value) ? Math.max(256, Math.min(1920, Math.round(value / 16) * 16)) : 1024;
  return { ...settings, model: "9b", width: dimension(settings.width),
    height: dimension(settings.height), steps: 4, guidance: 1 };
}

export interface ImageThread {
  archived?: boolean;
  id: string;
  title: string;
  renamed: boolean;
  updatedAt: number;
  settings: StudioSettings;
  previewName: string | null;
  imageNames: string[];
  referenceLabel: string;
}

export interface ThreadWorkspace {
  activeId: string;
  threads: ImageThread[];
}

export function createImageThread(settings: StudioSettings): ImageThread {
  return {
    id: `thread-${crypto.randomUUID()}`,
    title: "New thread",
    renamed: false,
    updatedAt: Date.now(),
    settings: { ...settings, prompt: "" },
    previewName: null,
    imageNames: [],
    referenceLabel: "No reference image.",
  };
}

export function threadTitle(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 60) : "New thread";
}

export function loadThreadWorkspace(settings: StudioSettings): ThreadWorkspace {
  try {
    const value = JSON.parse(
      localStorage.getItem(THREADS_KEY) ?? "null",
    ) as ThreadWorkspace | null;
    if (value && Array.isArray(value.threads)) {
      const threads = value.threads.filter(
        (thread) =>
          thread &&
          typeof thread.id === "string" &&
          typeof thread.title === "string" &&
          typeof thread.settings?.prompt === "string",
      );
      if (threads.length) {
        const workspace: ThreadWorkspace = {
          activeId: threads.some((thread) => thread.id === value.activeId)
            ? value.activeId
            : threads[0].id,
          threads: threads.map((thread) => ({
            ...thread,
            settings: normalizeImageSettings({
              ...settings,
              ...thread.settings,
            }),
            imageNames: thread.imageNames ?? [],
            referenceLabel: thread.referenceLabel ?? "No reference image.",
          })),
        };
        if (threads.some((thread) => !["9b", "4b", "qwen21-turbo", "flux3-klein", "tame-pony-v25-sdxl", "tame-pony-v25-sdxl-int8"].includes(thread.settings.model ?? "9b"))) {
          try { saveThreadWorkspace(workspace); } catch {
            // Keep the migrated draft usable even if local storage is full.
          }
        }
        return workspace;
      }
    }
  } catch {
    // Keep the previous global draft available if thread storage is unreadable.
  }
  const thread = createImageThread(settings);
  thread.settings = settings;
  thread.title = threadTitle(settings.prompt);
  return { activeId: thread.id, threads: [thread] };
}

export function saveThreadWorkspace(workspace: ThreadWorkspace): void {
  localStorage.setItem(THREADS_KEY, JSON.stringify(workspace));
}

// Image attachments live in IndexedDB, outside localStorage's small text quota.
function referencesDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REFERENCES_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readThreadReference(id: string): Promise<string> {
  await referenceWrites.catch(() => undefined);
  const db = await referencesDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("images", "readonly");
    const request = transaction.objectStore("images").get(id);
    transaction.oncomplete = () => {
      db.close();
      resolve(typeof request.result === "string" ? request.result : "");
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function persistReference(
  id: string | null,
  image: string,
): Promise<void> {
  const db = await referencesDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("images", "readwrite");
    const store = transaction.objectStore("images");
    if (id === null) store.clear();
    else if (image) store.put(image, id);
    else store.delete(id);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

let referenceWrites: Promise<void> = Promise.resolve();
export function writeThreadReference(
  id: string | null,
  image: string,
): Promise<void> {
  const next = referenceWrites
    .catch(() => undefined)
    .then(() => persistReference(id, image));
  referenceWrites = next;
  return next;
}
