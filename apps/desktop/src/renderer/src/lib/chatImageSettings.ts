import { imageDimensionLimits } from "./imageDimensions";
import { fixedImagePreset } from "./imageModels";
import type { StudioSettings } from "./types";

export type ChatImageSettings = Pick<StudioSettings, "width" | "height" | "steps" | "guidance" | "seed" | "seedLocked">;
export type ChatImageOverrides = Omit<ChatImageSettings, "seed" | "seedLocked"> & { seed?: number };

export function chatImageSettings(model: string, saved?: Partial<ChatImageSettings>): ChatImageSettings {
  const preset = fixedImagePreset(model);
  const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const size = preset?.sizes?.includes(512) === false ? preset.sizes[0] : 512;
  const width = number(saved?.width, size);
  const height = number(saved?.height, size);
  const allowedSize = preset?.sizes ? (width === height && preset.sizes.includes(width) ? width : size) : null;
  return {
    width: allowedSize ?? width,
    height: allowedSize ?? height,
    steps: preset && !preset.maximumSteps ? preset.steps : number(saved?.steps, preset?.steps ?? 4),
    guidance: preset?.guidance ?? number(saved?.guidance, 1),
    seed: number(saved?.seed, 42),
    seedLocked: saved?.seedLocked === true,
  };
}

export function chatImageErrors(model: string, settings: ChatImageSettings) {
  const { minimum, maximum, multiple } = imageDimensionLimits(model);
  const errors: Partial<Record<keyof ChatImageSettings, string>> = {};
  for (const side of ["width", "height"] as const) {
    const value = settings[side];
    if (!Number.isInteger(value) || value < minimum || value > maximum || value % multiple !== 0)
      errors[side] = `Use a multiple of ${multiple} between ${minimum} and ${maximum}.`;
  }
  const maximumSteps = fixedImagePreset(model)?.maximumSteps ?? 50;
  if (!Number.isInteger(settings.steps) || settings.steps < 1 || settings.steps > maximumSteps)
    errors.steps = `Use 1 to ${maximumSteps.toLocaleString()} whole steps.`;
  if (!Number.isFinite(settings.guidance) || settings.guidance < 0 || settings.guidance > 10)
    errors.guidance = "Use a guidance value from 0 to 10.";
  if (!Number.isInteger(settings.seed) || settings.seed < 0 || settings.seed > 2_147_483_647)
    errors.seed = "Use a whole seed from 0 to 2,147,483,647.";
  return errors;
}
