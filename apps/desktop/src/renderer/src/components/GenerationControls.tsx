import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ImageIcon from "lucide-react/dist/esm/icons/image.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Button, Checkbox, IconButton, Input, Select, ToggleChip } from "./ui/controls";
import {
  useEffect,
  useState,
} from "react";
import type { ModelStatus, StudioSettings } from "../lib/types";

import { notify } from "../lib/notifications";
import { readReference, validateReference } from "../lib/reference";
import { ImageCanvasFields, ImageSamplingFields } from "./ImageGenerationFields";
import { fixedImagePreset, isKleinLoraModel, maxReferenceImages, selectedKleinLoras } from "../lib/imageModels";
import { getApiBaseUrl } from "../lib/api";

function loraDisplayName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const filename = parts.at(-1)?.replace(/\.safetensors$/i, "").replace(/^[a-f0-9]{12}-/, "") ?? path;
  return /^(pytorch_lora_weights|adapter_model)$/i.test(filename) && parts.length > 1 && parts[parts.length - 2].toLowerCase() !== "loras"
    ? parts[parts.length - 2]
    : filename;
}

function downloadedLoraLabel(url: string, path: string): string {
  const fallback = loraDisplayName(path);
  if (!/^(pytorch_lora_weights|adapter_model)$/i.test(fallback)) return fallback;
  try {
    const source = new URL(url);
    const parts = source.pathname.split("/").filter(Boolean);
    if (source.hostname.endsWith("huggingface.co") && parts.length >= 5) {
      return decodeURIComponent(parts.length > 5 ? parts[parts.length - 2] : parts[1]);
    }
  } catch { /* Use the filename when the source link is unavailable. */ }
  return fallback;
}

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
  const [loraError, setLoraError] = useState("");
  const [loraUrl, setLoraUrl] = useState("");
  const [loraDownload, setLoraDownload] = useState<{ status: string; name?: string; path?: string; downloaded?: number; bytes?: number; error?: string }>({ status: "idle" });
  const [startingLoraDownload, setStartingLoraDownload] = useState(false);
  const [loraDownloadOpen, setLoraDownloadOpen] = useState(false);
  const isLoraModel = isKleinLoraModel(settings.model);
  const loras = selectedKleinLoras(settings);
  useEffect(() => {
    if (!isLoraModel || !loraDownloadOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/loras/download`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error("Could not check the LoRA download.");
        const state = await response.json();
        if (!cancelled) { setLoraDownload(state); if (["checking", "downloading"].includes(state.status)) timer = setTimeout(poll, 1200); }
      } catch (error) { if (!cancelled) setLoraError(error instanceof Error ? error.message : "Could not check the LoRA download."); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isLoraModel, loraDownloadOpen, startingLoraDownload]);
  const downloadLora = async (cancel = false) => {
    setStartingLoraDownload(true); setLoraError("");
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/loras/download${cancel ? "/cancel" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cancel ? {} : { url: loraUrl }) });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || "Could not download the LoRA.");
      setLoraDownload(state);
    } catch (error) { setLoraError(error instanceof Error ? error.message : "Could not download the LoRA."); }
    finally { setStartingLoraDownload(false); }
  };
  const addLoras = async () => {
    try {
      const paths = await window.studio.pickLoraFiles();
      const existing = new Set(loras.map((item) => item.path.toLowerCase()));
      const next = [...loras];
      for (const path of paths) {
        if (existing.has(path.toLowerCase())) continue;
        if (next.length >= 4) { setLoraError("Choose up to four LoRAs."); break; }
        existing.add(path.toLowerCase());
        next.push({ path, strength: 1, enabled: true });
      }
      if (next.length <= 4 && paths.length <= 4 - loras.length) setLoraError("");
      onSettingsChange({ loras: next });
    } catch (error) {
      setLoraError(error instanceof Error ? error.message : "Could not open the file picker.");
    }
  };
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
              <p className="lora-intro">Add local LoRAs to guide your image. Include their trigger words in your prompt.</p>
              {loras.length ? <div className="lora-list-heading" aria-hidden="true"><span>LoRA</span><span>Strength</span><span /></div> : null}
              {loras.map((lora, index) => (
                <div className={`lora-control${lora.enabled ? "" : " is-disabled"}`} key={lora.path}>
                  <div className="lora-control-heading">
                    <label className="lora-control-name" title={lora.path}>
                      <Checkbox checked={lora.enabled} aria-label={lora.path.split(/[\\/]/).pop()} onChange={(event) => onSettingsChange({ loras: loras.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item) })} />
                      <span>{lora.label || loraDisplayName(lora.path)}</span>
                    </label>
                    <label className="lora-control-strength"><span className="sr-only">Strength</span>
                      <Input type="number" min={-4} max={4} step={0.1} value={lora.strength} title="LoRA strength" aria-label={`Strength for ${lora.path.split(/[\\/]/).pop()}`} onChange={(event) => onSettingsChange({ loras: loras.map((item, i) => i === index ? { ...item, strength: Number(event.target.value) } : item) })} />
                    </label>
                    <IconButton onClick={() => onSettingsChange({ loras: loras.filter((_, i) => i !== index) })} aria-label={`Remove ${lora.path.split(/[\\/]/).pop()}`} title="Remove LoRA"><X size={15} aria-hidden="true" /></IconButton>
                  </div>
                </div>
              ))}
              <Button variant="ghost" className="lora-add" disabled={loras.length >= 4} onClick={() => void addLoras()}><Plus size={15} aria-hidden="true" /> Add LoRA files</Button>
              <details className="lora-download" onToggle={(event) => setLoraDownloadOpen(event.currentTarget.open)}><summary>Download from a link</summary><div className="lora-download-content">
                <label htmlFor="lora-download-url">Hugging Face or Civitai link</label>
                <Input id="lora-download-url" type="url" placeholder="https://…" value={loraUrl} onChange={(event) => setLoraUrl(event.target.value)} disabled={startingLoraDownload || ["checking", "downloading"].includes(loraDownload.status)} />
                {["checking", "downloading"].includes(loraDownload.status) ? <><p role="status">{loraDownload.status === "checking" ? "Checking link…" : `Downloading ${loraDownload.name ?? "LoRA"}…`}</p><progress aria-label="LoRA download" {...(loraDownload.bytes ? { value: loraDownload.downloaded ?? 0, max: loraDownload.bytes } : {})} /><Button onClick={() => void downloadLora(true)} disabled={startingLoraDownload}>Cancel download</Button></> : <Button disabled={!loraUrl.trim() || startingLoraDownload || loras.length >= 4} onClick={() => void downloadLora()}>Download LoRA</Button>}
                {loraDownload.status === "complete" && loraDownload.path ? <div className="lora-downloaded"><span title={loraDownload.name}>{loraDownload.name} downloaded</span><Button disabled={loras.length >= 4 || loras.some((item) => item.path.toLowerCase() === loraDownload.path!.toLowerCase())} onClick={() => onSettingsChange({ loras: [...loras, { path: loraDownload.path!, strength: 1, enabled: true, label: downloadedLoraLabel(loraUrl, loraDownload.path!) }] })}>Add to thread</Button></div> : null}
                {loraDownload.status === "failed" ? <p role="alert" className="field-error">{loraDownload.error || "Download failed."}</p> : null}
              </div></details>
              {loraError || errors.loras ? <p role="alert" className="field-error">{loraError || errors.loras}</p> : null}
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
              <div className="field">
                <label htmlFor="batch-size">Images per render</label>
                <Select
                  id="batch-size"
                  name="batch-size"
                  value={hasFixedSampling ? 1 : settings.batchSize}
                  disabled={hasFixedSampling}
                  onChange={(event) =>
                    onSettingsChange({ batchSize: Number(event.target.value) })
                  }
                >
                  <option value={1}>1 image</option>
                  <option value={2}>2 images</option>
                  <option value={3}>3 images</option>
                  <option value={4}>4 images</option>
                </Select>
                {hasFixedSampling ? <small className="field-note">{"This model generates one image per request."}</small> : null}
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
