import type { ChatImageModel, ChatImageSettings } from "./chatImageSettings";
import { normalizeChatFolders, type ChatFolder } from "./chatFolders";
import { normalizeChatDocuments, normalizeDocumentSources, type ChatDocument, type ChatDocumentSource } from "./chatDocuments";
import { normalizeTextFailure, type TextFailureDiagnostics } from "./textFailure";

const DEFAULT_CONTEXT_SIZE = 8192;
export const MIN_CHAT_CONTEXT = 1024;
export const MAX_CHAT_CONTEXT = 2_147_483_647;
export const KV_CACHE_TYPES = ["f32", "f16", "bf16", "f8_e4m3", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"] as const;
type CacheType = typeof KV_CACHE_TYPES[number];
export interface GgufLoadOptions {
  flashAttention?: "auto" | "on" | "off";
  promptBatch?: number;
  microBatch?: number;
  keyCacheType?: CacheType;
  valueCacheType?: CacheType;
}

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
  originThreadId?: string;
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
  imageThreadId?: string;
  includedImageThreadId?: string;
  generatedImage?: GeneratedChatImage;
  generatedImages?: GeneratedChatImage[];
  inspectionJobId?: string;
  reasoning?: string;
  createdAt: number;
  jobId?: string;
  status?: "complete" | "failed" | "stopped";
  error?: string | null;
  errorCode?: string | null;
  failureDiagnostics?: TextFailureDiagnostics;
  modelName?: string;
  alternatives?: TextMessage[];
  promptVersionId?: string;
  promptAlternatives?: TextPromptVersion[];
  continuationOf?: string;
  requestContext?: TextRequestContext;
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
    loadOptions?: GgufLoadOptions;
    maxNewTokens?: number;
    finishReason?: "length" | "stop";
    visionChecked?: boolean;
    documentSources?: ChatDocumentSource[];
    context?: { size: number; compactedMessages: number; images: number; imageNames?: string[] };
  };
}

export type TextReplyPreview = Pick<TextMessage, "content" | "reasoning" | "generatedImage" | "generatedImages">;

export interface TextThread {
  id: string;
  title: string;
  folderId?: string;
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
  loadOptions?: GgufLoadOptions;
  draft: string;
  draftImage?: string;
  draftContextImage?: string;
  documents?: ChatDocument[];
  draftContextImageThreadId?: string;
  promptEdit?: TextPromptEdit;
  sourceThreadId?: string;
  mode: TextMode;
  imageModel: string;
  imageRenderSettings?: Record<string, ChatImageSettings>;
  contextSize: number;
  messages: TextMessage[];
  versions?: TextVersion[];
  pendingJobId?: string | null;
  pendingPreview?: TextReplyPreview;
  pendingContext?: TextRequestContext;
}

export function hasTextThreadWork(thread: TextThread) {
  return Boolean(thread.messages.length || thread.title !== "New text thread" || thread.renamed || thread.draft.trim()
    || thread.draftImage || thread.draftContextImage || thread.systemPrompt || thread.folderId || thread.documents?.length);
}

export interface TextRequestContext {
  omittedMessages: number;
  shortenedMessages: number;
  unansweredPrompts: number;
  omittedAttachments: number;
}

export interface TextPromptVersion {
  id: string;
  content: string;
  createdAt: number;
  continuationOf?: string;
  response?: TextMessage;
}

export interface TextPromptEdit {
  messageId: string;
  content: string;
}

export interface TextVersion {
  id: string;
  label: string;
  messages: TextMessage[];
}

export function snapshotTextVersion(messages: TextMessage[]): TextVersion {
  const prompt = messages.filter((message) => message.role === "user").at(-1)?.content;
  return {
    id: crypto.randomUUID(),
    label: prompt?.replace(/\s+/g, " ").trim().slice(0, 64) || "Previous conversation",
    messages,
  };
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
  images?: GeneratedChatImage[];
  inspection?: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  result: TextMessage["metrics"] | null;
  error: string | null;
  errorCode?: string | null;
  failureDiagnostics?: TextFailureDiagnostics | null;
}
export interface TextRuntimeStatus {
  registryError?: string | null;
  models: TextModel[];
  recommendedModels?: Array<{ id: string; name: string; repo: string; bytes: number; installed: boolean; format?: string }>;
  defaultModelId?: string;
  imageToolModels?: ChatImageModel[];
  modelInstall?: { id: string | null; modelId?: string | null; status: "idle" | "downloading" | "preparing" | "complete" | "failed"; phase: string | null; error: string | null };
  runtimeAvailable: boolean;
  runtimeError: string | null;
  ggufAvailable?: boolean;
  ggufUnavailableReason?: string | null;
  supportsJobPolling?: boolean;
  supportsJobEvents?: boolean;
  supportsPendingStop?: boolean;
  devices: TextDevice[];
  job: TextJob;
}
export interface TextThreadWorkspace {
  activeId: string;
  secondaryId?: string;
  activePane?: ChatPane;
  splitPercent?: number;
  threads: TextThread[];
  modelDefaults?: Record<string, TextModelDefaults>;
  presets?: ChatPreset[];
  folders?: readonly ChatFolder[];
}

