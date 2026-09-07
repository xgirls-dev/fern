import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useRef, useState } from "react";
import { readReference } from "../lib/reference";
import type { StudioSettings } from "../lib/types";

interface PromptComposerProps {
  onReferenceBusy: (busy: boolean) => void;
  settings: StudioSettings;
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
              className="composer-settings"
              onClick={onToggleInspector}
              aria-expanded={inspectorOpen}
              aria-controls="generation-inspector"
              title="Image settings"
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>
                {settings.width} × {settings.height}
              </span>
            </button>
            <button
              type="button"
              className="composer-settings"
              aria-pressed={settings.seedLocked}
              onClick={() =>
                onSettingsChange({ seedLocked: !settings.seedLocked })
              }
              title={
                settings.seedLocked
                  ? `Fixed seed: ${settings.seed}. Repeat renders preserve this seed.`
                  : "A new random seed for each render"
              }
            >
              {settings.seedLocked ? "Fixed seed" : "Random seed"}
            </button>
            <label className="composer-batch">
              <span className="sr-only">Number of images</span>
              <select
                value={settings.batchSize}
                onChange={(event) =>
                  onSettingsChange({ batchSize: Number(event.target.value) })
                }
              >
                {[1, 2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count} {count === 1 ? "image" : "images"}
                  </option>
                ))}
              </select>
            </label>
          </div>

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
