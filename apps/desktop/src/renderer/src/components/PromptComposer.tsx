import { ComposerModelMenu, type ComposerModel } from "./ComposerModelMenu";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import Dices from "lucide-react/dist/esm/icons/dices.mjs";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useRef, useState } from "react";
import { normalizeQwenDimension } from "../lib/imageDimensions";
import { readReference } from "../lib/reference";
import type { StudioSettings } from "../lib/types";

interface PromptComposerProps {
  onReferenceBusy: (busy: boolean) => void;
  settings: StudioSettings;
  installedModels?: ComposerModel[];
  referenceImage: string;
  referenceLabel: string;
  supportsReference: boolean;
  running: boolean;
  busyElsewhere: boolean;
  submitting: boolean;
  stopping: boolean;
  ready: boolean;
  inspectorOpen: boolean;
  onSettingsChange: (patch: Partial<StudioSettings>) => void;
  onReferenceChange: (dataUrl: string, label: string) => void;
  onClearReference: () => void;
  onToggleInspector: () => void;
  onGenerate: () => void;
}

export function PromptComposer({
  onReferenceBusy,
  settings,
  installedModels,
  referenceImage,
  referenceLabel,
  supportsReference,
  running,
  busyElsewhere,
  submitting,
  stopping,
  ready,
  inspectorOpen,
  onSettingsChange,
  onReferenceChange,
  onClearReference,
  onToggleInspector,
  onGenerate,
}: PromptComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const preSpecialSettings = useRef<Pick<StudioSettings, "width" | "height" | "steps" | "guidance" | "batchSize" | "device"> | null>(null);
  const [seedDraft, setSeedDraft] = useState(String(settings.seed));
  const [seedPopoverOpen, setSeedPopoverOpen] = useState(false);
  const seedPopover = useRef<HTMLDivElement>(null);
  useEffect(() => setSeedDraft(String(settings.seed)), [settings.seed]);
  useEffect(() => {
    if (!supportsReference && referenceImage) onClearReference();
  }, [onClearReference, referenceImage, supportsReference]);
  useEffect(() => {
    if (!seedPopoverOpen) return;
    const close = (event: PointerEvent) => {
      if (!seedPopover.current?.contains(event.target as Node))
        setSeedPopoverOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSeedPopoverOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [seedPopoverOpen]);
  const [loadingReference, setLoadingReference] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [referenceError, setReferenceError] = useState("");

  const loadReference = async (file: File | undefined) => {
    if (!file || !supportsReference || loadingReference) return;
    setReferenceError("");
    setLoadingReference(true);
    onReferenceBusy(true);
    try {
      const url = await readReference(file);
      onReferenceChange(url, file.name);
    } catch (error) {
      setReferenceError(
        error instanceof Error ? error.message : "Could not read that image.",
      );
    } finally {
      setLoadingReference(false);
      onReferenceBusy(false);
    }
  };

  return (
    <div className="composer-dock">
      <form
        className={`prompt-composer${dragging ? " is-dragging" : ""}`}
        aria-label="Create an image"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            ready &&
            settings.prompt.trim() &&
            !running &&
            !submitting &&
            !busyElsewhere
          )
            onGenerate();
        }}
        onDragOver={(event) => {
          if (!supportsReference || !event.dataTransfer.types.includes("Files"))
            return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          loadReference(event.dataTransfer.files[0]);
        }}
        onPaste={(event) => {
          if (supportsReference && event.clipboardData.files.length) {
            event.preventDefault();
            loadReference(event.clipboardData.files[0]);
          }
        }}
      >
        {referenceImage ? (
          <div className="composer-reference">
            <img
              src={referenceImage}
              alt="Reference for the next image"
              width={40}
              height={40}
            />
            <span>
              <strong>Reference image</strong>
              <small title={referenceLabel}>{referenceLabel}</small>
            </span>
            <button
              type="button"
              className="btn-icon btn-icon-sm"
              aria-label="Remove reference image"
              onClick={onClearReference}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <label className="sr-only" htmlFor="prompt">
          Image prompt
        </label>
        <textarea
          id="prompt"
          name="prompt"
          rows={3}
          value={settings.prompt}
          required
          autoComplete="off"
          spellCheck={true}
          placeholder={
            referenceImage
              ? "Describe how you want to change this image…"
              : "Describe an image. Make it yours."
          }
          onChange={(event) => onSettingsChange({ prompt: event.target.value })}
        />
        {loadingReference ? <p role="status">Loading reference…</p> : null}
        <div className="composer-toolbar">
          <div className="composer-options">
            {supportsReference ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  aria-label="Reference image file"
                  onChange={(event) => {
                    loadReference(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="composer-tool"
                  title="Add a reference image, or paste one into the prompt"
                  aria-label="Add reference image"
                  onClick={() => fileInput.current?.click()}
                >
                  <ImagePlus size={17} aria-hidden="true" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="composer-tool"
              onClick={onToggleInspector}
              aria-expanded={inspectorOpen}
              aria-controls="generation-inspector"
              title="Image settings"
              aria-label="Image settings"
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
            </button>
            <div className="seed-popover-anchor" ref={seedPopover}>
              <button
                type="button"
                className="composer-settings"
                aria-expanded={seedPopoverOpen}
                onClick={() => setSeedPopoverOpen((open) => !open)}
                title={`Seed settings · ${settings.seedLocked ? settings.seed : "Random"}`}
                aria-label="Seed settings"
              >
                <Dices size={17} aria-hidden="true" />
              </button>
              {seedPopoverOpen ? (
                <div
                  className="seed-popover"
                  role="dialog"
                  aria-label="Seed settings"
                >
                  <button
                    type="button"
                    className="seed-mode"
                    aria-pressed={settings.seedLocked}
                    onClick={() =>
                      onSettingsChange({ seedLocked: !settings.seedLocked })
                    }
                  >
                    {settings.seedLocked ? "Fixed seed" : "Random seed"}
                  </button>
                  <label className="seed-popover-input">
                    <span>Seed</span>
                    <input
                      aria-label="Seed"
                      inputMode="numeric"
                      type="text"
                      value={seedDraft}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSeedDraft(value);
                        if (
                          /^\d+$/.test(value) &&
                          Number.isSafeInteger(Number(value))
                        )
                          onSettingsChange({
                            seed: Number(value),
                            seedLocked: true,
                          });
                      }}
                      onBlur={() => setSeedDraft(String(settings.seed))}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-icon btn-icon-sm"
                    title="Randomize seed"
                    aria-label="Randomize seed"
                    onClick={() =>
                      onSettingsChange({
                        seed: Math.floor(Math.random() * 1_000_000_000),
                        seedLocked: true,
                      })
                    }
                  >
                    <Dices size={15} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="composer-send-tools">
            <ComposerModelMenu
              models={installedModels ?? []}
              loading={installedModels === undefined}
              value={settings.model ?? "9b"}
              disabled={running || submitting || busyElsewhere}
              onChange={(model) => {
                const isCustom = model.startsWith("custom-");
                const isSpecial = model === "qwen21-turbo" || model === "flux3-klein" || model === "tame-pony-v25-sdxl" || model === "tame-pony-v25-sdxl-int8" || isCustom;
                const currentIsSpecial = settings.model === "qwen21-turbo" || settings.model === "flux3-klein" || settings.model === "tame-pony-v25-sdxl" || settings.model === "tame-pony-v25-sdxl-int8" || settings.model?.startsWith("custom-");
                if (isSpecial) {
                  if (!currentIsSpecial && preSpecialSettings.current === null) {
                    preSpecialSettings.current = {
                      width: settings.width,
                      height: settings.height,
                      steps: settings.steps,
                      guidance: settings.guidance,
                      batchSize: settings.batchSize,
                      device: settings.device,
                    };
                  }
                  if (model === "qwen21-turbo") {
                    onSettingsChange({
                      model,
                      width: normalizeQwenDimension(settings.width),
                      height: normalizeQwenDimension(settings.height),
                      steps: 8,
                      guidance: 1,
                      batchSize: 1,
                      device: "AUTO",
                    });
                  } else if (model === "flux3-klein") {
                    onSettingsChange({
                      model,
                      width: 1024,
                      height: 1024,
                      steps: 16,
                      guidance: 0,
                      batchSize: 1,
                      device: "AUTO",
                    });
                    if (referenceImage) onClearReference();
                  } else if (isCustom) {
                    const customModel = installedModels?.find((candidate) => candidate.id === model);
                    onSettingsChange({
                      model,
                      width: customModel?.defaultWidth ?? 1024,
                      height: customModel?.defaultHeight ?? 1024,
                      steps: customModel?.defaultSteps ?? 30,
                      guidance: customModel?.defaultGuidance ?? 7,
                      batchSize: 1,
                      device: "AUTO",
                    });
                    if (referenceImage) onClearReference();
                  } else {
                    const selectedModel = installedModels?.find((candidate) => candidate.id === model);
                    onSettingsChange({
                      model,
                      width: selectedModel?.defaultWidth ?? 1024,
                      height: selectedModel?.defaultHeight ?? 1024,
                      steps: selectedModel?.defaultSteps ?? 30,
                      guidance: selectedModel?.defaultGuidance ?? 7,
                      batchSize: 1,
                      device: "AUTO",
                    });
                    if (referenceImage) onClearReference();
                  }
                  return;
                }
                const restore = settings.model === "qwen21-turbo" || settings.model === "flux3-klein" || settings.model === "tame-pony-v25-sdxl" || settings.model === "tame-pony-v25-sdxl-int8" || settings.model?.startsWith("custom-")
                  ? preSpecialSettings.current ?? { steps: 4, guidance: 1, batchSize: 1, device: "AUTO" }
                  : undefined;
                preSpecialSettings.current = null;
                onSettingsChange({ model, ...restore });
              }}
              onOpen={() => setSeedPopoverOpen(false)}
            />
            <button
              type="submit"
              className="composer-submit"
              disabled={
                running ||
                submitting ||
                !ready ||
                busyElsewhere ||
                !settings.prompt.trim()
              }
              aria-busy={running || submitting}
              aria-label={
                running
                  ? "Generation in progress"
                  : submitting
                    ? "Starting generation"
                    : "Generate image"
              }
              title="Generate image · Ctrl Enter"
            >
              {running || submitting ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <ArrowUp size={20} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </form>
      {referenceError ? (
        <p className="composer-error" role="alert">
          {referenceError}
        </p>
      ) : null}
      <div className="composer-caption">
        <span>
          {busyElsewhere
            ? "Another thread is rendering on this device"
            : running
              ? stopping
                ? "Stopping after the current step…"
                : "Rendering on your device"
              : "Your prompts and images stay on this device"}
        </span>
        {!running && !busyElsewhere ? (
          <span className="composer-keyboard-hint">Ctrl ↵ to generate</span>
        ) : null}
      </div>
    </div>
  );
}