export type ChatPane = "primary" | "secondary";

export function visibleChatPane(workspace: TextThreadWorkspace): ChatPane {
  return workspace.secondaryId && workspace.activePane === "secondary" ? "secondary" : "primary";
}

export function showChatThread(workspace: TextThreadWorkspace, id: string, pane?: ChatPane): TextThreadWorkspace {
  if (!pane) {
    if (id === workspace.activeId) return { ...workspace, activePane: "primary" };
    if (id === workspace.secondaryId) return { ...workspace, activePane: "secondary" };
    pane = visibleChatPane(workspace);
  }
  if (pane === "secondary" && id === workspace.activeId && !workspace.secondaryId) return workspace;
  if (pane === "primary") {
    return { ...workspace, activeId: id, activePane: pane,
      secondaryId: id === workspace.secondaryId ? workspace.activeId : workspace.secondaryId };
  }
  return { ...workspace, secondaryId: id, activePane: pane,
    activeId: workspace.activeId === id && workspace.secondaryId ? workspace.secondaryId : workspace.activeId };
}

export function compareChatThread(workspace: TextThreadWorkspace, id: string, pane: ChatPane): TextThreadWorkspace {
  if (!workspace.secondaryId) {
    if (id === workspace.activeId) return workspace;
    if (pane === "primary") return { ...workspace, activeId: id, secondaryId: workspace.activeId, activePane: pane };
  }
  return showChatThread(workspace, id, pane);
}

export function closeChatPane(workspace: TextThreadWorkspace, pane: ChatPane): TextThreadWorkspace {
  if (!workspace.secondaryId) return workspace;
  return { ...workspace, activeId: pane === "primary" ? workspace.secondaryId : workspace.activeId,
    secondaryId: undefined, activePane: "primary" };
}

export function normalizeChatSplit(percent: unknown): number {
  return typeof percent === "number" && Number.isFinite(percent) ? Math.round(Math.min(65, Math.max(35, percent))) : 50;
}

export type TextModelDefaults = Pick<TextThread, "contextSize" | "temperature" | "topP" | "maxNewTokens" | "sampling" | "loadOptions">;
export type ChatPresetSettings = Pick<TextThread, "systemPrompt" | "temperature" | "topP" | "maxNewTokens" | "sampling">;
export interface ChatPreset {
  id: string;
  name: string;
  settings: ChatPresetSettings;
}

export function chatPresetSettings(settings: Partial<ChatPresetSettings>): ChatPresetSettings {
  const { temperature, topP, maxNewTokens, sampling } = modelDefaultsFromThread(settings);
  return {
    systemPrompt: typeof settings.systemPrompt === "string" ? settings.systemPrompt.slice(0, 10_000) : "",
    temperature, topP, maxNewTokens, sampling,
  };
}

const hasNumber = (value: unknown, min: number, max: number, integer = false): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

export function modelDefaultsFromThread(settings: Partial<TextModelDefaults>): TextModelDefaults {
  const { contextSize, temperature, topP, maxNewTokens, sampling, loadOptions } = settings;
  return {
    contextSize: hasNumber(contextSize, MIN_CHAT_CONTEXT, MAX_CHAT_CONTEXT, true) ? contextSize : DEFAULT_CONTEXT_SIZE,
    temperature: hasNumber(temperature, 0, 2) ? temperature : 0.7,
    topP: hasNumber(topP, 0.01, 1) ? topP : 0.9,
    maxNewTokens: hasNumber(maxNewTokens, 1, MAX_CHAT_CONTEXT, true) ? maxNewTokens : 512,
    sampling: sampling && typeof sampling === "object" ? {
      topK: hasNumber(sampling.topK, 0, MAX_CHAT_CONTEXT, true) ? sampling.topK : undefined,
      minP: hasNumber(sampling.minP, 0, 0.999999) ? sampling.minP : undefined,
      repeatPenalty: hasNumber(sampling.repeatPenalty, 0.001, 3.402823466e38) ? sampling.repeatPenalty : undefined,
      fixedSeed: hasNumber(sampling.fixedSeed, 0, MAX_CHAT_CONTEXT, true) ? sampling.fixedSeed : undefined,
      stopText: typeof sampling.stopText === "string" ? sampling.stopText.slice(0, 8192) : undefined,
    } : undefined,
    loadOptions: loadOptions && typeof loadOptions === "object" ? ggufLoadOptions(loadOptions, MAX_CHAT_CONTEXT) : undefined,
  };
}

