import type {
  FluxStatusResponse,
  GenerationPayload,
  StorageMutationResponse,
  StorageStatus,
  DeviceId,
} from "./types";
import { repairMojibake, repairMojibakeDeep } from "./text";
import type { GeneratedChatImage, GgufLoadOptions, TextJob, TextModel, TextModelRemoval, TextPromptMessage, TextRuntimeStatus, TextSamplingOverrides } from "./textThreads";
import type { ChatImageOverrides } from "./chatImageSettings";
import type { ChatDocument } from "./chatDocuments";

let apiBaseUrl = "";
let cachedImages: FluxStatusResponse["images"] = [];
let imagesFetchedAt = 0;
export function invalidateImages() {
  imagesFetchedAt = 0;
}

export function setApiBaseUrl(url: string): void {
  if (apiBaseUrl !== url.replace(/\/$/, "")) {
    cachedImages = [];
    invalidateImages();
  }
  apiBaseUrl = url.replace(/\/$/, "");
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

export function resolveAssetUrl(
  path: string,
  cacheKey?: string | number,
): string {
  if (
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("data:")
  ) {
    if (cacheKey == null || path.startsWith("data:")) return path;
    return `${path}${path.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(cacheKey))}`;
  }
  const resolved = `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  return cacheKey == null
    ? resolved
    : `${resolved}${resolved.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(cacheKey))}`;
}

export async function fetchStatus(
  device?: DeviceId,
  model = "9b",
  pollImages = true,
): Promise<FluxStatusResponse> {
  const includeImages = pollImages && Date.now() - imagesFetchedAt > 3000;
  const query = `?device=${encodeURIComponent(device ?? "AUTO")}&model=${encodeURIComponent(model)}&images=${includeImages ? "1" : "0"}`;
  const response = await fetch(`${apiBaseUrl}/api/flux2/status${query}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const data = repairMojibakeDeep(await response.json());
  if (!response.ok) {
    throw new Error(data.error || "Failed to fetch status");
  }
  if (Array.isArray(data.images)) {
    cachedImages = data.images;
    imagesFetchedAt = Date.now();
  }
  if (
    data.job?.output &&
    !cachedImages.some((image) => image.name === data.job.output.name)
  ) {
    cachedImages = [data.job.output, ...cachedImages];
  }
  data.images = cachedImages;
  return data;
}

export async function startGeneration(
  payload: GenerationPayload,
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/flux2/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = repairMojibakeDeep(
      await response.json().catch(() => ({ error: "Request failed" })),
    );
    throw new Error(data.error || "Generation request failed");
  }
}

