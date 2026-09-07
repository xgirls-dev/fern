import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import Dices from "lucide-react/dist/esm/icons/dices.mjs";
import ImageIcon from "lucide-react/dist/esm/icons/image.mjs";
import Lock from "lucide-react/dist/esm/icons/lock.mjs";
import LockOpen from "lucide-react/dist/esm/icons/lock-open.mjs";
import Shuffle from "lucide-react/dist/esm/icons/shuffle.mjs";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import type { ModelStatus, StudioSettings } from "../lib/types";

import { notify } from "../lib/notifications";
import { readReference, validateReference } from "../lib/reference";

const STYLE_CHIPS = [
  {
    id: "photoreal",
    suffix: "photorealistic, ultra-detailed, 50mm lens, natural lighting",
  },
  {
    id: "cinematic",
    suffix: "cinematic lighting, film grain, dramatic, anamorphic",
  },
  { id: "anime", suffix: "anime style, cel shading, vibrant colors" },
  {
    id: "render",
    suffix: "3D render, octane, ray tracing, subsurface scattering",
  },
  {
    id: "portrait",
    suffix: "studio portrait, soft light, shallow depth of field",
  },
  { id: "minimal", suffix: "minimalist, clean composition, negative space" },
];

const SIZE_PRESETS = [
  { value: "720x1280", label: "720 × 1280 · Portrait 9:16" },
  { value: "1280x720", label: "1280 × 720 · Landscape 16:9" },
  { value: "1920x1088", label: "1920 × 1088 · Wide" },
  { value: "1088x1920", label: "1088 × 1920 · Tall" },
  { value: "1024x1024", label: "1024 x 1024 (1:1)" },
  { value: "832x1216", label: "832 x 1216 (Portrait)" },
  { value: "896x1152", label: "896 x 1152 (Portrait)" },
  { value: "1216x832", label: "1216 x 832 (Landscape)" },
  { value: "1152x896", label: "1152 x 896 (Landscape)" },
  { value: "1024x768", label: "1024 x 768 (4:3)" },
  { value: "768x1024", label: "768 x 1024 (3:4)" },
  { value: "1024x576", label: "1024 x 576 (16:9)" },
  { value: "576x1024", label: "576 x 1024 (9:16)" },
  { value: "768x768", label: "768 x 768 (1:1)" },
  { value: "custom", label: "Custom" },
];

interface PromptRecipe {
  id: string;
  name: string;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  builtIn?: boolean;
}

const PROMPT_RECIPES_KEY = "fern-prompt-recipes";
const DEFAULT_PROMPT_RECIPES: PromptRecipe[] = [
  {
    id: "editorial-portrait",
    name: "Editorial portrait",
    prompt:
      "A considered editorial portrait with a distinctive subject, sculpted soft light, refined styling, and a quiet studio background",
    width: 832,
    height: 1216,
    steps: 4,
    guidance: 0,
    builtIn: true,
  },
  {
    id: "product-study",
    name: "Product study",
    prompt:
      "A premium product still life, centered hero object, subtle material detail, controlled studio lighting, clean background, commercial photography",
    width: 1024,
    height: 1024,
    steps: 4,
    guidance: 0,
    builtIn: true,
  },
  {
    id: "cinematic-landscape",
    name: "Cinematic landscape",
    prompt:
      "A cinematic wide landscape with a strong foreground, atmospheric depth, natural textures, late afternoon light, and an intentional sense of scale",
    width: 1216,
    height: 832,
    steps: 4,
    guidance: 0,
    builtIn: true,
  },
  {
    id: "character-concept",
    name: "Character concept",
    prompt:
      "A fully realized character concept sheet, distinctive silhouette, expressive face, functional clothing, material details, neutral presentation background",
    width: 832,
    height: 1216,
    steps: 4,
    guidance: 0,
    builtIn: true,
  },
];

interface GenerationControlsProps {
  errors?: Record<string, string>;
  onReferenceBusy: (busy: boolean) => void;
  settings: StudioSettings;
  modelStatus: ModelStatus | null;
  referenceImage: string;
  referenceLabel: string;
  onSettingsChange: (patch: Partial<StudioSettings>) => void;
  onReferenceChange: (dataUrl: string, label: string) => void;
  onClearReference: () => void;
  onUseOutputAsReference: () => Promise<void>;
  canUseOutput: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPromptRecipe(value: unknown): value is PromptRecipe {
  if (!value || typeof value !== "object") return false;
  const recipe = value as Partial<PromptRecipe>;
  return (
    typeof recipe.id === "string" &&
    typeof recipe.name === "string" &&
    typeof recipe.prompt === "string" &&
    typeof recipe.width === "number" &&
    typeof recipe.height === "number" &&
    typeof recipe.steps === "number" &&
    typeof recipe.guidance === "number"
  );
}

function readPromptRecipes(): PromptRecipe[] {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PROMPT_RECIPES_KEY) ?? "[]",
    ) as unknown;
    const customRecipes = Array.isArray(stored)
      ? stored
          .filter(isPromptRecipe)
          .map((recipe) => ({ ...recipe, builtIn: false }))
      : [];
    return [...DEFAULT_PROMPT_RECIPES, ...customRecipes];
  } catch {
    return DEFAULT_PROMPT_RECIPES;
  }
}

function ControlSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  return (
    <details
      className="control-section"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{summary}</small>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="control-section-body">{children}</div>
    </details>
  );
}

export function GenerationControls({
  errors = {},
  onReferenceBusy,
  settings,
  modelStatus,
  referenceImage,
  referenceLabel,
  onSettingsChange,
  onReferenceChange,
  onClearReference,
  onUseOutputAsReference,
  canUseOutput,
}: GenerationControlsProps) {
  const [customSize, setCustomSize] = useState(false);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const activeChips = new Set(
    STYLE_CHIPS.filter((chip) => settings.prompt.includes(chip.suffix)).map(
      (chip) => chip.id,
    ),
  );
  const [referenceDragActive, setReferenceDragActive] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [promptRecipes, setPromptRecipes] =
    useState<PromptRecipe[]>(readPromptRecipes);
  const [selectedRecipeId, setSelectedRecipeId] = useState("");
  const [recipeName, setRecipeName] = useState("");
  const [recipeEditorOpen, setRecipeEditorOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(
        PROMPT_RECIPES_KEY,
        JSON.stringify(promptRecipes.filter((recipe) => !recipe.builtIn)),
      );
    } catch {
      // Recipes are a convenience and should never block generation.
    }
  }, [promptRecipes]);

  useEffect(() => {
    const reload = () => setPromptRecipes(readPromptRecipes());
    window.addEventListener("fern-recipes-updated", reload);
    return () => window.removeEventListener("fern-recipes-updated", reload);
  }, []);

  const sizePreset = useMemo(() => {
    const value = `${settings.width}x${settings.height}`;
    return SIZE_PRESETS.some((preset) => preset.value === value)
      ? value
      : "custom";
  }, [settings.height, settings.width]);

  const applySizePreset = (value: string) => {
    setCustomSize(value === "custom");
    if (value === "custom") {
      document.getElementById("width")?.focus();
      return;
    }
    const [width, height] = value.split("x").map(Number);
    if (width && height) onSettingsChange({ width, height });
  };

  const swapDimensions = () => {
    onSettingsChange({ width: settings.height, height: settings.width });
  };

  const toggleChip = (id: string, suffix: string) => {
    const next = new Set(activeChips);
    let prompt = settings.prompt;
    if (next.has(id)) {
      next.delete(id);
      prompt = prompt
        .replace(new RegExp(`,?\\s*${escapeRegExp(suffix)}`, "g"), "")
        .replace(/^,\s*/, "")
        .trim();
    } else {
      next.add(id);
      prompt = prompt.trim() ? `${prompt.trim()}, ${suffix}` : suffix;
    }
    onSettingsChange({ prompt });
  };

  const applyPromptRecipe = (id: string) => {
    setSelectedRecipeId(id);
    if (!id) return;
    const recipe = promptRecipes.find((candidate) => candidate.id === id);
    if (!recipe) return;
    const previous = {
      prompt: settings.prompt,
      width: settings.width,
      height: settings.height,
      steps: settings.steps,
      guidance: settings.guidance,
    };
    notify("Recipe applied.", "info", {
      label: "Undo",
      run: () => {
        onSettingsChange(previous);
        setSelectedRecipeId("");
      },
    });
    onSettingsChange({
      prompt: recipe.prompt,
      width: recipe.width,
      height: recipe.height,
      steps: recipe.steps,
      guidance: recipe.guidance,
    });
  };

  const savePromptRecipe = () => {
    const name = recipeName.trim();
    const prompt = settings.prompt.trim();
    if (!name || !prompt) return;
    const recipe: PromptRecipe = {
      id: `custom-${Date.now()}`,
      name,
      prompt,
      width: settings.width,
      height: settings.height,
      steps: settings.steps,
      guidance: settings.guidance,
    };
    setPromptRecipes((current) => [...current, recipe]);
    setSelectedRecipeId(recipe.id);
    setRecipeName("");
    setRecipeEditorOpen(false);
  };

  const removeSelectedRecipe = () => {
    if (!selectedRecipeId.startsWith("custom-")) return;
    const removed = promptRecipes.find(
      (recipe) => recipe.id === selectedRecipeId,
    );
    setPromptRecipes((current) =>
      current.filter((recipe) => recipe.id !== selectedRecipeId),
    );
    if (removed)
      notify("Recipe removed.", "info", {
        label: "Undo",
        run: () => {
          const current = readPromptRecipes();
          const restored = current.some((recipe) => recipe.id === removed.id)
            ? current
            : [...current, removed];
          localStorage.setItem(
            PROMPT_RECIPES_KEY,
            JSON.stringify(restored.filter((recipe) => !recipe.builtIn)),
          );
          window.dispatchEvent(new Event("fern-recipes-updated"));
        },
      });
    setSelectedRecipeId("");
  };

  const loadReference = async (filePath: string | null) => {
    if (!filePath) return;
    const dataUrl = await window.studio.readFileAsDataUrl(filePath);
    await validateReference(dataUrl);
    const name = filePath.split(/[\\/]/).pop() ?? "reference";
    onReferenceChange(dataUrl, `${name} loaded for image-to-image.`);
  };

  const pickReference = async () => {
    try {
      setReferenceError("");
      await loadReference(await window.studio.pickReferenceImage());
    } catch (error) {
      setReferenceError(
        error instanceof Error ? error.message : "Could not read that image.",
      );
    }
  };

  const onReferenceDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setReferenceDragActive(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    setReferenceBusy(true);
    onReferenceBusy(true);
    setReferenceError("");
    try {
      const url = await readReference(file);
      onReferenceChange(url, file.name);
    } catch (error) {
      setReferenceError(
        error instanceof Error ? error.message : "Could not read that image.",
      );
    } finally {
      setReferenceBusy(false);
      onReferenceBusy(false);
    }
  };

  const supportsReference = modelStatus?.supportsReferenceImage ?? true;
  const adapters = modelStatus?.adapters ?? [];
  const requestedAdapter =
    settings.device === "AUTO"
      ? adapters.find((adapter) => adapter.id === modelStatus?.selectedDevice)
      : adapters.find((adapter) => adapter.id === settings.device);
  const deviceStatus = !requestedAdapter
    ? "Checking available devices…"
    : !requestedAdapter.available
      ? (requestedAdapter.note ?? `${requestedAdapter.label} is unavailable.`)
      : !requestedAdapter.runtimeReady
        ? (requestedAdapter.note ??
          `${requestedAdapter.label} is missing the model.`)
        : settings.device === "AUTO"
          ? `Auto-select will use ${requestedAdapter.label}.`
          : `${requestedAdapter.label} is ready.`;
  const deviceStatusClass =
    requestedAdapter?.available && requestedAdapter.runtimeReady
      ? "is-ready"
      : "";

  return (
    <section className="controls-panel" aria-label="Generation controls">
      <div className="inspector-controls">
        <div className="control-sections">
          <ControlSection
            title="Canvas & device"
            summary={`${settings.width} x ${settings.height} | ${settings.batchSize} image${settings.batchSize === 1 ? "" : "s"}`}
            defaultOpen
          >
            <div className="field">
              <div className="field-header">
                <label htmlFor="size-preset">Resolution</label>
              </div>
              <select
                id="size-preset"
                name="size-preset"
                value={customSize ? "custom" : sizePreset}
                onChange={(event) => applySizePreset(event.target.value)}
              >
                {SIZE_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="dims-row">
              <div className="field">
                <label htmlFor="width">Width</label>
                <DraftNumberInput
                  error={errors.width}
                  id="width"
                  name="width"
                  type="number"
                  min={256}
                  max={1920}
                  step={16}
                  value={settings.width}
                  onChange={(event) =>
                    onSettingsChange({ width: Number(event.target.value) })
                  }
                />
              </div>
              <button
                type="button"
                className="btn-icon btn-icon-sm"
                onClick={swapDimensions}
                title="Swap dimensions"
                aria-label="Swap width and height"
              >
                <Shuffle size={15} aria-hidden="true" />
              </button>
              <div className="field">
                <label htmlFor="height">Height</label>
                <DraftNumberInput
                  error={errors.height}
                  id="height"
                  name="height"
                  type="number"
                  min={256}
                  max={1920}
                  step={16}
                  value={settings.height}
                  onChange={(event) =>
                    onSettingsChange({ height: Number(event.target.value) })
                  }
                />
              </div>
            </div>

            <div className="row-2">
              <div className="field">
                <label htmlFor="device">Device</label>
                <select
                  id="device"
                  name="device"
                  value={settings.device}
                  onChange={(event) =>
                    onSettingsChange({
                      device: event.target.value as StudioSettings["device"],
                    })
                  }
                >
                  <option value="AUTO">Auto-select</option>
                  {adapters.map((adapter) => (
                    <option
                      key={adapter.id}
                      value={adapter.id}
                      disabled={!adapter.available}
                    >
                      {adapter.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="batch-size">Images per render</label>
                <select
                  id="batch-size"
                  name="batch-size"
                  value={settings.batchSize}
                  onChange={(event) =>
                    onSettingsChange({ batchSize: Number(event.target.value) })
                  }
                >
                  <option value={1}>1 image</option>
                  <option value={2}>2 images</option>
                  <option value={3}>3 images</option>
                  <option value={4}>4 images</option>
                </select>
              </div>
            </div>
            <p
              className={`device-status-note ${deviceStatusClass}`}
              role="status"
            >
              <span className="device-status-dot" aria-hidden="true" />
              <span>{deviceStatus}</span>
            </p>
          </ControlSection>

          <ControlSection
            title="Style & recipes"
            summary={
              selectedRecipeId
                ? promptRecipes.some(
                    (recipe) =>
                      recipe.id === selectedRecipeId &&
                      recipe.prompt === settings.prompt &&
                      recipe.width === settings.width &&
                      recipe.height === settings.height &&
                      recipe.steps === settings.steps &&
                      recipe.guidance === settings.guidance,
                  )
                  ? "Recipe applied"
                  : "Modified"
                : "Optional"
            }
          >
            <div className="prompt-tools">
              <div className="prompt-tools-header">
                <div>
                  <strong>Prompt recipes</strong>
                  <small>
                    Save a prompt, size, steps, and guidance for later.
                  </small>
                </div>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => setRecipeEditorOpen((open) => !open)}
                >
                  {recipeEditorOpen ? "Close" : "Save current"}
                </button>
              </div>
              <div className="prompt-recipe-row">
                <select
                  aria-label="Prompt recipe"
                  value={selectedRecipeId}
                  onChange={(event) => applyPromptRecipe(event.target.value)}
                >
                  <option value="">Choose a starting point…</option>
                  {promptRecipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>
                      {recipe.name}
                      {recipe.builtIn ? " · Fern" : " · Saved"}
                    </option>
                  ))}
                </select>
                {selectedRecipeId.startsWith("custom-") ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-compact"
                    onClick={removeSelectedRecipe}
                    title="Remove this saved recipe"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              {recipeEditorOpen ? (
                <div className="prompt-recipe-save">
                  <input
                    value={recipeName}
                    placeholder="Name this recipe"
                    aria-label="Recipe name"
                    maxLength={48}
                    onChange={(event) => setRecipeName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        savePromptRecipe();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-compact"
                    disabled={!recipeName.trim() || !settings.prompt.trim()}
                    onClick={savePromptRecipe}
                  >
                    Save recipe
                  </button>
                </div>
              ) : null}
            </div>
            <div className="field">
              <div className="chips" aria-label="Style modifiers">
                {STYLE_CHIPS.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    className={`chip ${activeChips.has(chip.id) ? "active" : ""}`}
                    aria-pressed={activeChips.has(chip.id)}
                    onClick={() => toggleChip(chip.id, chip.suffix)}
                  >
                    {chip.id.charAt(0).toUpperCase() + chip.id.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </ControlSection>

          {supportsReference ? (
            <ControlSection
              title="Reference Image"
              summary={referenceImage ? "Image loaded" : "Optional"}
              defaultOpen={Boolean(referenceImage)}
            >
              <div
                className={`dropzone ${referenceImage ? "has-image" : ""}${referenceDragActive ? " is-dragging" : ""}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setReferenceDragActive(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (event.currentTarget === event.target)
                    setReferenceDragActive(false);
                }}
                onDrop={(event) => void onReferenceDrop(event)}
              >
                {referenceImage ? (
                  <img
                    src={referenceImage}
                    alt="Selected reference"
                    width={44}
                    height={44}
                    className="ref-preview"
                  />
                ) : (
                  <ImageIcon
                    size={20}
                    color="var(--muted-2)"
                    aria-hidden="true"
                  />
                )}
                <div className="dropzone-copy">
                  <strong>
                    {referenceImage
                      ? "Reference loaded"
                      : "Add a reference image"}
                  </strong>
                  <span>
                    {referenceImage
                      ? referenceLabel
                      : "Drop an image here, or choose a file to guide the render."}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={referenceBusy}
                  onClick={() => {
                    setReferenceBusy(true);
                    onReferenceBusy(true);
                    void pickReference().finally(() => {
                      setReferenceBusy(false);
                      onReferenceBusy(false);
                    });
                  }}
                >
                  {referenceImage ? "Replace image" : "Choose image"}
                </button>
              </div>
              <div className="meta-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onClearReference}
                >
                  Clear Image
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!canUseOutput || referenceBusy}
                  onClick={() => {
                    setReferenceError("");
                    setReferenceBusy(true);
                    onReferenceBusy(true);
                    void onUseOutputAsReference()
                      .catch((error) =>
                        setReferenceError(
                          error instanceof Error
                            ? error.message
                            : "Could not attach the output.",
                        ),
                      )
                      .finally(() => {
                        setReferenceBusy(false);
                        onReferenceBusy(false);
                      });
                  }}
                >
                  {referenceBusy ? "Loading reference…" : "Use current output"}
                </button>
              </div>
              <p className="model-note field-note">{referenceLabel}</p>
              {referenceError ? (
                <p className="composer-error" role="alert">
                  {referenceError}
                </p>
              ) : null}
            </ControlSection>
          ) : null}

          <ControlSection
            title="Advanced"
            summary={`${settings.steps} steps | guidance ${settings.guidance}`}
          >
            <div className="field">
              <label htmlFor="seed">Seed</label>
              <div className="seed-row">
                <DraftNumberInput
                  error={errors.seed}
                  id="seed"
                  name="seed"
                  type="number"
                  value={settings.seed}
                  onChange={(event) =>
                    onSettingsChange({ seed: Number(event.target.value) })
                  }
                />
                <button
                  type="button"
                  className="btn-icon btn-icon-sm"
                  title="Randomize seed"
                  aria-label="Randomize seed"
                  onClick={() =>
                    onSettingsChange({
                      seed: Math.floor(Math.random() * 1_000_000_000),
                    })
                  }
                >
                  <Dices size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn-icon btn-icon-sm"
                  title={settings.seedLocked ? "Unlock seed" : "Lock seed"}
                  aria-label={settings.seedLocked ? "Unlock seed" : "Lock seed"}
                  aria-pressed={settings.seedLocked}
                  onClick={() =>
                    onSettingsChange({ seedLocked: !settings.seedLocked })
                  }
                >
                  {settings.seedLocked ? (
                    <Lock size={15} aria-hidden="true" />
                  ) : (
                    <LockOpen size={15} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="steps">Steps</label>
              <div className="range-pair">
                <input
                  id="steps"
                  aria-invalid={Boolean(errors.steps)}
                  aria-describedby={
                    errors.steps ? "step-count-error" : undefined
                  }
                  name="steps"
                  type="range"
                  min={1}
                  max={50}
                  step={1}
                  value={settings.steps}
                  onChange={(event) =>
                    onSettingsChange({ steps: Number(event.target.value) })
                  }
                />
                <DraftNumberInput
                  error={errors.steps}
                  className="compact-input"
                  aria-label="Step count"
                  name="step-count"
                  type="number"
                  min={1}
                  max={50}
                  value={settings.steps}
                  onChange={(event) =>
                    onSettingsChange({ steps: Number(event.target.value) })
                  }
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="guidance">Guidance</label>
              <div className="range-pair">
                <input
                  id="guidance"
                  aria-invalid={Boolean(errors.guidance)}
                  aria-describedby={
                    errors.guidance ? "guidance-value-error" : undefined
                  }
                  name="guidance"
                  type="range"
                  min={0}
                  max={10}
                  step={0.1}
                  value={settings.guidance}
                  onChange={(event) =>
                    onSettingsChange({ guidance: Number(event.target.value) })
                  }
                />
                <DraftNumberInput
                  error={errors.guidance}
                  className="compact-input"
                  aria-label="Guidance value"
                  name="guidance-value"
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  value={settings.guidance}
                  onChange={(event) =>
                    onSettingsChange({ guidance: Number(event.target.value) })
                  }
                />
              </div>
            </div>
          </ControlSection>
        </div>
      </div>
    </section>
  );
}

function DraftNumberInput({
  error,
  ...props
}: ComponentProps<"input"> & { error?: string }) {
  const [draft, setDraft] = useState(String(props.value ?? ""));
  const focused = useRef(false);
  const lastEdit = useRef(props.value);
  useEffect(() => {
    if (!focused.current || props.value !== lastEdit.current)
      setDraft(String(props.value ?? ""));
  }, [props.value]);
  const errorId = `${props.id ?? props.name}-error`;
  return (
    <>
      <input
        {...props}
        value={draft}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
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
        }}
      />
      {error ? (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
