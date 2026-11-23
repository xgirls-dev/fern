import type { StudioSettings } from "../lib/types";
import { APPLE_IMAGE_MODEL, kleinLoraLabel } from "../lib/imageModels";
import { ModelMenu } from "./ui/ModelMenu";

export interface ComposerModel {
  id: string;
  label: string;
  family?: string;
  familyLabel?: string;
  defaultSteps?: number;
  defaultGuidance?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  installed?: boolean;
}

const MODEL_LABELS: Record<string, string> = {
  [APPLE_IMAGE_MODEL]: "Klein 4B · MLX",
  "9b": "Klein 9B",
  "4b": "Klein 4B",
  "4b-lora": kleinLoraLabel("4b-lora"),
  "9b-lora": kleinLoraLabel("9b-lora"),
  "qwen21-turbo": "Qwen Image 2.1 Turbo",
  "flux3-klein": "FLUX.3 Klein · INT4",
  "tame-pony-v25-sdxl": "Tame Pony · SDXL",
  "tame-pony-v25-sdxl-int8": "Tame Pony · SDXL INT8",
  "sana-sprint": "SANA-Sprint 0.6B",
  "moss-hades": "MOSS Image · HaDeS",
  "z-image-turbo": "Z-Image Turbo",
  "kromoss-opd-dmd2": "Kromoss OPD · DMD2",
};
const MODEL_CHOICES = window.studio?.platform === "darwin"
  ? [APPLE_IMAGE_MODEL]
  : Object.keys(MODEL_LABELS).filter((id) => id !== APPLE_IMAGE_MODEL);

export function ComposerModelMenu({
  models,
  loading = false,
  value,
  disabled,
  onChange,
  onOpen,
  onManageModels,
}: {
  models: ComposerModel[];
  loading?: boolean;
  value: StudioSettings["model"];
  disabled: boolean;
  onChange: (model: string) => void;
  onOpen: () => void;
  onManageModels: () => void;
}) {
  const selectedId = value && (MODEL_CHOICES.includes(value) || value.startsWith("custom-")) ? value : MODEL_CHOICES[0];
  const byId = new Map(models.map((model) => [model.id, model]));
  const current = byId.get(selectedId);
  const choices = [...MODEL_CHOICES, ...models.map((model) => model.id).filter((modelId) => modelId.startsWith("custom-"))];
  if (selectedId.startsWith("custom-") && !choices.includes(selectedId)) choices.push(selectedId);
  const triggerLabel = loading
    ? "Checking…"
    : current
      ? `${current.label}${current.installed === false ? " · Missing" : ""}`
      : selectedId.startsWith("custom-")
        ? "Custom model · Missing"
        : models.length
        ? `${MODEL_LABELS[selectedId] ?? "Custom model"} · Missing`
        : "No models";

  const options = choices.map((modelId) => {
    const model = byId.get(modelId);
    const installed = Boolean(model && model.installed !== false);
    return {
      value: modelId, label: model?.label ?? MODEL_LABELS[modelId] ?? "Custom image model",
      disabled: !installed, description: installed ? undefined : "Not installed",
    };
  });

  return <div className="composer-model-anchor">
    <ModelMenu label="Image model" className="composer-model-menu" value={selectedId} triggerLabel={triggerLabel}
      options={options} disabled={disabled} onChange={onChange} onOpen={onOpen} onManageModels={onManageModels} />
  </div>;
}
