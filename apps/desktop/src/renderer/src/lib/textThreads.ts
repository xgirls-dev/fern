import type { ChatImageSettings } from "./chatImageSettings";

const KEY = "fern-text-threads:v1";
const DEFAULT_CONTEXT_SIZE = 8192;
export const MIN_CHAT_CONTEXT = 1024;
export const MAX_CHAT_CONTEXT = 2_147_483_647;

export type TextDevice = "AUTO" | "GPU" | "CPU";
export type TextMode = "instant" | "reasoning";
export interface TextSamplingOverrides {
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  stopSequences?: string[];
}
export interface TextSamplingSettings extends Omit<TextSamplingOverrides, "stopSequences"> {
  fixedSeed?: number;
  stopText?: string;
}
export const isChatImage = (value: unknown): value is string =>
  typeof value === "string" && /^chat-image-[a-f0-9]{32}\.png$/.test(value);
const isOutputImage = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9_-]+\.png$/i.test(value);

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
  return isOutputImage(image.name)
    && Number.isInteger(image.width) && Number.isInteger(image.height)
    && typeof image.modelLabel === "string" && typeof image.prompt === "string";
}

export interface TextMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  image?: string;
  includedImage?: string;
  generatedImage?: GeneratedChatImage;
  inspectionJobId?: string;
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
    sampling?: TextSamplingOverrides;
    maxNewTokens?: number;
    visionChecked?: boolean;
    context?: { size: number; compactedMessages: number; images: number; imageNames?: string[] };
  };
}
export interface TextThread {
  id: string;
  title: string;
  renamed?: boolean;
  archived: boolean;
  updatedAt: number;
  modelId: string | null;
  device: TextDevice;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxNewTokens: number;
  sampling?: TextSamplingSettings;
  draft: string;
  draftImage?: string;
  draftContextImage?: string;
  mode: TextMode;
  imageModel: string;
  imageRenderSettings?: Record<string, ChatImageSettings>;
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
  maxContextSize?: number | null;
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
  inspection?: boolean;
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
  ggufUnavailableReason?: string | null;
  devices: TextDevice[];
  job: TextJob;
}
export interface TextThreadWorkspace {
  activeId: string;
  threads: TextThread[];
  modelDefaults?: Record<string, TextModelDefaults>;
}

export type TextModelDefaults = Pick<TextThread, "contextSize" | "temperature" | "topP" | "maxNewTokens" | "sampling">;

const hasNumber = (value: unknown, min: number, max: number, integer = false): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

export function modelDefaultsFromThread(settings: Partial<TextModelDefaults>): TextModelDefaults {
  const { contextSize, temperature, topP, maxNewTokens, sampling } = settings;
  return {
    contextSize: hasNumber(contextSize, MIN_CHAT_CONTEXT, MAX_CHAT_CONTEXT, true) ? contextSize : DEFAULT_CONTEXT_SIZE,
    temperature: hasNumber(temperature, 0, 2) ? temperature : 0.7,
    topP: hasNumber(topP, 0.01, 1) ? topP : 0.9,
    maxNewTokens: hasNumber(maxNewTokens, 1, Math.floor(MAX_CHAT_CONTEXT / 2), true) ? maxNewTokens : 512,
    sampling: sampling && typeof sampling === "object" ? {
      topK: hasNumber(sampling.topK, 0, MAX_CHAT_CONTEXT, true) ? sampling.topK : undefined,
      minP: hasNumber(sampling.minP, 0, 0.999999) ? sampling.minP : undefined,
      repeatPenalty: hasNumber(sampling.repeatPenalty, 0.001, 3.402823466e38) ? sampling.repeatPenalty : undefined,
      fixedSeed: hasNumber(sampling.fixedSeed, 0, MAX_CHAT_CONTEXT, true) ? sampling.fixedSeed : undefined,
      stopText: typeof sampling.stopText === "string" ? sampling.stopText.slice(0, 8192) : undefined,
    } : undefined,
  };
}