export function textResponseMetrics(metrics: TextMessage["metrics"] | null): TextMessage["metrics"] {
  if (!metrics || ![metrics.inputTokens, metrics.outputTokens, metrics.generationSeconds, metrics.tokensPerSecond]
    .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return;
  const { inputTokens, outputTokens, generationSeconds, tokensPerSecond, modelName, device, backend,
    mode, seed, temperature, topP, maxNewTokens, visionChecked, context, finishReason } = metrics;
  return { inputTokens, outputTokens, generationSeconds, tokensPerSecond, modelName, device, backend,
    mode, seed, temperature, topP, maxNewTokens, visionChecked, context, sampling: metrics.sampling, loadOptions: metrics.loadOptions,
    documentSources: normalizeDocumentSources(metrics.documentSources),
    finishReason: finishReason === "length" || finishReason === "stop" ? finishReason : undefined };
}

export function canContinueTextReply(message: TextMessage | undefined): boolean {
  if (message?.role !== "assistant" || !message.content.trim()) return false;
  if (message.status === "complete") return message.metrics?.finishReason === "length";
  return !message.generatedImage && (message.status === "stopped" || message.status === "failed");
}

export function keepStreamedText(previous: string | undefined, next: string | undefined): string | undefined {
  if (!next?.trim()) return previous;
  return previous && next.length < previous.length && previous.startsWith(next) ? previous : next;
}

export function mergeTextReplyPreview(preview: TextReplyPreview | undefined, next: TextReplyPreview | undefined): TextReplyPreview | undefined {
  if (!next) return preview;
  const content = keepStreamedText(preview?.content, next.content) ?? "";
  const reasoning = keepStreamedText(preview?.reasoning, next.reasoning);
  const generatedImages = next.generatedImages ?? preview?.generatedImages;
  const generatedImage = next.generatedImage ?? generatedImages?.[0] ?? preview?.generatedImage;
  if (!content && !reasoning && !generatedImage) return preview;
  if (preview?.content === content && preview.reasoning === reasoning && preview.generatedImage?.name === generatedImage?.name && preview.generatedImages?.length === generatedImages?.length) return preview;
  return { content, reasoning, generatedImage, generatedImages };
}

export function restoreTextReplyPreview(preview: TextReplyPreview | undefined): TextReplyPreview | undefined {
  if (typeof preview?.content !== "string") return;
  return {
    content: preview.content,
    reasoning: typeof preview.reasoning === "string" ? preview.reasoning : undefined,
    generatedImage: isGeneratedChatImage(preview.generatedImage) ? preview.generatedImage : undefined,
    generatedImages: Array.isArray(preview.generatedImages) ? preview.generatedImages.filter(isGeneratedChatImage).slice(0, 4) : undefined,
  };
}

export function pendingTextReply(thread: TextThread, job: TextJob): TextThread["pendingPreview"] {
  const preview = thread.pendingPreview;
  if (job.status !== "running" || job.inspection || !job.id || job.id !== thread.pendingJobId || job.threadId !== thread.id) return preview;
  return mergeTextReplyPreview(preview, { content: job.partialText, reasoning: job.partialReasoning, generatedImage: job.image ?? undefined, generatedImages: job.images });
}

export function checkpointTextReply(workspace: TextThreadWorkspace, job: TextJob): TextThreadWorkspace {
  if (job.status !== "running" || job.inspection || !job.id) return workspace;
  const thread = workspace.threads.find((item) => item.id === job.threadId && item.pendingJobId === job.id);
  if (!thread) return workspace;
  const preview = pendingTextReply(thread, job);
  if (preview === thread.pendingPreview) return workspace;
  return { ...workspace, threads: workspace.threads.map((item) => item !== thread ? item : {
    ...item, pendingPreview: preview,
  }) };
}

export function textRuntimeIssue(
  status: Pick<TextRuntimeStatus, "ggufAvailable" | "ggufUnavailableReason" | "runtimeAvailable" | "runtimeError">,
  model: TextModel | undefined,
): string | null {
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
  const outputMaximum = model?.format === "gguf" ? contextSize : 8192;
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

export function ggufLoadOptions(options: GgufLoadOptions | undefined, contextSize: number): GgufLoadOptions {
  if (!options) return {};
  const { flashAttention, promptBatch, microBatch, keyCacheType, valueCacheType } = options;
  const batch = hasNumber(promptBatch, 1, MAX_CHAT_CONTEXT, true) ? Math.min(promptBatch, contextSize) : undefined;
  return {
    flashAttention: flashAttention === "on" || flashAttention === "off" || flashAttention === "auto" ? flashAttention : undefined,
    promptBatch: batch,
    microBatch: hasNumber(microBatch, 1, MAX_CHAT_CONTEXT, true)
      ? Math.min(microBatch, batch ?? Math.min(2048, contextSize)) : undefined,
    keyCacheType: keyCacheType && KV_CACHE_TYPES.includes(keyCacheType) ? keyCacheType : undefined,
    valueCacheType: valueCacheType && KV_CACHE_TYPES.includes(valueCacheType) ? valueCacheType : undefined,
  };
}

export function resolveTextModel(status: TextRuntimeStatus, thread: TextThread): string | undefined {
  if (thread.modelId != null) return thread.modelId;
  const installed = status.models.filter((model) => model.installed);
  const ready = installed.filter((model) => !textRuntimeIssue(status, model));
  const candidates = ready.length ? ready : installed;
  return candidates.find((model) => model.id === status.defaultModelId)?.id ?? candidates[0]?.id;
}

export function finishTextReply(thread: TextThread, reply: TextMessage): TextMessage[] {
  const previous = thread.messages.at(-1);
  if (previous?.role !== "assistant") return [...thread.messages, reply];
  // Keep every attempt in order, including attempts made after selecting an older response.
  const { alternatives = [], ...selected } = previous;
  return [...thread.messages.slice(0, -1), { ...reply, alternatives: [...alternatives, selected] }];
}

export function replyVersions(message: TextMessage): TextMessage[] {
  const { alternatives = [], ...selected } = message;
  return [...alternatives, selected].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function showReplyVersion(message: TextMessage, id: string | undefined): TextMessage {
  if (!id || id === message.id) return message;
  const selected = message.alternatives?.find((version) => version.id === id);
  if (!selected) return message;
  const { alternatives = [], ...current } = message;
  return { ...selected, alternatives: [...alternatives.filter((version) => version.id !== id), current] };
}

export function matchesTextMessage(message: TextMessage | undefined, id: string | undefined) {
  return !!id && (message?.id === id || !!message?.alternatives?.some((version) => version.id === id));
}

export function latestTextPrompt(messages: TextMessage[]): TextMessage | undefined {
  const last = messages.at(-1);
  const prompt = last?.role === "assistant" ? messages.at(-2) : last;
  return prompt?.role === "user" ? prompt : undefined;
}

export function replaceLatestPromptVersion(thread: TextThread, messageId: string, version: TextPromptVersion): TextMessage[] | undefined {
  if (thread.pendingJobId) return;
  const current = latestTextPrompt(thread.messages);
  if (current?.id !== messageId || version.id === (current.promptVersionId ?? current.id)) return;
  const last = thread.messages.at(-1);
  const response = last?.role === "assistant" ? last : undefined;
  const alternatives = (current.promptAlternatives ?? []).filter((item) => item.id !== version.id);
  alternatives.push({ id: current.promptVersionId ?? current.id, content: current.content, createdAt: current.createdAt,
    continuationOf: current.continuationOf, response });
  return [
    ...thread.messages.slice(0, response ? -2 : -1),
    { ...current, content: version.content, createdAt: version.createdAt, continuationOf: version.continuationOf,
      promptVersionId: version.id, promptAlternatives: alternatives },
    ...(version.response ? [version.response] : []),
  ];
}

export function findChatImage(thread: Pick<TextThread, "messages">, name: string | undefined): GeneratedChatImage | undefined {
  if (!name) return;
  function imageFrom(message: TextMessage | undefined): GeneratedChatImage | undefined {
    if (!message) return;
    if (message.generatedImage?.name === name) return message.generatedImage;
    const image = message.generatedImages?.find((item) => item.name === name);
    if (image) return image;
    for (const alternative of message.alternatives ?? []) {
      const found = imageFrom(alternative);
      if (found) return found;
    }
  }
  for (const message of thread.messages) {
    const image = imageFrom(message);
    if (image) return image;
    for (const version of message.promptAlternatives ?? []) {
      const previous = imageFrom(version.response);
      if (previous) return previous;
    }
  }
}

export interface TextMessageDeletion {
  snapshotId?: string;
  messages: TextMessage[];
  index: number;
  beforeId?: string;
  afterId?: string;
  replyPromptVersionId?: string;
  replyVersion?: { selectedId: string; survivingId: string };
  promptEdit?: TextPromptEdit;
  draftContext?: { name: string; threadId?: string; draft: string; lastId?: string };
}

export function removeTextMessage(thread: TextThread, messageId: string, updatedAt: number, versionId?: string) {
  if (thread.pendingJobId) return;
  const index = thread.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return;
  const target = thread.messages[index];
  const end = index + (target.role === "user" && thread.messages[index + 1]?.role === "assistant" ? 2 : 1);
  const beforeMessages = thread.messages.slice(0, index);
  const afterMessages = thread.messages.slice(end);
  const before = thread.messages[index - 1];
  const deletion: TextMessageDeletion = {
    messages: thread.messages.slice(index, end), index,
    beforeId: before?.id, afterId: thread.messages[end]?.id,
    replyPromptVersionId: target.role === "assistant" && before?.role === "user" ? before.promptVersionId ?? before.id : undefined,
    promptEdit: thread.promptEdit?.messageId === messageId ? thread.promptEdit : undefined,
  };
  let replacement: TextMessage[] = [];
  if (versionId !== undefined) {
    if (target.role !== "assistant" || !target.alternatives?.length) return;
    const versions = replyVersions(target);
    const removedIndex = versions.findIndex((reply) => reply.id === versionId);
    if (removedIndex < 0) return;
    const removed = versions[removedIndex];
    const neighbor = versions[removedIndex - 1] ?? versions[removedIndex + 1];
    const chosen = target.id === versionId ? showReplyVersion(target, neighbor.id) : target;
    replacement = [{ ...chosen, alternatives: chosen.alternatives?.filter((reply) => reply.id !== versionId) }];
    deletion.messages = [removed];
    deletion.replyVersion = { selectedId: target.id, survivingId: chosen.id };
  }
  const messages = [...beforeMessages, ...replacement, ...afterMessages];
  const next = { ...thread, messages, updatedAt };
  if (deletion.promptEdit) next.promptEdit = undefined;
  if (thread.draftContextImage && findChatImage(thread, thread.draftContextImage) && !findChatImage(next, thread.draftContextImage)) {
    deletion.draftContext = {
      name: thread.draftContextImage, threadId: thread.draftContextImageThreadId, draft: thread.draft,
      lastId: messages.at(-1)?.id,
    };
    next.draftContextImage = undefined;
    next.draftContextImageThreadId = undefined;
  }
  return { thread: next, deletion };
}

export function savedVersionForDeletedReply(prompt: TextMessage | undefined, deletion: TextMessageDeletion) {
  if (!prompt || prompt.id !== deletion.beforeId || !deletion.replyPromptVersionId) return;
  return prompt.promptAlternatives?.find((version) => version.id === deletion.replyPromptVersionId);
}

function restoreReplyVersions(current: TextMessage, removed: TextMessage): TextMessage {
  return { ...current, alternatives: [...replyVersions(removed), ...(current.alternatives ?? [])] };
}

function restoreDeletedReplyVersion(current: TextMessage, removed: TextMessage, version: NonNullable<TextMessageDeletion["replyVersion"]>) {
  if (matchesTextMessage(current, removed.id)) return current;
  const merged = restoreReplyVersions(current, removed);
  return current.id === version.survivingId && removed.id === version.selectedId ? showReplyVersion(merged, removed.id) : merged;
}

export function restoreTextMessages(thread: TextThread, deletion: TextMessageDeletion, updatedAt: number): TextThread {
  if (thread.pendingJobId) return thread;
  if (!deletion.snapshotId) return restoreMessageDeletion(thread, deletion, updatedAt);
  const snapshot = thread.versions?.find(({ id }) => id === deletion.snapshotId);
  if (!snapshot) return thread;
  const { messages } = restoreMessageDeletion({ ...thread, messages: snapshot.messages }, deletion, updatedAt);
  if (messages === snapshot.messages) return thread;
  return { ...thread, updatedAt, versions: thread.versions?.map((item) => item === snapshot ? { ...item, messages } : item) };
}

function restoreMessageDeletion(thread: TextThread, deletion: TextMessageDeletion, updatedAt: number): TextThread {
  const after = thread.messages.findIndex((message) => matchesTextMessage(message, deletion.afterId));
  const before = thread.messages.findIndex((message) => matchesTextMessage(message, deletion.beforeId));
  const removedReply = deletion.messages[0];
  const deletedVersion = deletion.replyVersion;
  const prompt = thread.messages[before];
  const savedVersion = savedVersionForDeletedReply(prompt, deletion);
  if (savedVersion && prompt?.promptAlternatives) {
    // Keep the answer with the wording that produced it when the prompt was revised after deletion.
    const response = !savedVersion.response ? removedReply : deletedVersion
      ? restoreDeletedReplyVersion(savedVersion.response, removedReply, deletedVersion) : restoreReplyVersions(savedVersion.response, removedReply);
    const promptAlternatives = prompt.promptAlternatives.map((version) => version === savedVersion ? { ...version, response } : version);
    return { ...thread, updatedAt, messages: thread.messages.map((item) => item === prompt ? { ...item, promptAlternatives } : item) };
  }
  const versionIndex = deletedVersion ? thread.messages.findIndex((message) =>
    matchesTextMessage(message, deletedVersion.survivingId) || matchesTextMessage(message, removedReply.id)) : -1;
  if (deletedVersion && versionIndex < 0) return thread;
  const index = versionIndex >= 0 ? versionIndex : after >= 0 ? after : before >= 0 ? before + 1 : Math.min(deletion.index, thread.messages.length);
  const replacement = thread.messages[index];
  // A retry can fill the slot of a deleted reply while Undo is available.
  const mergeReply = !deletedVersion && !deletion.afterId && before >= 0 && thread.messages[before].role === "user" &&
    removedReply.role === "assistant" && replacement?.role === "assistant";
  const restored = deletedVersion ? [restoreDeletedReplyVersion(replacement, removedReply, deletedVersion)]
    : mergeReply ? [restoreReplyVersions(replacement, removedReply)] : deletion.messages;
  const next: TextThread = {
    ...thread, updatedAt,
    messages: [...thread.messages.slice(0, index), ...restored, ...thread.messages.slice(mergeReply || deletedVersion ? index + 1 : index)],
    promptEdit: thread.promptEdit ?? deletion.promptEdit,
  };
  const draft = deletion.draftContext;
  const last = thread.messages.at(-1);
  const sameTail = draft && (draft.lastId ? matchesTextMessage(last, draft.lastId) : !last);
  if (draft && sameTail && thread.draft === draft.draft && !thread.draftContextImage && !thread.draftImage) {
    next.draftContextImage = draft.name;
    next.draftContextImageThreadId = draft.threadId;
  }
  return next;
}

export function draftContextImageOwner(thread: TextThread): string | undefined {
  if (!thread.draftContextImage) return;
  return thread.draftContextImageThreadId ?? findChatImage(thread, thread.draftContextImage)?.originThreadId;
}

export function copyTextHistory(thread: Pick<TextThread, "id" | "messages">, messages = thread.messages): TextMessage[] {
  const copy = (message: TextMessage): TextMessage => ({
    ...message,
    inspectionJobId: undefined,
    includedImageThreadId: message.includedImage ? message.includedImageThreadId ?? findChatImage(thread, message.includedImage)?.originThreadId ?? thread.id : undefined,
    generatedImage: message.generatedImage && {
      ...message.generatedImage, originThreadId: message.generatedImage.originThreadId ?? message.imageThreadId ?? thread.id,
    },
    generatedImages: message.generatedImages?.map((image) => ({ ...image, originThreadId: image.originThreadId ?? message.imageThreadId ?? thread.id })),
    alternatives: message.alternatives?.map(copy),
    promptAlternatives: message.promptAlternatives?.map((version) => ({ ...version, response: version.response && copy(version.response) })),
  });
  return messages.map(copy);
}

export interface TextPromptMessage {
  role: TextMessage["role"];
  content: string;
  image?: string;
  generatedImage?: string;
  includedImage?: string;
  imageThreadId?: string;
}

export const TEXT_MESSAGE_CHARACTER_LIMIT = 20_000;

function normalizeRequestContext(context: TextRequestContext | undefined): TextRequestContext | undefined {
  if (!context) return;
  const { omittedMessages, shortenedMessages, unansweredPrompts, omittedAttachments } = context;
  const counts = [omittedMessages, shortenedMessages, unansweredPrompts, omittedAttachments];
  if (counts.every((value) => Number.isSafeInteger(value) && value >= 0) && counts.some((value) => value > 0)) {
    return { omittedMessages, shortenedMessages, unansweredPrompts, omittedAttachments };
  }
}

function promptPrefixLength(content: string) {
  if (content.length <= TEXT_MESSAGE_CHARACTER_LIMIT) return content.length;
  let length = 0;
  let characters = 0;
  for (const character of content) {
    length += character.length;
    if (++characters === TEXT_MESSAGE_CHARACTER_LIMIT) break;
  }
  return length;
}

export function textPromptExceedsLimit(content: string) {
  return content.length > TEXT_MESSAGE_CHARACTER_LIMIT &&
    countTextPromptCharacters(content, TEXT_MESSAGE_CHARACTER_LIMIT + 1) > TEXT_MESSAGE_CHARACTER_LIMIT;
}

export function countTextPromptCharacters(content: string, limit: number) {
  let count = 0;
  for (const _character of content.trim()) {
    if (++count >= limit) break;
  }
  return count;
}

function shortenHistoryMessage(message: TextPromptMessage) {
  const length = promptPrefixLength(message.content);
  return length < message.content.length ? { ...message, content: message.content.slice(0, length) } : message;
}

export function textPromptHistory(history: TextMessage[], model: TextModel): { messages: TextPromptMessage[]; context?: TextRequestContext } {
  const imageOrigins = new Map<string, string | undefined>();
  const turns: { user: TextPromptMessage; reply: TextPromptMessage; omittedAttachment: boolean }[] = [];
  let prompt: { message: TextPromptMessage; omittedAttachment: boolean } | undefined;
  let unansweredPrompts = 0;
  for (const message of history) {
    const artifact = message.generatedImage;
    if (artifact) imageOrigins.set(artifact.name, artifact.originThreadId);
    for (const variant of message.alternatives ?? []) {
      if (variant.generatedImage) imageOrigins.set(variant.generatedImage.name, variant.generatedImage.originThreadId);
    }
    const hasAttachment = message.role === "user" && !!(message.image || message.includedImage);
    const content = message.content.trim() || (artifact ? "I generated an image." : hasAttachment ? "An image was attached." : "");
    if (!content) continue;
    if (message.role === "user") {
      // The model requires alternating turns. Unanswered prompts stay in the transcript.
      if (prompt) unansweredPrompts += 1;
      prompt = { omittedAttachment: hasAttachment && !model.supportsVision, message: {
        role: "user", content,
        image: model.supportsVision ? message.image : undefined,
        includedImage: model.supportsVision ? message.includedImage : undefined,
        imageThreadId: model.supportsVision && message.includedImage ? message.includedImageThreadId ?? imageOrigins.get(message.includedImage) : undefined,
      } };
    } else if (prompt) {
      turns.push({ user: prompt.message, reply: { role: "assistant", content, generatedImage: artifact?.name,
        imageThreadId: artifact?.originThreadId ?? message.imageThreadId }, omittedAttachment: prompt.omittedAttachment });
      prompt = undefined;
    }
  }
  if (!prompt) return { messages: [] };
  const continuationOf = history.at(-1)?.continuationOf;
  if (continuationOf) {
    const previous = history.at(-2);
    const reply = previous?.id === continuationOf ? previous : previous?.alternatives?.find((item) => item.id === continuationOf);
    if (reply?.role === "assistant" && reply.content.trim()) {
      // Keep the cutoff point available even if the earlier reply gets shortened or compacted.
      // A code point takes at most two UTF-16 code units.
      const ending = [...reply.content.trimEnd().slice(-2_000)].slice(-1_000).join("");
      prompt.message.content += "\n\nThe previous reply ended with this text:\n" + ending;
    }
  }
  const gguf = model.format === "gguf";
  const recent = [prompt.message];
  let characters = prompt.message.content.length;
  let shortenedMessages = 0;
  let omittedAttachments = 0;
  // Shorten only the turns that can still fit in the outgoing context window.
  for (const turn of turns.reverse()) {
    if (recent.length + 2 > (gguf ? 300 : 100)) break;
    const user = shortenHistoryMessage(turn.user);
    const reply = shortenHistoryMessage(turn.reply);
    const size = user.content.length + reply.content.length + (reply.generatedImage ? 2_000 : 0);
    if (characters + size > (gguf ? 200_000 : 80_000)) break;
    characters += size;
    shortenedMessages += Number(user !== turn.user) + Number(reply !== turn.reply);
    omittedAttachments += Number(turn.omittedAttachment);
    recent.push(reply, user);
  }
  recent.reverse();
  let images = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index].image && ++images > 8) {
      recent[index].image = undefined;
      omittedAttachments += 1;
    }
  }
  return { messages: recent, context: normalizeRequestContext({
    omittedMessages: turns.length * 2 - (recent.length - 1), shortenedMessages, unansweredPrompts, omittedAttachments,
  }) };
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

function validMessage(message: TextMessage): boolean {
  return !!message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string";
}

function isTextThreadId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("text-thread-") && value.length <= 100;
}

