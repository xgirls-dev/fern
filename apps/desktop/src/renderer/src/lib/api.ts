import type {
  FluxStatusResponse,
  GenerationPayload,
  StorageMutationResponse,
  StorageStatus,
  DeviceId,
} from "./types";
import { repairMojibakeDeep } from "./text";

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
): Promise<FluxStatusResponse> {
  const includeImages = Date.now() - imagesFetchedAt > 3000;
  const query = `?device=${encodeURIComponent(device ?? "AUTO")}&images=${includeImages ? "1" : "0"}`;
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
