import { useEffect, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import type { StudioSettings } from "../lib/types";
import { APPLE_IMAGE_MODEL, kleinLoraLabel } from "../lib/imageModels";
import { Button } from "./ui/controls";
import { Dropdown, DropdownItem, DropdownRadioGroup, DropdownRadioItem, DropdownSeparator } from "./ui/Dropdown";

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
  const [open, setOpen] = useState(false);
  const availability = models.map(({ id, installed }) => `${id}:${installed !== false}`).join("|");
  const selectedId = value && (MODEL_CHOICES.includes(value) || value.startsWith("custom-")) ? value : MODEL_CHOICES[0];
  const current = models.find((model) => model.id === selectedId);
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

  useEffect(() => {
    setOpen(false);
  }, [availability, disabled]);

  return <div className="composer-model-anchor">
    <Dropdown label="Image model" className="composer-model-menu" side="top" align="end"
      open={open && !disabled}
      onOpenChange={(next) => {
        if (next) onOpen();
        setOpen(next);
      }}
      trigger={<Button variant="ghost" className="composer-model-trigger" aria-label={`Image model: ${triggerLabel}`} disabled={disabled}>
        <span>{triggerLabel}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </Button>}
    >
      <DropdownRadioGroup value={selectedId} onValueChange={onChange}>
        {choices.map((modelId) => {
          const model = models.find((candidate) => candidate.id === modelId);
          const installed = Boolean(model && model.installed !== false);
          const label = model?.label ?? MODEL_LABELS[modelId] ?? "Custom image model";
          return <DropdownRadioItem key={modelId} value={modelId} label={label}
            disabled={!installed} title={`${label}${installed ? "" : " · Not installed"}`}>
            <span className="composer-model-label">{label}</span>
            {installed && selectedId === modelId ? <Check size={14} aria-hidden="true" />
              : !installed ? <span className="composer-model-unavailable">Not installed</span> : null}
          </DropdownRadioItem>;
        })}
      </DropdownRadioGroup>
      <DropdownSeparator />
      <DropdownItem onClick={onManageModels}>Manage models</DropdownItem>
    </Dropdown>
  </div>;
}
