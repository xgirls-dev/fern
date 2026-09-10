export interface ImageRecord {
  referenceUsed?: boolean;
  referenceUrl?: string;
  threadId?: string;
  name: string;
  url: string;
  mtime: number;
  prompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  device?: string;
  modelPath?: string;
  generationTime?: number;
}

export interface ModelStatus {
  runtimeReady: boolean;
  runtimeNote?: string;
  modelId?: string;
  modelDir?: string;
  pipelineClass?: string;
  runtimeBackend?: string;
  supportsReferenceImage?: boolean;
  requestedDevice?: DeviceId;
  selectedDevice?: Exclude<DeviceId, "AUTO">;
  adapters?: DeviceAdapter[];
}

export type DeviceId = "AUTO" | "INTEL_GPU" | "NVIDIA_GPU" | "CPU";

export interface DeviceAdapter {
  id: Exclude<DeviceId, "AUTO">;
  label: string;
  available: boolean;
  runtimeReady: boolean;
  modelId?: string;
  modelDir?: string;
  runtimeBackend?: string;
  note?: string;
  hardwareNote?: string;
  supportsReferenceImage?: boolean;
}

export interface FluxJob {
  threadId?: string | null;
  id: string | null;
  status: "idle" | "running" | "complete" | "cancelled" | "failed";
  logs: string[];
  startedAt: number | null;
  finishedAt: number | null;
  output: ImageRecord | null;
  error: string | null;
}

export interface RuntimeStatus {
  status: "idle" | "pending" | "loading" | "ready" | "blocked" | "failed";
  message: string;
  device: string | null;
  logs: string[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export interface FluxStatusResponse {
  job: FluxJob;
  images: ImageRecord[];
  model: ModelStatus;
  runtime: RuntimeStatus;
  defaults: {
    device: string;
    width: number;
    height: number;
    steps: number;
    guidance: number;
  };
}

export interface GenerationPayload {
  thread_id?: string;
  prompt: string;
  device: DeviceId;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed: number;
  batch_size?: number;
  reference_image?: string;
}

export interface StudioSettings {
  prompt: string;
  device: DeviceId;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed: number;
  batchSize: number;
  seedLocked: boolean;
  theme: "light" | "dark";
}

export interface StorageStatus {
  cache: {
    bytes: number;
    fileCount: number;
    retentionDays: number;
    maxBytes: number;
  };
  outputs: {
    bytes: number;
    fileCount: number;
  };
  metadata: {
    bytes: number;
  };
  models: {
    bytes: number;
    preservedOnReset: boolean;
  };
  disk: {
    freeBytes: number;
    totalBytes: number;
    reserveBytes: number;
  };
  managedBytes: number;
}

export interface StorageMutationResponse {
  storage: StorageStatus;
  removed?: {
    cacheBytes: number;
    outputBytes: number;
    outputFiles: number;
    metadataBytes: number;
    metadataFiles: number;
  };
}
