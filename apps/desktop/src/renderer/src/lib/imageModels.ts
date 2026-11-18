import type { KleinLoraModel, StudioSettings } from "./types";

export function isKleinLoraModel(model?: string): model is KleinLoraModel {
  return model === "4b-lora" || model === "9b-lora";
}

export function kleinLoraLabel(model: KleinLoraModel): string {
  return `Klein ${model === "9b-lora" ? "9B" : "4B"} · LoRA`;
}

export function selectedKleinLoras(settings: StudioSettings) {
  if (!isKleinLoraModel(settings.model)) return [];
  const legacy = settings.model === "4b-lora" ? settings.loras : undefined;
  return settings.lorasByModel?.[settings.model] ?? legacy ?? [];
}

export function maxReferenceImages(model = "9b"): number {
  if (model === "4b" || model === "9b" || isKleinLoraModel(model)) return 4;
  return model === "qwen21-turbo" ? 1 : 0;
}