function restoreMessage(message: TextMessage, restoreAlternatives = true): TextMessage {
  return {
    ...message,
    id: typeof message.id === "string" ? message.id : `message-${crypto.randomUUID()}`,
    createdAt: Number.isFinite(message.createdAt) ? message.createdAt : Date.now(),
    error: typeof message.error === "string" ? message.error : null,
    errorCode: typeof message.errorCode === "string" ? message.errorCode : null,
    failureDiagnostics: message.role === "assistant" && message.status === "failed" ? normalizeTextFailure(message.failureDiagnostics) : undefined,
    modelName: typeof message.modelName === "string" ? message.modelName : undefined,
    image: message.role === "user" && isChatImage(message.image) ? message.image : undefined,
    includedImage: message.role === "user" && isOutputImage(message.includedImage) ? message.includedImage : undefined,
    includedImageThreadId: message.role === "user" && isTextThreadId(message.includedImageThreadId ?? message.imageThreadId)
      ? message.includedImageThreadId ?? message.imageThreadId : undefined,
    generatedImage: message.role === "assistant" && isGeneratedChatImage(message.generatedImage) ? message.generatedImage : undefined,
    generatedImages: message.role === "assistant" && Array.isArray(message.generatedImages)
      ? message.generatedImages.filter(isGeneratedChatImage).slice(0, 4) : undefined,
    inspectionJobId: typeof message.inspectionJobId === "string" ? message.inspectionJobId : undefined,
    reasoning: message.role === "assistant" && typeof message.reasoning === "string" ? message.reasoning : undefined,
    metrics: textResponseMetrics(message.metrics),
    requestContext: message.role === "assistant" ? normalizeRequestContext(message.requestContext) : undefined,
    continuationOf: message.role === "user" && typeof message.continuationOf === "string" ? message.continuationOf : undefined,
    alternatives: restoreAlternatives && message.role === "assistant" && Array.isArray(message.alternatives)
      ? message.alternatives.filter((variant) => validMessage(variant) && variant.role === "assistant").map((variant) => restoreMessage(variant, false))
      : undefined,
    promptVersionId: message.role === "user" && typeof message.promptVersionId === "string" ? message.promptVersionId : undefined,
    promptAlternatives: message.role === "user" && Array.isArray(message.promptAlternatives)
      ? message.promptAlternatives
        .filter((version) => version && typeof version.id === "string" && typeof version.content === "string" && Number.isFinite(version.createdAt))
        .map(({ id, content, createdAt, continuationOf, response }) => ({
          id, content, createdAt, continuationOf: typeof continuationOf === "string" ? continuationOf : undefined,
          response: response?.role === "assistant" && validMessage(response) ? restoreMessage(response) : undefined,
        }))
      : undefined,
  };
}

