import { imageDimensionLimits, type ImageDimensionHints } from "./imageDimensions";
import { fixedImagePreset, maxImageBatch, maxReferenceImages, supportsImageLoras } from "./imageModels";
import { isChatImage } from "./textThreads";
import type { LoraSelection, ModelStatus, StudioSettings } from "./types";

export const MAX_IMAGE_PROMPT_SUFFIX = 2000;
export type ChatImageModel = { id: string; label: string } & ImageDimensionHints
  & Pick<ModelStatus, "defaultWidth" | "defaultHeight" | "defaultSteps" | "defaultGuidance">;

export type ChatImageSettings = Pick<StudioSettings, "width" | "height" | "steps" | "guidance" | "seed" | "seedLocked" | "batchSize">
  & { loras?: LoraSelection[]; references?: Array<{ name: string; label: string }>; useMessageImage?: boolean; promptSuffix: string };
export type ChatImageOverrides = Omit<ChatImageSettings, "seed" | "seedLocked" | "references" | "batchSize" | "promptSuffix">
  & { seed?: number; batchSize?: number; referenceImages?: string[]; promptSuffix?: string };

export function chatImageSettings(option: ChatImageModel, saved?: Partial<ChatImageSettings>): ChatImageSettings {
  const model = option.id;
  const preset = fixedImagePreset(model);
  const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const size = preset?.sizes?.includes(512) === false ? preset.sizes[0] : 512;
  const width = number(saved?.width, option.defaultWidth ?? size);
  const height = number(saved?.height, option.defaultHeight ?? size);
  const allowedSize = preset?.sizes ? (width === height && preset.sizes.includes(width) ? width : size) : null;
  const referenceLimit = maxReferenceImages(model);
  return {
    width: allowedSize ?? width,
    height: allowedSize ?? height,
    steps: model === "qwen21-turbo" ? 8 : preset && !preset.maximumSteps ? preset.steps : number(saved?.steps, preset?.steps ?? option.defaultSteps ?? 4),
    guidance: model === "qwen21-turbo" ? 1 : preset?.guidance ?? number(saved?.guidance, option.defaultGuidance ?? 1),
    seed: number(saved?.seed, 42),
    seedLocked: saved?.seedLocked === true,
    promptSuffix: typeof saved?.promptSuffix === "string" ? saved.promptSuffix.slice(0, MAX_IMAGE_PROMPT_SUFFIX) : "",
    batchSize: maxImageBatch(model) === 1 ? 1 : Math.min(maxImageBatch(model), Math.max(1, Math.round(number(saved?.batchSize, 1)))),
    ...(referenceLimit && Array.isArray(saved?.references) ? {
      references: saved.references.filter((item) => item && isChatImage(item.name) && typeof item.label === "string")
        .slice(0, referenceLimit),
    } : {}),
    ...(referenceLimit && saved?.useMessageImage === true ? { useMessageImage: true } : {}),
    ...(supportsImageLoras(model) && Array.isArray(saved?.loras) ? {
      loras: saved.loras.filter((item) => item && typeof item.path === "string" && typeof item.strength === "number"
        && typeof item.enabled === "boolean").slice(0, 4),
    } : {}),
  };
}

export function chatImageErrors(option: ChatImageModel, settings: ChatImageSettings) {
  const model = option.id;
  const { minimum, maximum, multiple } = imageDimensionLimits(model, option);
  const errors: Partial<Record<keyof ChatImageSettings, string>> = {};
  for (const side of ["width", "height"] as const) {
    const value = settings[side];
    if (!Number.isInteger(value) || value < minimum || value > maximum || value % multiple !== 0)
      errors[side] = `Use a multiple of ${multiple} between ${minimum} and ${maximum}.`;
  }
  const maximumSteps = fixedImagePreset(model)?.maximumSteps ?? 50;
  if (!Number.isInteger(settings.steps) || settings.steps < 1 || settings.steps > maximumSteps)
    errors.steps = `Use 1 to ${maximumSteps.toLocaleString()} whole steps.`;
  const maxGuidance = model.startsWith("custom-") ? 20 : 10;
  if (!Number.isFinite(settings.guidance) || settings.guidance < 0 || settings.guidance > maxGuidance)
    errors.guidance = `Use a guidance value from 0 to ${maxGuidance}.`;
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2_147_483_647)
    errors.seed = "Use a whole seed from 0 to 2,147,483,647.";
  if (settings.loras?.some((item) => !Number.isFinite(item.strength) || item.strength < -4 || item.strength > 4))
    errors.loras = "Use LoRA strengths between -4 and 4.";
  if ((settings.references?.length ?? 0) + Number(Boolean(settings.useMessageImage)) > maxReferenceImages(model))
    errors.references = "Remove an image to stay within this model’s reference limit.";
  return errors;
}
