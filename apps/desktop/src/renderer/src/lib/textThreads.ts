const KEY = "fern-text-threads:v1";

export type TextDevice = "AUTO" | "GPU" | "CPU";
export interface TextMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  jobId?: string;
  status?: "complete" | "failed" | "stopped";
  error?: string | null;
  modelName?: string;
  metrics?: {
    inputTokens: number;
    outputTokens: number;
    generationSeconds: number;
    tokensPerSecond: number;
    modelName?: string;
    device?: string;
    seed?: number;
    temperature?: number;
    topP?: number;
    maxNewTokens?: number;
  };
}
export interface TextThread {
  id: string;
  title: string;
  archived: boolean;
  updatedAt: number;
  modelId: string | null;
  device: TextDevice;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxNewTokens: number;
  draft: string;
  messages: TextMessage[];
  pendingJobId?: string | null;
}
export interface TextModel {
  id: string;
  name: string;
  path: string;
  architecture?: string | null;
  modelType?: string | null;
  installed: boolean;
  error?: string | null;
}
export interface TextJob {
  id: string | null;
  threadId: string | null;
  modelId: string | null;
  status: "idle" | "running" | "complete" | "failed" | "stopped";
  phase: string | null;
  partialText: string;
  startedAt: number | null;
  finishedAt: number | null;
  result: TextMessage["metrics"] | null;
  error: string | null;
}
export interface TextRuntimeStatus {
  registryError?: string | null;
  models: TextModel[];
  recommendedModels?: Array<{ id: string; name: string; repo: string; bytes: number; installed: boolean }>;
  defaultModelId?: string;
  modelInstall?: { id: string | null; modelId?: string | null; status: "idle" | "downloading" | "preparing" | "complete" | "failed"; phase: string | null; error: string | null };
  runtimeAvailable: boolean;
  runtimeError: string | null;
  devices: TextDevice[];
  job: TextJob;
}
export interface TextThreadWorkspace {
  activeId: string;
  threads: TextThread[];
}

export function createTextThread(): TextThread {
  return {
    id: `text-thread-${crypto.randomUUID()}`,
    title: "New text thread",
    archived: false,
    updatedAt: Date.now(),
    modelId: null,
    device: "AUTO",
    systemPrompt: "",
    temperature: 0.7,
    topP: 0.9,
    maxNewTokens: 512,
    draft: "",
    messages: [],
  };
}

function validThread(value: unknown): value is TextThread {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<TextThread>;
  return typeof thread.id === "string" && thread.id.startsWith("text-thread-")
    && typeof thread.title === "string" && Array.isArray(thread.messages);
}

export function loadTextThreads(): TextThreadWorkspace {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TextThreadWorkspace> | null;
    const threads = (Array.isArray(saved?.threads) ? saved.threads : []).filter(validThread).map((thread) => ({
      ...createTextThread(),
      ...thread,
      archived: thread.archived === true,
      updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : Date.now(),
      draft: typeof thread.draft === "string" ? thread.draft : "",
      systemPrompt: typeof thread.systemPrompt === "string" ? thread.systemPrompt : "",
      modelId: typeof thread.modelId === "string" ? thread.modelId : null,
      pendingJobId: typeof thread.pendingJobId === "string" ? thread.pendingJobId : null,
      device: (["AUTO", "GPU", "CPU"].includes(thread.device) ? thread.device : "AUTO") as TextDevice,
      temperature: typeof thread.temperature === "number" && thread.temperature >= 0 && thread.temperature <= 2 ? thread.temperature : 0.7,
      topP: typeof thread.topP === "number" && thread.topP > 0 && thread.topP <= 1 ? thread.topP : 0.9,
      maxNewTokens: Number.isInteger(thread.maxNewTokens) && thread.maxNewTokens! >= 1 && thread.maxNewTokens! <= 8192 ? thread.maxNewTokens : 512,
      messages: thread.messages.filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string").map((message) => ({
        ...message,
        id: typeof message.id === "string" ? message.id : `message-${crypto.randomUUID()}`,
        createdAt: Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
        error: typeof message.error === "string" ? message.error : null,
        modelName: typeof message.modelName === "string" ? message.modelName : undefined,
        metrics: message.metrics && [message.metrics.inputTokens, message.metrics.outputTokens, message.metrics.generationSeconds, message.metrics.tokensPerSecond].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ? message.metrics : undefined,
      })),
    }));
    if (threads.length) return { activeId: threads.some((thread) => thread.id === saved?.activeId) ? saved!.activeId! : threads[0].id, threads };
  } catch {
    // Ignore unreadable browser storage and open a clean conversation.
  }
  const thread = createTextThread();
  return { activeId: thread.id, threads: [thread] };
}

export function saveTextThreads(workspace: TextThreadWorkspace): void {
  localStorage.setItem(KEY, JSON.stringify(workspace));
}
