import { useEffect, useRef, useState, type ComponentProps } from "react";
import Dices from "lucide-react/dist/esm/icons/dices.mjs";
import Lock from "lucide-react/dist/esm/icons/lock.mjs";
import LockOpen from "lucide-react/dist/esm/icons/lock-open.mjs";
import Shuffle from "lucide-react/dist/esm/icons/shuffle.mjs";
import { imageDimensionLimits, type ImageDimensionHints } from "../lib/imageDimensions";
import { fixedImagePreset, isKleinLoraModel, maxImageBatch } from "../lib/imageModels";
import type { StudioSettings } from "../lib/types";
import { IconButton, Select } from "./ui/controls";

type Canvas = Pick<StudioSettings, "width" | "height">;
type Sampling = Pick<StudioSettings, "steps" | "guidance" | "seed" | "seedLocked">;
type FieldErrors = Partial<Record<keyof (Canvas & Sampling), string>>;
type Fields<T> = {
  model?: string;
  settings: T;
  errors?: FieldErrors;
  disabled?: boolean;
  idPrefix?: string;
  onChange: (update: Partial<T>) => void;
};

const SIZE_PRESETS = [
  [512, 512, "Square 1:1"], [720, 1280, "Portrait 9:16"], [1280, 720, "Landscape 16:9"],
  [1920, 1088, "Wide"], [1088, 1920, "Tall"], [1024, 1024, "Square 1:1"],
  [832, 1216, "Portrait"], [896, 1152, "Portrait"], [1216, 832, "Landscape"], [1152, 896, "Landscape"],
  [1024, 768, "Landscape 4:3"], [768, 1024, "Portrait 3:4"], [1024, 576, "Landscape 16:9"],
  [576, 1024, "Portrait 9:16"], [768, 768, "Square 1:1"],
] as const;

export function ImageCanvasFields({
  model, settings, errors, disabled, idPrefix = "", onChange, modelStatus,
}: Fields<Canvas> & { modelStatus?: ImageDimensionHints | null }) {
  const [custom, setCustom] = useState(false);
  const widthInput = useRef<HTMLInputElement>(null);
  const focusWidth = useRef(false);
  const fixedSizes = fixedImagePreset(model)?.sizes;
  const fixedCanvas = model === "flux3-klein";
  const { minimum, maximum, multiple } = imageDimensionLimits(model, modelStatus);
  const validSize = (value: number) => value >= minimum && value <= maximum && value % multiple === 0;
  const presets = fixedSizes
    ? fixedSizes.map((size) => ({ value: `${size}x${size}`, label: `${size} × ${size}` }))
    : SIZE_PRESETS.filter(([width, height]) => validSize(width) && validSize(height)).map(([width, height, ratio]) => ({
      value: `${width}x${height}`, label: `${width} × ${height} · ${ratio}`,
    }));
  const currentSize = `${settings.width}x${settings.height}`;
  const size = fixedCanvas ? "1024x1024" : (!custom || fixedSizes) && presets.some(({ value }) => value === currentSize) ? currentSize : "custom";
  const resolutionId = `${idPrefix}size-preset`;
  const widthId = `${idPrefix}width`;
  const heightId = `${idPrefix}height`;
  return <>
    <div className="field">
      <label htmlFor={resolutionId}>Resolution</label>
      <Select id={resolutionId} name={resolutionId} value={size} disabled={disabled}
        options={!fixedSizes && !fixedCanvas ? [...presets, { value: "custom", label: "Custom" }] : presets}
        finalFocus={() => {
          const target = focusWidth.current ? widthInput.current : null;
          focusWidth.current = false;
          return target ?? true;
        }}
        onChange={(next) => {
          const customSize = next === "custom";
          focusWidth.current = customSize;
          setCustom(customSize);
          if (!customSize) {
            const [width, height] = next.split("x").map(Number);
            onChange({ width, height });
          }
        }} />
    </div>
    <div className="dims-row" hidden={Boolean(fixedSizes)}>
      <div className="field">
        <label htmlFor={widthId}>Width</label>
        <DraftNumberInput ref={widthInput} error={errors?.width} id={widthId} name={widthId} type="number" disabled={disabled || fixedCanvas}
          min={minimum} max={maximum} step={multiple} value={settings.width} onChange={(event) => onChange({ width: Number(event.target.value) })} />
      </div>
      <IconButton disabled={disabled || fixedCanvas} onClick={() => onChange({ width: settings.height, height: settings.width })}
        title="Swap dimensions" aria-label="Swap width and height">
        <Shuffle size={15} aria-hidden="true" />
      </IconButton>
      <div className="field">
        <label htmlFor={heightId}>Height</label>
        <DraftNumberInput error={errors?.height} id={heightId} name={heightId} type="number" disabled={disabled || fixedCanvas}
          min={minimum} max={maximum} step={multiple} value={settings.height} onChange={(event) => onChange({ height: Number(event.target.value) })} />
      </div>
    </div>
  </>;
}

