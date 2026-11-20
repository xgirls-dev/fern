import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ImageIcon from "lucide-react/dist/esm/icons/image.mjs";
import { Button, Input, Select, ToggleChip } from "./ui/controls";
import {
  useEffect,
  useState,
} from "react";
import type { ModelStatus, StudioSettings } from "../lib/types";

import { notify } from "../lib/notifications";
import { readReference, validateReference } from "../lib/reference";
import { ImageBatchField, ImageCanvasFields, ImageSamplingFields } from "./ImageGenerationFields";
import { fixedImagePreset, isKleinLoraModel, maxReferenceImages, selectedKleinLoras } from "../lib/imageModels";
import { ImageLoraFields } from "./ImageLoraFields";

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
  computeDevice: "GPU" | "CPU";
  referenceImage: string;
  referenceCount?: number;
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
  computeDevice,
  referenceImage,
  referenceCount = referenceImage ? 1 : 0,
  referenceLabel,
  onSettingsChange,
  onReferenceChange,
  onClearReference,
  onUseOutputAsReference,
  canUseOutput,
}: GenerationControlsProps) {
  const isLoraModel = isKleinLoraModel(settings.model);
  const loras = selectedKleinLoras(settings);
  const isQwenTurbo = settings.model === "qwen21-turbo";
  const isFlux3Klein = settings.model === "flux3-klein";
  const isCustomImage = settings.model?.startsWith("custom-") ?? false;
  const fixedPreset = fixedImagePreset(settings.model);
  const fixedSizes = fixedPreset?.sizes;
  const adjustableSteps = Boolean(fixedPreset?.maximumSteps);
  const hasFixedSampling = isQwenTurbo || isFlux3Klein || Boolean(fixedPreset);
  const hasFixedSteps = hasFixedSampling && !adjustableSteps;
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
      width: fixedSizes ? settings.width : isFlux3Klein ? 1024 : recipe.width,
      height: fixedSizes ? settings.height : isFlux3Klein ? 1024 : recipe.height,
      steps: hasFixedSteps ? fixedPreset?.steps ?? (isFlux3Klein ? 16 : 8) : recipe.steps,
      guidance: fixedPreset?.guidance ?? (hasFixedSampling ? (isFlux3Klein ? 0 : 1) : recipe.guidance),
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
  const requestedAdapter = computeDevice === "CPU"
    ? adapters.find((adapter) => adapter.id === "CPU")
    : adapters.find((adapter) => adapter.id === modelStatus?.selectedDevice);
  const deviceStatus = !requestedAdapter
    ? "Checking available devices…"
    : !requestedAdapter.available
      ? (requestedAdapter.note ?? `${requestedAdapter.label} is unavailable.`)
      : !requestedAdapter.runtimeReady
        ? (requestedAdapter.note ??
          `${requestedAdapter.label} is missing the model.`)
        : computeDevice === "CPU"
          ? "CPU is explicitly selected in Preferences."
          : `Fern will use the available ${requestedAdapter.label}.`;
  const deviceStatusClass =
    requestedAdapter?.available && requestedAdapter.runtimeReady
      ? "is-ready"
      : "";

  return (
    <section className="controls-panel" aria-label="Generation controls">
      <div className="inspector-controls">
        <div className="control-sections">
          {isLoraModel ? (
            <ControlSection title="LoRAs" summary={loras.length ? `${loras.filter((item) => item.enabled).length} of ${loras.length} active` : "Optional · up to 4"} defaultOpen>
              <ImageLoraFields loras={loras} error={errors.loras} onChange={(next) => onSettingsChange({ loras: next })} />
            </ControlSection>
          ) : null}
          <ControlSection
            title="Canvas & compute"
            summary={`${settings.width} × ${settings.height} | ${hasFixedSampling ? "1 image" : `${settings.batchSize} image${settings.batchSize === 1 ? "" : "s"}`}`}
            defaultOpen
          >
            {isLoraModel ? <p className="model-note field-note">Klein LoRA uses the Intel GPU and guidance 1.0. Attach up to four reference images.</p> : null}
            {hasFixedSampling ? (
              <p className="model-note field-note">
                {fixedPreset ? (window.studio.platform === "darwin" ? "Text to image at 512 × 512 on Apple GPU." : fixedSizes ? "Text to image on Intel GPU. Choose a validated canvas size." : "Text to image on Intel GPU. Larger canvases take longer and use more memory.") : isFlux3Klein
                  ? "FLUX.3 Klein uses 16 fixed steps and text-to-image only. GPU runs now use FP32 transformer inference; keep the canvas at 1024 × 1024 while output quality is rechecked."
                  : "Official Turbo runs 8 fixed steps and generates 1 image per request. Fern uses an available GPU automatically. This OpenVINO graph does not use the checkpoint’s KV cache, so it can be slower than CUDA Turbo. Larger canvases need more memory and take longer."}
              </p>
            ) : null}
            {isCustomImage ? <p className="model-note field-note">{modelStatus?.familyLabel ?? "Custom OpenVINO GenAI model"} · text-to-image only. Fern uses the selected family to apply safe canvas limits and recommended defaults.</p> : null}
            <ImageCanvasFields model={settings.model} settings={settings} modelStatus={modelStatus}
              errors={errors} onChange={onSettingsChange} />

            <div className="row-2">
              <ImageBatchField model={settings.model} value={settings.batchSize} onChange={(batchSize) => onSettingsChange({ batchSize })} />
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
                <Button
                  variant="ghost"
                  className="text-action"
                  onClick={() => setRecipeEditorOpen((open) => !open)}
                >
                  {recipeEditorOpen ? "Close" : "Save current"}
                </Button>
              </div>
              <div className="prompt-recipe-row">
                <Select
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
                </Select>
                {selectedRecipeId.startsWith("custom-") ? (
                  <Button
                    variant="secondary"
                    onClick={removeSelectedRecipe}
                    title="Remove this saved recipe"
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
              {recipeEditorOpen ? (
                <div className="prompt-recipe-save">
                  <Input
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
                  <Button
                    variant="primary"
                    disabled={!recipeName.trim() || !settings.prompt.trim()}
                    onClick={savePromptRecipe}
                  >
                    Save recipe
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="field">
              <div className="ui-chip-group" role="group" aria-label="Style modifiers">
                {STYLE_CHIPS.map((chip) => (
                  <ToggleChip
                    key={chip.id}
                    selected={activeChips.has(chip.id)}
                    onClick={() => toggleChip(chip.id, chip.suffix)}
                  >
                    {chip.id.charAt(0).toUpperCase() + chip.id.slice(1)}
                  </ToggleChip>
                ))}
              </div>
            </div>
          </ControlSection>

          {supportsReference ? (
            <ControlSection
              title="References"
              summary={referenceCount ? `${referenceCount} attached` : "Optional"}
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
                      ? `${referenceCount} reference${referenceCount === 1 ? "" : "s"} attached`
                      : "Add a reference image"}
                  </strong>
                  <span>
                    {referenceImage
                      ? referenceLabel
                      : "Drop an image here, or choose a file to guide the render."}
                  </span>
                </div>
                <Button
                  variant="secondary"
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
                  {referenceImage && maxReferenceImages(settings.model) > 1 ? "Add image" : referenceImage ? "Replace image" : "Choose image"}
                </Button>
              </div>
              <div className="meta-actions">
                <Button
                  variant="secondary"
                  onClick={onClearReference}
                >
                  Clear references
                </Button>
                <Button
                  variant="secondary"
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
                </Button>
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
            summary={hasFixedSteps
              ? fixedPreset
                ? `${fixedPreset.steps} steps · guidance ${fixedPreset.guidance} (fixed)`
                : isFlux3Klein ? "16 steps | no guidance (fixed)" : "8 steps | guidance 1.0 (fixed)"
              : `${settings.steps} steps | guidance ${settings.guidance}`}
          >
            <ImageSamplingFields model={settings.model} settings={settings} errors={errors} onChange={onSettingsChange} />
          </ControlSection>
        </div>
      </div>
    </section>
  );
}