export function textRuntimeIssue(status: TextRuntimeStatus, model: TextModel | undefined): string | null {
  if (model?.format === "gguf") {
    return status.ggufAvailable === false
      ? status.ggufUnavailableReason ?? "The managed GGUF runtime is unavailable on this device."
      : null;
  }
  return status.runtimeAvailable ? null : status.runtimeError ?? "The OpenVINO text runtime is unavailable.";
}

export function chatTokenLimits(thread: TextThread, model?: TextModel) {
  const contextMaximum = Math.min(model?.maxContextSize || MAX_CHAT_CONTEXT, MAX_CHAT_CONTEXT);
  const contextSize = Math.min(thread.contextSize, contextMaximum);
  const outputMaximum = model?.format === "gguf" ? Math.max(1, Math.floor(contextSize / 2)) : 8192;
  return {
    contextSize, contextMaximum, contextMinimum: Math.min(MIN_CHAT_CONTEXT, contextMaximum),
    maxNewTokens: Math.min(thread.maxNewTokens, outputMaximum), outputMaximum,
  };
}

export function textSamplingOverrides(settings?: TextSamplingSettings): TextSamplingOverrides {
  if (!settings) return {};
  const { topK, minP, repeatPenalty, stopText } = settings;
  const stopSequences = stopText?.split(/\r?\n/).filter((line) => line.trim().length);
  return { topK, minP, repeatPenalty, ...(stopSequences?.length ? { stopSequences } : {}) };
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
    contextSize: DEFAULT_CONTEXT_SIZE,
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
      draftContextImage: isOutputImage(thread.draftContextImage) ? thread.draftContextImage : undefined,
      mode: thread.mode === "reasoning" ? "reasoning" : "instant",
      imageModel: typeof thread.imageModel === "string" ? thread.imageModel : "auto",
      systemPrompt: typeof thread.systemPrompt === "string" ? thread.systemPrompt : "",
      modelId: typeof thread.modelId === "string" ? thread.modelId : null,
      pendingJobId: typeof thread.pendingJobId === "string" ? thread.pendingJobId : null,
      device: (["AUTO", "GPU", "CPU"].includes(thread.device) ? thread.device : "AUTO") as TextDevice,
      ...modelDefaultsFromThread(thread),
      messages: thread.messages.filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string").map((message) => ({
        ...message,
        id: typeof message.id === "string" ? message.id : `message-${crypto.randomUUID()}`,
        createdAt: Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
        error: typeof message.error === "string" ? message.error : null,
        errorCode: typeof message.errorCode === "string" ? message.errorCode : null,
        modelName: typeof message.modelName === "string" ? message.modelName : undefined,
        image: message.role === "user" && isChatImage(message.image) ? message.image : undefined,
        includedImage: message.role === "user" && isOutputImage(message.includedImage) ? message.includedImage : undefined,
        generatedImage: message.role === "assistant" && isGeneratedChatImage(message.generatedImage) ? message.generatedImage : undefined,
        inspectionJobId: typeof message.inspectionJobId === "string" ? message.inspectionJobId : undefined,
        reasoning: message.role === "assistant" && typeof message.reasoning === "string" ? message.reasoning : undefined,
        metrics: message.metrics && [message.metrics.inputTokens, message.metrics.outputTokens, message.metrics.generationSeconds, message.metrics.tokensPerSecond].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ? message.metrics : undefined,
      })),
    }));
    if (threads.length) return {
      activeId: threads.some((thread) => thread.id === saved?.activeId) ? saved!.activeId! : threads[0].id,
      threads,
      modelDefaults: saved?.modelDefaults && typeof saved.modelDefaults === "object" && !Array.isArray(saved.modelDefaults)
        ? Object.fromEntries(Object.entries(saved.modelDefaults).filter(([, settings]) => settings && typeof settings === "object")
          .map(([id, settings]) => [id, modelDefaultsFromThread(settings)]))
        : undefined,
    };
  } catch {
    // Ignore unreadable browser storage and open a clean conversation.
  }
  const thread = createTextThread();
  return { activeId: thread.id, threads: [thread] };
}

export function saveTextThreads(workspace: TextThreadWorkspace): void {
  localStorage.setItem(KEY, JSON.stringify(workspace));
}
