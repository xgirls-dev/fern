const stages = {
  "request-admission": "Starting the request",
  "preparing-conversation": "Preparing the conversation",
  "finding-documents": "Finding document passages",
  "starting-worker": "Starting the text worker",
  "selecting-device": "Selecting the device",
  "setting-up-runtime": "Setting up the runtime",
  "loading-model": "Loading the model",
  "releasing-image-runtime": "Releasing the image model",
  "waiting-for-first-token": "Processing the prompt",
  "generating-reply": "Generating the reply",
  "checking-reply": "Checking the result",
  "generating-image": "Generating an image",
  "connection-lost": "Recovering an interrupted request",
} as const;

const runtimes = { gguf: "GGUF (llama.cpp)", openvino: "OpenVINO GenAI" } as const;
const backends = { openvino: "OpenVINO", vulkan: "Vulkan", metal: "Metal", cpu: "llama.cpp CPU" } as const;
const devices = { AUTO: "Auto", GPU: "GPU", CPU: "CPU" } as const;
const platforms = { darwin: "macOS", linux: "Linux", win32: "Windows" } as const;
const architectures = { arm64: "arm64", x64: "x64" } as const;
const failureCodes = new Set(["intel-vulkan-driver", "empty-response", "backend-restarted", "out-of-memory"]);
const memoryFailure = /\bout of (?:(?:gpu|host|device) )?memory\b|\b(?:ggml_aligned_malloc:\s*insufficient memory|cannot allocate memory)\b|\b(?:VK_ERROR_OUT_OF_(?:DEVICE|HOST)_MEMORY|ErrorOutOf(?:Device|Host)Memory|CL_MEM_OBJECT_ALLOCATION_FAILURE|CL_OUT_OF_HOST_MEMORY|std::bad_alloc)\b|\bexceeded max size of memory object allocation\b/i;

export function textFailureCode(code: unknown, error?: unknown): string | null {
  if (typeof code === "string" && code) return code;
  // Older replies can contain the runtime error without its structured code.
  return typeof error === "string" && memoryFailure.test(error) ? "out-of-memory" : null;
}

export interface TextFailureDiagnostics {
  stage?: keyof typeof stages;
  runtime?: keyof typeof runtimes;
  backend?: keyof typeof backends;
  requestedDevice?: keyof typeof devices;
  device?: keyof typeof devices;
  appVersion?: string;
  platform?: keyof typeof platforms;
  architecture?: keyof typeof architectures;
}

function knownKey<T extends object>(table: T, value: unknown): keyof T | undefined {
  return typeof value === "string" && Object.hasOwn(table, value) ? value as keyof T : undefined;
}

export function normalizeTextFailure(value: unknown): TextFailureDiagnostics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Partial<Record<keyof TextFailureDiagnostics, unknown>>;
  return {
    stage: knownKey(stages, data.stage),
    runtime: knownKey(runtimes, data.runtime),
    backend: knownKey(backends, data.backend),
    requestedDevice: knownKey(devices, data.requestedDevice),
    device: data.device === "CPU" || data.device === "GPU" ? data.device : undefined,
    appVersion: typeof data.appVersion === "string" && data.appVersion.length <= 40 &&
      /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(data.appVersion) ? data.appVersion : undefined,
    platform: knownKey(platforms, data.platform),
    architecture: knownKey(architectures, data.architecture),
  };
}

export function captureTextFailure(data: TextFailureDiagnostics = {}): TextFailureDiagnostics | undefined {
  const { appVersion, platform, architecture } = window.studio;
  return normalizeTextFailure({ ...data, appVersion, platform, architecture });
}

export function formatTextFailure(data: TextFailureDiagnostics | undefined, code: string | null | undefined) {
  const failure = normalizeTextFailure(data);
  const current = captureTextFailure();
  const platform = failure?.platform ?? current?.platform;
  const architecture = failure?.architecture ?? current?.architecture;
  const system = [platform && platforms[platform], architecture && architectures[architecture]].filter(Boolean).join(" ") || "Unknown";
  const runtime = [failure?.runtime && runtimes[failure.runtime], failure?.backend && backends[failure.backend]]
    .filter(Boolean).join(" / ") || "Unknown";
  const version = failure?.appVersion ?? (current?.appVersion ? `Unknown (currently ${current.appVersion})` : "Unknown");
  const error = code && failureCodes.has(code) ? code : "unspecified";
  return [
    "Fern chat diagnostics",
    `Fern version at failure: ${version}`,
    `System: ${system}`,
    `Runtime: ${runtime}`,
    `Requested device: ${failure?.requestedDevice ? devices[failure.requestedDevice] : "Unknown"}`,
    `Selected device: ${failure?.device ? devices[failure.device] : "Unknown"}`,
    `Stage: ${failure?.stage ? stages[failure.stage] : "Unknown"}`,
    `Failure code: ${error}`,
  ].join("\n");
}