export async function stopGeneration(): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/flux2/stop`, {
    method: "POST",
  });
  const data = repairMojibakeDeep(await response.json().catch(() => ({})));
  if (!response.ok) {
    // The job can finish between the button click and this request. Treat
    // that race as success; the next status refresh will show the result.
    if (response.status === 409 && data?.job?.status !== "running") return;
    throw new Error(data?.error || "Could not stop generation");
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  const data = repairMojibakeDeep(
    await response.json().catch(() => ({ error: "Request failed" })),
  );
  if (!response.ok) {
    throw new Error(data.error || "Storage request failed");
  }
  return data as T;
}

export function fetchStorageStatus(): Promise<StorageStatus> {
  return requestJson<StorageStatus>("/api/storage/status");
}

export function clearGenerationCache(): Promise<StorageMutationResponse> {
  return requestJson<StorageMutationResponse>("/api/storage/cleanup-cache", {
    method: "POST",
  });
}

export async function clearLocalData(): Promise<StorageMutationResponse> {
  const result = await requestJson<StorageMutationResponse>(
    "/api/storage/clear-local-data",
    {
      method: "POST",
    },
  );
  cachedImages = [];
  invalidateImages();
  return result;
}

export function fetchTextStatus(): Promise<TextRuntimeStatus> {
  return requestJson<TextRuntimeStatus>("/api/text/status", { signal: AbortSignal.timeout(15_000) });
}

export function fetchTextJob(): Promise<TextJob> {
  return requestJson<TextJob>("/api/text/job", { signal: AbortSignal.timeout(4_000) });
}

type TextJobFrame = { job: TextJob | null } | { heartbeat: true } | {
  append: Pick<TextJob, "phase" | "image" | "images"> & { text: string; reasoning: string };
};

export function subscribeToTextJob(threadId: string, jobId: string, onJob: (job: TextJob) => void, onLost: () => void) {
  const query = new URLSearchParams({ threadId, jobId });
  const events = new EventSource(`${apiBaseUrl}/api/text/job/events?${query}`);
  let latest: TextJob | null = null;
  let timeout: number;
  let appendFrame: number | undefined;
  let appendFallback: number | undefined;
  let lastAppendAt = -Infinity;
  let closed = false;
  function clearAppend() {
    if (appendFrame !== undefined) window.cancelAnimationFrame(appendFrame);
    window.clearTimeout(appendFallback);
    appendFrame = undefined;
    appendFallback = undefined;
  }
  function publishAppend() {
    clearAppend();
    if (latest?.status !== "running") return;
    onJob({
      ...latest,
      partialText: repairMojibake(latest.partialText),
      partialReasoning: repairMojibake(latest.partialReasoning ?? ""),
    });
    lastAppendAt = performance.now();
  }
  function close() {
    if (closed) return;
    closed = true;
    events.close();
    window.clearTimeout(timeout);
    clearAppend();
  }
  function lost() {
    if (closed) return;
    if (appendFrame !== undefined) publishAppend();
    close();
    onLost();
  }
  function expectFrame() {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(lost, 15_000);
  }
  expectFrame();
  events.onerror = lost;
  events.onmessage = ({ data }) => {
    if (closed) return;
    expectFrame();
    try {
      const frame: TextJobFrame = JSON.parse(data);
      if ("heartbeat" in frame) return;
      if ("job" in frame && frame.job?.id === jobId && frame.job.threadId === threadId && frame.job.status !== "idle") {
        if (appendFrame !== undefined) publishAppend();
        latest = frame.job;
        if (latest.status !== "running") close();
        onJob(repairMojibakeDeep(latest));
        return;
      }
      if ("append" in frame && latest?.status === "running") {
        const { text, reasoning, phase, images, image } = frame.append;
        const immediate = phase !== latest.phase || images !== undefined ||
          (!!text && !latest.partialText) || (!!reasoning && !latest.partialReasoning);
        if (!immediate && !text && !reasoning) return;
        latest = {
          ...latest, phase,
          partialText: latest.partialText + text,
          partialReasoning: (latest.partialReasoning ?? "") + reasoning,
          ...(images ? { image, images } : {}),
        };
        // A paced update needn't wait for a frame. Batch only deltas that
        // follow another publication within a frame's worth of time.
        if (immediate || (appendFrame === undefined && performance.now() - lastAppendAt >= 16)) publishAppend();
        else if (appendFrame === undefined) {
          // Several deltas can arrive together after the UI was busy. Publish
          // the accumulated text once and keep background checkpoints moving.
          appendFrame = window.requestAnimationFrame(publishAppend);
          appendFallback = window.setTimeout(publishAppend, 50);
        }
        return;
      }
    } catch { /* Polling can recover if the stream fails to decode. */ }
    lost();
  };
  return close;
}

export function recoverChatImage(threadId: string, jobId: string, cancel: AbortSignal): Promise<{ image: GeneratedChatImage | null; images?: GeneratedChatImage[] }> {
  const query = new URLSearchParams({ threadId, jobId });
  return requestJson(`/api/text/recover-image?${query}`, { signal: AbortSignal.any([cancel, AbortSignal.timeout(4_000)]) });
}

export type TextJobAcceptance = { textJob: TextJob } | { job: TextRuntimeStatus };

function submitTextJob(path: string, payload: object): Promise<TextJobAcceptance> {
  const timeout = 30_000;
  return requestJson(path, {
    method: "POST",
    signal: AbortSignal.timeout(timeout),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, admitBefore: Date.now() + timeout, jobOnly: true }),
  });
}

export function inspectChatImage(payload: {
  requestId: string;
  threadId: string;
  modelId: string;
  image: string;
  imageThreadId?: string;
  device: "AUTO" | "GPU" | "CPU";
}): Promise<TextJobAcceptance> {
  return submitTextJob("/api/text/inspect-image", payload);
}

export function addTextModel(source: string | string[]): Promise<{ model: TextModel; models: TextModel[] }> {
  return requestJson("/api/text/models/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(typeof source === "string" ? { path: source } : { ggufPaths: source }),
  });
}

export function uploadChatImage(image: string, cancel?: AbortSignal): Promise<{ image: string }> {
  return requestJson("/api/text/images", {
    method: "POST",
    signal: cancel ? AbortSignal.any([cancel, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image }),
  });
}

export async function uploadChatDocument(file: File): Promise<{ document: ChatDocument }> {
  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error("Fern could not read the document. Try attaching it again."));
    reader.readAsDataURL(file);
  });
  return requestJson("/api/text/documents", {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, content }),
  });
}

export function installTextModel(modelId: string, repair = false): Promise<TextRuntimeStatus> {
  return requestJson("/api/text/models/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(repair ? { modelId, repair } : { modelId }),
  });
}

export function pauseTextModelDownload(jobId: string): Promise<{ modelInstall: NonNullable<TextRuntimeStatus["modelInstall"]> }> {
  return requestJson("/api/text/models/install/pause", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
}

export function removeTextModel(modelId: string, action: TextModelRemoval):
  Promise<Pick<TextRuntimeStatus, "models" | "recommendedModels">> {
  return requestJson("/api/text/models/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, action }),
  });
}

export function startTextGeneration(payload: {
  requestId: string;
  threadId: string;
  modelId: string;
  device: "AUTO" | "GPU" | "CPU";
  documentIds?: string[];
  messages: TextPromptMessage[];
  mode?: "instant" | "reasoning";
  imageModel?: string;
  imageSettings?: ChatImageOverrides;
  contextSize?: number;
  loadOptions?: GgufLoadOptions;
  systemPrompt: string;
  temperature: number;
  topP: number;
  sampling?: TextSamplingOverrides;
  maxNewTokens: number;
  seed: number;
}): Promise<TextJobAcceptance> {
  return submitTextJob("/api/text/generate", payload);
}

export function stopTextGeneration(requestId: string, threadId?: string): Promise<{ cancelledBeforeStart?: boolean }> {
  return requestJson("/api/text/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, threadId, jobOnly: true }),
    signal: AbortSignal.timeout(15_000),
  });
}

export async function deleteThreadAssets(
  threadId: string,
  imageNames: string[],
): Promise<string[]> {
  const result = await requestJson<{ deleted: string[] }>(
    "/api/threads/delete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: threadId, image_names: imageNames }),
    },
  );
  cachedImages = cachedImages.filter(
    (image) => !result.deleted.includes(image.name),
  );
  invalidateImages();
  return result.deleted;
}

export interface VideoClip {
  id: string;
  name: string;
  url: string;
  posterUrl: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  duration: number;
  generationTime: number;
  modelLabel: string;
}

export interface VideoJob {
  id: string | null;
  status: "idle" | "running" | "stopping" | "complete" | "cancelled" | "failed";
  phase: string | null;
  output: VideoClip | null;
  error: string | null;
}

export interface VideoSnapshot {
  job: VideoJob;
  model: { runtimeReady: boolean; runtimeNote: string; platformSupported: boolean };
  clips: VideoClip[];
}

export function fetchVideoStatus(jobOnly: boolean): Promise<Omit<VideoSnapshot, "clips"> & { clips: VideoClip[] | null }> {
  return requestJson(jobOnly ? "/api/video/status?job=1" : "/api/video/status", { signal: AbortSignal.timeout(5000) });
}

export function mutateVideo(action: "generate" | "stop" | "remove", payload?: object): Promise<Pick<VideoSnapshot, "job"> & Partial<Pick<VideoSnapshot, "clips">>> {
  return requestJson(`/api/video/${action}`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
