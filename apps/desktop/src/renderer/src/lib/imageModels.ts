import type { KleinLoraModel, LoraImageModel, StudioSettings } from "./types";

export const APPLE_IMAGE_MODEL = "klein-4b-mlx";

export function isKleinLoraModel(model?: string): model is KleinLoraModel {
  return model === "4b-lora" || model === "9b-lora";
}

export function kleinLoraLabel(model: KleinLoraModel): string {
  return `Klein ${model === "9b-lora" ? "9B" : "4B"} · LoRA`;
}

export function supportsImageLoras(model?: string): model is LoraImageModel {
  return isKleinLoraModel(model) || model === "z-image-turbo" || model?.startsWith("custom-gguf-") === true;
}

export function selectedImageLoras(settings: StudioSettings) {
  if (!supportsImageLoras(settings.model)) return [];
  const legacy = settings.model === "4b-lora" ? settings.loras : undefined;
  return settings.lorasByModel?.[settings.model] ?? legacy ?? [];
}

export function maxReferenceImages(model = "9b"): number {
  if (model === "4b" || model === "9b" || isKleinLoraModel(model)) return 4;
  return model === "qwen21-turbo" || model.startsWith("custom-gguf-") ? 1 : 0;
}

export function maxImageBatch(model?: string): number {
  return fixedImagePreset(model) || model === "flux3-klein" || model === "qwen21-turbo" ? 1 : 4;
}

const fixedImagePresets: Record<string, { sizes?: number[]; steps: number; guidance: number; maximumSteps?: number }> = {
  [APPLE_IMAGE_MODEL]: { sizes: [512], steps: 4, guidance: 1 },
  "sana-sprint": { sizes: [512, 1024], steps: 2, guidance: 4.5 },
  "moss-hades": { sizes: [384, 512], steps: 4, guidance: 1 },
  "kromoss-opd-dmd2": { steps: 8, guidance: 1, maximumSteps: 2_147_483_646 },
  "z-image-turbo": { sizes: [512], steps: 8, guidance: 1 },
};

export function fixedImagePreset(model?: string) {
  return model && Object.hasOwn(fixedImagePresets, model) ? fixedImagePresets[model] : undefined;
}