export function ImageSamplingFields({ model, settings, errors, disabled, idPrefix = "", onChange }: Fields<Sampling>) {
  const preset = fixedImagePreset(model);
  const adjustableSteps = Boolean(preset?.maximumSteps);
  const fixedSampling = Boolean(preset) || model === "flux3-klein" || model === "qwen21-turbo";
  const fixedGuidance = fixedSampling || isKleinLoraModel(model);
  const seedId = `${idPrefix}seed`;
  const stepsId = `${idPrefix}steps`;
  const guidanceId = `${idPrefix}guidance`;
  const guidanceMaximum = model?.startsWith("custom-") ? 20 : 10;
  const lockLabel = settings.seedLocked ? "Unlock seed" : "Lock seed";
  return <>
    <div className="field">
      <label htmlFor={seedId}>Seed</label>
      <div className="seed-row">
        <DraftNumberInput error={errors?.seed} id={seedId} name={seedId} type="number" disabled={disabled}
          value={settings.seed} onChange={(event) => onChange({ seed: Number(event.target.value) })} />
        <IconButton disabled={disabled} title="Randomize seed" aria-label="Randomize seed"
          onClick={() => onChange({ seed: Math.floor(Math.random() * 1_000_000_000) })}>
          <Dices size={15} aria-hidden="true" />
        </IconButton>
        <IconButton disabled={disabled} title={lockLabel} aria-label={lockLabel} aria-pressed={settings.seedLocked}
          onClick={() => onChange({ seedLocked: !settings.seedLocked })}>
          {settings.seedLocked ? <Lock size={15} aria-hidden="true" /> : <LockOpen size={15} aria-hidden="true" />}
        </IconButton>
      </div>
    </div>
    <div className="field" hidden={fixedSampling && !adjustableSteps}>
      <label htmlFor={stepsId}>Steps</label>
      <div className={adjustableSteps ? undefined : "range-pair"}>
        {!adjustableSteps && <input id={stepsId} name={stepsId} type="range" disabled={disabled}
          min={1} max={50} step={1} value={settings.steps}
          aria-invalid={Boolean(errors?.steps)} aria-describedby={errors?.steps ? `${idPrefix}step-count-error` : undefined}
          onChange={(event) => onChange({ steps: Number(event.target.value) })} />}
        <DraftNumberInput error={errors?.steps} className={adjustableSteps ? undefined : "compact-input"}
          id={adjustableSteps ? stepsId : undefined} aria-label="Step count" name={`${idPrefix}step-count`} type="number" disabled={disabled}
          min={1} max={preset?.maximumSteps ?? 50} value={settings.steps} onChange={(event) => onChange({ steps: Number(event.target.value) })} />
      </div>
      {adjustableSteps && <small className="field-note">{preset?.steps} steps recommended for the bundled DMD2 adapter.</small>}
    </div>
    <div className="field" hidden={fixedGuidance}>
      <label htmlFor={guidanceId}>Guidance</label>
      <div className="range-pair">
        <input id={guidanceId} name={guidanceId} type="range" disabled={disabled} min={0} max={guidanceMaximum} step={0.1}
          value={settings.guidance} aria-invalid={Boolean(errors?.guidance)} aria-describedby={errors?.guidance ? `${idPrefix}guidance-value-error` : undefined}
          onChange={(event) => onChange({ guidance: Number(event.target.value) })} />
        <DraftNumberInput error={errors?.guidance} className="compact-input" aria-label="Guidance value" name={`${idPrefix}guidance-value`}
          type="number" disabled={disabled} min={0} max={guidanceMaximum} step={0.1} value={settings.guidance}
          onChange={(event) => onChange({ guidance: Number(event.target.value) })} />
      </div>
    </div>
  </>;
}

export function ImageBatchField({ model, value, disabled, id = "batch-size", onChange }: {
  model?: string;
  value: number;
  disabled?: boolean;
  id?: string;
  onChange: (value: number) => void;
}) {
  const maximum = maxImageBatch(model);
  return <div className="field">
    <label htmlFor={id}>Images per render</label>
    <Select id={id} name={id} value={maximum === 1 ? 1 : value} disabled={disabled || maximum === 1}
      onChange={onChange} options={Array.from({ length: maximum }, (_, index) => ({
        value: index + 1, label: index === 0 ? "1 image" : `${index + 1} images`,
      }))} />
    {maximum === 1 && <small className="field-note">This model generates one image per request.</small>}
  </div>;
}

function DraftNumberInput({ error, ...props }: ComponentProps<"input"> & { error?: string }) {
  const [draft, setDraft] = useState(String(props.value ?? ""));
  const focused = useRef(false);
  const lastEdit = useRef(props.value);
  useEffect(() => {
    if (!focused.current || props.value !== lastEdit.current) setDraft(String(props.value ?? ""));
  }, [props.value]);
  const errorId = `${props.id ?? props.name}-error`;
  return <>
    <input {...props} value={draft} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
      onFocus={(event) => {
        focused.current = true;
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        focused.current = false;
        props.onBlur?.(event);
      }}
      onChange={(event) => {
        lastEdit.current = Number(event.target.value);
        setDraft(event.target.value);
        props.onChange?.(event);
      }} />
    {error && <span className="field-error" id={errorId} role="alert">{error}</span>}
  </>;
}
