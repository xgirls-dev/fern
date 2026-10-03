const KEY = "fern-qwen3-tts-threads:v1";
const DEVICE_MIGRATION_KEY = "fern-qwen3-tts-gpu-default:v2";

export type QwenTtsModel =
  | "custom-0.6b"
  | "custom-1.7b"
  | "base-0.6b"
  | "base-1.7b"
  | "voice-design-1.7b";

export interface AudioOutput {
  name: string;
  url: string;
  prompt: string;
  duration: number;
  sampleRate: number;
  createdAt: number;
  title?: string;
  favorite?: boolean;
  model?: QwenTtsModel;
  language?: string;
  speaker?: string;
  instruction?: string;
  designInstruction?: string;
  referenceText?: string;
  referenceFileName?: string;
  device?: "AUTO" | "CPU" | "GPU";
  generationSeconds?: number;
}

export interface AudioThread {
  id: string;
  title: string;
  archived: boolean;
  updatedAt: number;
  model: QwenTtsModel;
  device: "AUTO" | "CPU" | "GPU";
  text: string;
  language: string;
  speaker: string;
  instruction: string;
  designInstruction: string;
  referenceText: string;
  outputs: AudioOutput[];
}

export interface AudioThreadWorkspace {
  activeId: string;
  threads: AudioThread[];
}

export function createAudioThread(): AudioThread {
  return {
    id: `audio-thread-${crypto.randomUUID()}`,
    title: "New audio thread",
    archived: false,
    updatedAt: Date.now(),
    model: "custom-0.6b",
    device: "AUTO",
    text: "",
    language: "Auto",
    speaker: "Vivian",
    instruction: "",
    designInstruction: "",
    referenceText: "",
    outputs: [],
  };
}

export function loadAudioThreads(): AudioThreadWorkspace {
  try {
    const migrateCpuDefault = localStorage.getItem(DEVICE_MIGRATION_KEY) !== "done";
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as AudioThreadWorkspace | null;
    if (parsed && Array.isArray(parsed.threads) && parsed.threads.length) {
      const threads = parsed.threads
        .filter((thread) => thread && typeof thread.id === "string" && typeof thread.title === "string" && Array.isArray(thread.outputs))
        .map((thread) => ({
          ...createAudioThread(),
          ...thread,
          model: ["custom-0.6b", "custom-1.7b", "base-0.6b", "base-1.7b", "voice-design-1.7b"].includes(thread.model) ? thread.model : "custom-0.6b",
          device: (migrateCpuDefault && thread.device === "CPU" ? "AUTO" : ["AUTO", "CPU", "GPU"].includes(thread.device) ? thread.device : "AUTO") as AudioThread["device"],
          outputs: thread.outputs.filter((output) => output && typeof output.name === "string" && typeof output.url === "string" && typeof output.prompt === "string" && typeof output.createdAt === "number"),
        }));
      if (threads.length) return { activeId: threads.some((thread) => thread.id === parsed.activeId) ? parsed.activeId : threads[0].id, threads };
    }
  } catch {
    // Keep a fresh audio workspace if saved audio thread metadata is unreadable.
  }
  const thread = createAudioThread();
  return { activeId: thread.id, threads: [thread] };
}

export function saveAudioThreads(workspace: AudioThreadWorkspace): void {
  localStorage.setItem(KEY, JSON.stringify(workspace));
  localStorage.setItem(DEVICE_MIGRATION_KEY, "done");
}
