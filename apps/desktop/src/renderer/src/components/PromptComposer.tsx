import { ComposerModelMenu, type ComposerModel } from "./ComposerModelMenu";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import Dices from "lucide-react/dist/esm/icons/dices.mjs";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.mjs";
import { useEffect, useRef, useState } from "react";
import { normalizeQwenDimension } from "../lib/imageDimensions";
import { MAX_KLEIN_REFERENCES, readReference, type ReferenceAttachment } from "../lib/reference";
import type { StudioSettings } from "../lib/types";

interface PromptComposerProps {
  onReferenceBusy: (busy: boolean) => void;
  settings: StudioSettings;
  installedModels?: ComposerModel[];
  referenceImages: ReferenceAttachment[];
  running: boolean;
  busyElsewhere: boolean;
  submitting: boolean;
  stopping: boolean;
  ready: boolean;
  inspectorOpen: boolean;
  onSettingsChange: (patch: Partial<StudioSettings>) => void;
  onReferencesChange: (references: ReferenceAttachment[]) => void | Promise<void>;
  onToggleInspector: () => void;
  onGenerate: () => void;
}

export function PromptComposer({
  onReferenceBusy,
  settings,
  installedModels,
  referenceImages,
  running,
  busyElsewhere,
  submitting,
  stopping,
  ready,
  inspectorOpen,
  onSettingsChange,
  onReferencesChange,
  onToggleInspector,
  onGenerate,
}: PromptComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const preSpecialSettings = useRef<Pick<StudioSettings, "width" | "height" | "steps" | "guidance" | "batchSize" | "device"> | null>(null);
  const [seedDraft, setSeedDraft] = useState(String(settings.seed));
  const [seedPopoverOpen, setSeedPopoverOpen] = useState(false);
  const seedPopover = useRef<HTMLDivElement>(null);
  const referenceImage = referenceImages[0]?.dataUrl;
  const maxReferences = !settings.model || ["9b", "4b"].includes(settings.model) ? MAX_KLEIN_REFERENCES : settings.model === "qwen21-turbo" ? 1 : 0;
  const referencesInvalid = referenceImages.length > maxReferences;
  useEffect(() => setSeedDraft(String(settings.seed)), [settings.seed]);
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

  const loadReferences = async (files: File[]) => {
    if (!files.length || !maxReferences || loadingReference) return;
    setReferenceError("");
    if (files.length + referenceImages.length > maxReferences) {
      setReferenceError(`This model accepts up to ${maxReferences} reference image${maxReferences === 1 ? "" : "s"}. Remove an attachment before adding more.`);
      return;
    }
    setLoadingReference(true);
    onReferenceBusy(true);
    try {
      const added = await Promise.all(files.map(async (file) => ({ dataUrl: await readReference(file), label: file.name })));
      await onReferencesChange([...referenceImages, ...added]);
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
            !busyElsewhere && !referencesInvalid && !loadingReference
          )
            onGenerate();
        }}
        onDragOver={(event) => {
          if (!maxReferences || !event.dataTransfer.types.includes("Files"))
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
          void loadReferences(Array.from(event.dataTransfer.files));
        }}
        onPaste={(event) => {
          if (maxReferences && event.clipboardData.files.length) {
            event.preventDefault();
            void loadReferences(Array.from(event.clipboardData.files));
          }
        }}
      >
        {referenceImages.length ? <div className="composer-references" aria-label="Reference images">
          {referenceImages.map((reference, index) => <div className="composer-reference" key={`${index}-${reference.label}`}>
            <img
              src={reference.dataUrl}
              alt={`Reference ${index + 1}`}
              width={40}
              height={40}
            />
            <span>
              <strong>Image {index + 1}</strong>
              <small title={reference.label}>{reference.label}</small>
            </span>
            {referenceImages.length > 1 ? <div className="composer-reference-order">
              <button type="button" className="btn-icon btn-icon-sm" disabled={index === 0 || loadingReference} aria-label={`Move reference ${index + 1} earlier`} title="Move earlier" onClick={() => { const next = [...referenceImages]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onReferencesChange(next); }}><ArrowLeft size={12} aria-hidden="true" /></button>
              <button type="button" className="btn-icon btn-icon-sm" disabled={index === referenceImages.length - 1 || loadingReference} aria-label={`Move reference ${index + 1} later`} title="Move later" onClick={() => { const next = [...referenceImages]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; onReferencesChange(next); }}><ArrowRight size={12} aria-hidden="true" /></button>
            </div> : null}
            <button
              type="button"
              className="btn-icon btn-icon-sm"
              aria-label={`Remove reference ${index + 1}`}
              title="Remove reference"
              disabled={loadingReference}
              onClick={() => onReferencesChange(referenceImages.filter((_, itemIndex) => index !== itemIndex))}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>)}
          {maxReferences > 1 ? <p className="composer-reference-hint">{referenceImages.length}/{maxReferences} references · Refer to Image 1, Image 2, etc. in your prompt.</p> : null}
        </div> : null}
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
              ? referenceImages.length > 1 ? "Describe how to combine or edit these images…" : "Describe how you want to change this image…"
              : "Describe an image. Make it yours."
          }
          onChange={(event) => onSettingsChange({ prompt: event.target.value })}
        />
        {loadingReference ? <p role="status">Loading reference…</p> : null}
        <div className="composer-toolbar">
          <div className="composer-options">
            {maxReferences ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple={maxReferences > 1}
                  hidden
                  aria-label="Reference image file"
                  onChange={(event) => {
                    void loadReferences(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="composer-tool"
                  title={`Add reference images (${referenceImages.length}/${maxReferences})`}
                  aria-label="Add reference image"
                  disabled={loadingReference || referenceImages.length >= maxReferences}
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
              disabled={running || submitting || busyElsewhere || loadingReference}
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
                referencesInvalid || loadingReference ||
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
      {referencesInvalid ? <p className="composer-error" role="alert">{maxReferences ? `This model supports ${maxReferences} reference image. Remove extra attachments or switch to Klein.` : "This model generates from text only. Remove the references or select Klein to edit them."}</p> : null}
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
