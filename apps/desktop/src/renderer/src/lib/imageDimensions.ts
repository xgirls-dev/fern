import type { ModelStatus } from "./types";

export function normalizeQwenDimension(value: number): number {
  if (!Number.isFinite(value)) return 1024;
  return Math.max(256, Math.min(1920, Math.ceil(value / 32) * 32));
}

export function imageDimensionLimits(model: string | undefined, status?: ModelStatus | null) {
  if (model?.startsWith("custom-")) return { multiple: status?.dimensionMultiple ?? 16, minimum: status?.minimumDimension ?? 256, maximum: status?.maximumDimension ?? 1920 };
  if (model?.startsWith("tame-pony-")) return { multiple: 8, minimum: 512, maximum: 1536 };
  if (model === "flux3-klein") return { multiple: 16, minimum: 1024, maximum: 1024 };
  return { multiple: model === "qwen21-turbo" ? 32 : 16, minimum: 256, maximum: 1920 };
}