export function restoreFinishedTextReply(message: TextMessage | undefined): TextMessage | undefined {
  if (!message || message.role !== "assistant" || !validMessage(message) || typeof message.id !== "string"
    || (message.status !== "complete" && message.status !== "stopped" && message.status !== "failed")) return;
  return restoreMessage(message, false);
}

export function restoreTextThreads(value: unknown): TextThreadWorkspace | undefined {
    const saved = value as Partial<TextThreadWorkspace> | null;
    const folders = normalizeChatFolders(saved?.folders);
    const folderIds = new Set(folders.map(({ id }) => id));
    const threads = (Array.isArray(saved?.threads) ? saved.threads : []).filter(validThread).map((thread): TextThread => ({
      ...createTextThread(),
      ...thread,
      folderId: thread.folderId && folderIds.has(thread.folderId) ? thread.folderId : undefined,
      archived: thread.archived === true,
      updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : Date.now(),
      draft: typeof thread.draft === "string" ? thread.draft : "",
      draftImage: isChatImage(thread.draftImage) ? thread.draftImage : undefined,
      draftContextImage: isOutputImage(thread.draftContextImage) ? thread.draftContextImage : undefined,
      documents: normalizeChatDocuments(thread.documents),
      draftContextImageThreadId: isOutputImage(thread.draftContextImage) && isTextThreadId(thread.draftContextImageThreadId) ? thread.draftContextImageThreadId : undefined,
      promptEdit: typeof thread.promptEdit?.content === "string" && thread.messages.some((message) =>
        message?.role === "user" && message.id === thread.promptEdit?.messageId)
        ? thread.promptEdit
        : undefined,
      sourceThreadId: isTextThreadId(thread.sourceThreadId) && thread.sourceThreadId !== thread.id ? thread.sourceThreadId : undefined,
      mode: thread.mode === "reasoning" ? "reasoning" : "instant",
      imageModel: typeof thread.imageModel === "string" ? thread.imageModel : "auto",
      systemPrompt: typeof thread.systemPrompt === "string" ? thread.systemPrompt : "",
      modelId: typeof thread.modelId === "string" ? thread.modelId : null,
      pendingJobId: typeof thread.pendingJobId === "string" ? thread.pendingJobId : null,
      pendingContext: typeof thread.pendingJobId === "string" ? normalizeRequestContext(thread.pendingContext) : undefined,
      pendingPreview: typeof thread.pendingJobId === "string" ? restoreTextReplyPreview(thread.pendingPreview) : undefined,
      device: (["AUTO", "GPU", "CPU"].includes(thread.device) ? thread.device : "AUTO") as TextDevice,
      ...modelDefaultsFromThread(thread),
      messages: thread.messages.filter(validMessage).map((message) => restoreMessage(message)),
      versions: Array.isArray(thread.versions) ? thread.versions.filter((version) => version && typeof version.id === "string"
        && typeof version.label === "string" && Array.isArray(version.messages)).map((version) => ({
          id: version.id, label: version.label, messages: version.messages.filter(validMessage).map((message) => restoreMessage(message)),
        })).filter((version) => version.messages.length > 0) : undefined,
    }));
    if (threads.length) {
      const activeId = threads.find((thread) => thread.id === saved?.activeId)?.id ?? threads[0].id;
      const secondaryId = threads.find((thread) => thread.id !== activeId && thread.id === saved?.secondaryId)?.id;
      return {
        activeId, secondaryId, activePane: secondaryId && saved?.activePane === "secondary" ? "secondary" : "primary",
        splitPercent: normalizeChatSplit(saved?.splitPercent),
        threads,
        folders,
        presets: Array.isArray(saved?.presets) ? saved.presets.filter((entry) =>
          entry && typeof entry.id === "string" && typeof entry.name === "string" && entry.name.trim()
          && entry.settings && typeof entry.settings === "object"
        ).map(({ id, name, settings }) => ({ id, name: name.trim().slice(0, 80), settings: chatPresetSettings(settings) })) : undefined,
        modelDefaults: saved?.modelDefaults && typeof saved.modelDefaults === "object" && !Array.isArray(saved.modelDefaults)
          ? Object.fromEntries(Object.entries(saved.modelDefaults).filter(([, settings]) => settings && typeof settings === "object")
            .map(([id, settings]) => [id, modelDefaultsFromThread(settings)]))
          : undefined,
      };
    }
}

export function createTextWorkspace(): TextThreadWorkspace {
  const thread = createTextThread();
  return { activeId: thread.id, threads: [thread] };
}
