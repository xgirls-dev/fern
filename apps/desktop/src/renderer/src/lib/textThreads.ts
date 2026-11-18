const KEY = "fern-text-threads:v1";

export type TextDevice = "AUTO" | "GPU" | "CPU";
export type TextMode = "instant" | "reasoning";
export const isChatImage = (value: unknown): value is string =>
  typeof value === "string" && /^chat-image-[a-f0-9]{32}\.png$/.test(value);

export interface GeneratedChatImage {
  name: string;
  width: number;
  height: number;
  modelLabel: string;
  prompt: string;
}

function isGeneratedChatImage(value: unknown): value is GeneratedChatImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<GeneratedChatImage>;
  return typeof image.name === "string" && /^[a-z0-9_-]+\.png$/i.test(image.name)
    && Number.isInteger(image.width) && Number.isInteger(image.height)
    && typeof image.modelLabel === "string" && typeof image.prompt === "string";
}

export interface TextMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  image?: string;
  generatedImage?: GeneratedChatImage;
  reasoning?: string;
  createdAt: number;
  jobId?: string;
  status?: "complete" | "failed" | "stopped";
  error?: string | null;
  errorCode?: string | null;
  modelName?: string;
  metrics?: {
    inputTokens: number;
    outputTokens: number;
    generationSeconds: number;
    tokensPerSecond: number;
    modelName?: string;
    device?: string;
    backend?: string;
    mode?: TextMode;
    seed?: number;
    temperature?: number;
    topP?: number;
    maxNewTokens?: number;
    visionChecked?: boolean;
    context?: { size: number; compactedMessages: number; images: number };
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
  draftImage?: string;
  mode: TextMode;
  imageModel: string;
  contextSize: number;
  messages: TextMessage[];
  pendingJobId?: string | null;
}
export interface TextModel {
  id: string;
  name: string;
  path: string;
  architecture?: string | null;
  modelType?: string | null;
  format?: "gguf";
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
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
  partialReasoning?: string;
  image?: GeneratedChatImage | null;
  startedAt: number | null;
  finishedAt: number | null;
  result: TextMessage["metrics"] | null;
  error: string | null;
  errorCode?: string | null;
}
export interface TextRuntimeStatus {
  registryError?: string | null;
  models: TextModel[];
  recommendedModels?: Array<{ id: string; name: string; repo: string; bytes: number; installed: boolean; format?: string }>;
  defaultModelId?: string;
  imageToolModels?: Array<{ id: string; label: string }>;
  modelInstall?: { id: string | null; modelId?: string | null; status: "idle" | "downloading" | "preparing" | "complete" | "failed"; phase: string | null; error: string | null };
  runtimeAvailable: boolean;
  runtimeError: string | null;
  ggufAvailable?: boolean;
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
    mode: "instant",
    imageModel: "auto",
    contextSize: 8192,
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
    const threads = (Array.isArray(saved?.threads) ? saved.threads : []).filter(validThread).map((thread): TextThread => ({
      ...createTextThread(),
      ...thread,
      archived: thread.archived === true,
      updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : Date.now(),
      draft: typeof thread.draft === "string" ? thread.draft : "",
      draftImage: isChatImage(thread.draftImage) ? thread.draftImage : undefined,
      mode: thread.mode === "reasoning" ? "reasoning" : "instant",
      imageModel: typeof thread.imageModel === "string" ? thread.imageModel : "auto",
      contextSize: [4096, 8192, 16384].includes(thread.contextSize) ? thread.contextSize : 8192,
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
        errorCode: typeof message.errorCode === "string" ? message.errorCode : null,
        modelName: typeof message.modelName === "string" ? message.modelName : undefined,
        image: message.role === "user" && isChatImage(message.image) ? message.image : undefined,
        generatedImage: message.role === "assistant" && isGeneratedChatImage(message.generatedImage) ? message.generatedImage : undefined,
        reasoning: message.role === "assistant" && typeof message.reasoning === "string" ? message.reasoning : undefined,
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
