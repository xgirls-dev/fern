import type {
  FluxStatusResponse,
  GenerationPayload,
  StorageMutationResponse,
  StorageStatus,
  DeviceId,
} from "./types";
import { repairMojibakeDeep } from "./text";
import type { GeneratedChatImage, TextModel, TextRuntimeStatus, TextSamplingOverrides } from "./textThreads";
import type { ChatImageOverrides } from "./chatImageSettings";

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

export function recoverChatImage(threadId: string, jobId: string): Promise<{ image: GeneratedChatImage | null; images?: GeneratedChatImage[] }> {
  const query = new URLSearchParams({ threadId, jobId });
  return requestJson(`/api/text/recover-image?${query}`, { signal: AbortSignal.timeout(15_000) });
}

export function inspectChatImage(payload: {
  requestId: string;
  threadId: string;
  modelId: string;
  image: string;
  device: "AUTO" | "GPU" | "CPU";
}): Promise<{ job: TextRuntimeStatus }> {
  return requestJson("/api/text/inspect-image", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function addTextModel(source: string | string[]): Promise<{ model: TextModel; models: TextModel[] }> {
  return requestJson("/api/text/models/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(typeof source === "string" ? { path: source } : { ggufPaths: source }),
  });
}

export function uploadChatImage(image: string): Promise<{ image: string }> {
  return requestJson("/api/text/images", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image }),
  });
}

export function installTextModel(modelId: string): Promise<TextRuntimeStatus> {
  return requestJson("/api/text/models/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId }),
  });
}

export function removeTextModel(modelId: string): Promise<{ models: TextModel[] }> {
  return requestJson("/api/text/models/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId }),
  });
}

export function startTextGeneration(payload: {
  requestId: string;
  threadId: string;
  modelId: string;
  device: "AUTO" | "GPU" | "CPU";
  messages: Array<{ role: "user" | "assistant"; content: string; image?: string; generatedImage?: string; includedImage?: string }>;
  mode?: "instant" | "reasoning";
  imageModel?: string;
  imageSettings?: ChatImageOverrides;
  contextSize?: number;
  systemPrompt: string;
  temperature: number;
  topP: number;
  sampling?: TextSamplingOverrides;
  maxNewTokens: number;
  seed: number;
}): Promise<{ job: TextRuntimeStatus }> {
  return requestJson("/api/text/generate", {
    signal: AbortSignal.timeout(30_000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function stopTextGeneration(): Promise<void> {
  return requestJson("/api/text/stop", { method: "POST" });
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
