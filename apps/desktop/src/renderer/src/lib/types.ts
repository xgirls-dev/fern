export interface ImageRecord {
  model?: string;
  modelLabel?: string;
  modelFamily?: string | null;
  modelRevision?: string;
  referenceUsed?: boolean;
  referenceUrl?: string;
  referenceUrls?: string[];
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
  selectedModel?: string;
  memoryBytes?: number | null;
  compatibility?: string;
  checking?: boolean;
  runtimeReady: boolean;
  runtimeNote?: string;
  modelId?: string;
  modelDir?: string;
  pipelineClass?: string;
  runtimeBackend?: string;
  supportsReferenceImage?: boolean;
  supportsKvCache?: boolean;
  family?: string;
  familyLabel?: string;
  minimumDimension?: number;
  maximumDimension?: number;
  dimensionMultiple?: number;
  defaultSteps?: number;
  defaultGuidance?: number;
  defaultWidth?: number;
  defaultHeight?: number;
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
  model?: "9b" | "4b" | "qwen21-turbo" | "flux3-klein" | "tame-pony-v25-sdxl" | "tame-pony-v25-sdxl-int8";
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
  installedModels?: { id: string; label: string; family?: string; familyLabel?: string; defaultSteps?: number; defaultGuidance?: number; defaultWidth?: number; defaultHeight?: number; installed?: boolean }[];
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
  model?: string;
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
  reference_images?: string[];
}

export interface StudioSettings {
  model?: string;
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
  images: { bytes: number; fileCount: number };
  audio: { bytes: number; fileCount: number };
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
