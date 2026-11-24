import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import { Button, ErrorMessage, ModelCard, ModelCardActions, ModelCardHeading, ModelStatus, PageHeader, SegmentedControl, Select } from "./ui/controls";
import type { useTextChat } from "../hooks/useTextChat";
import type { useQwen3Tts } from "../hooks/useQwen3Tts";
import { ModelLibrary, type InstalledModel } from "./ModelLibrary";
import { TextModelLibrary } from "./TextModelLibrary";
import { SpeechModelRequirements } from "./SpeechModelRequirements";
import type { ModelSetup, SetupSelection } from "../lib/modelSetup";
import { recommendedTextModelIssue, textModelReadiness } from "../lib/textThreads";

export type ModelCategory = "image" | "text" | "audio" | "video";
export function ModelsView({ category: tab, onCategoryChange, text, audio, setup, onReturnToDraft, imageGpuAvailable }: {
  category: ModelCategory;
  onCategoryChange: (category: ModelCategory) => void;
  text: ReturnType<typeof useTextChat>; audio: ReturnType<typeof useQwen3Tts>;
  setup: ModelSetup | null;
  onReturnToDraft: (selection?: SetupSelection) => void;
  imageGpuAvailable?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const audioRequirementsPrefix = useId();
  const body = useRef<HTMLDivElement>(null);
  const [imageCatalog, setImageCatalog] = useState<InstalledModel[]>([]);
  const [textSelection, setTextSelection] = useState<{ setup: ModelSetup; modelId: string }>();
  const setupThread = setup && text.threads.find((thread) => thread.id === setup.threadId);
  const needsImageTools = setup?.task === "chat-image";
  const needsVision = needsImageTools || setup?.task === "chat-vision" ||
    !!(setupThread?.draftImage || setupThread?.draftContextImage);
  const needsText = setup?.task !== "image";
  const needsImage = needsImageTools || setup?.task === "image";
  const compatibleText = text.status.models.filter((model) => textModelReadiness(text.status, model).usable &&
    (!needsVision || model.supportsVision) && (!needsImageTools || model.supportsTools));
  const chosenTextId = textSelection?.setup === setup ? textSelection?.modelId : undefined;
  const installedText = compatibleText.find((model) => model.id === chosenTextId)
    ?? compatibleText.find((model) => model.id === setupThread?.modelId)
    ?? compatibleText.find((model) => model.id === text.status.defaultModelId)
    ?? compatibleText[0];
  const selectedTextReadiness = installedText && textModelReadiness({
    ...text.status, residentModel: text.statusError ? undefined : text.status.residentModel,
    runningModelId: text.status.job.status === "running" ? text.status.job.modelId : null,
  }, installedText);
  const compatibleDownloads = text.status.recommendedModels?.filter((model) => !model.installed &&
    !recommendedTextModelIssue(text.status, model) && (!needsVision || !!model.projectorBytes) &&
    (!needsImageTools || model.supportsTools)) ?? [];
  const repairTarget = setupThread?.modelId
    ? compatibleDownloads.find((model) => model.repairModelId === setupThread.modelId) : undefined;
  const install = text.status.modelInstall;
  const unfinishedDownload = compatibleDownloads.find((model) =>
    model.id === install?.modelId && install.status !== "idle" && install.status !== "complete");
  const recommendedText = repairTarget ?? (!installedText
    ? unfinishedDownload ?? compatibleDownloads.sort((a, b) => a.bytes - b.bytes ||
      Number(b.id === text.status.defaultModelId) - Number(a.id === text.status.defaultModelId))[0]
    : undefined);
  const installedTool = text.status.imageToolModels?.[0];
  const installedImage = needsImageTools ? installedTool : imageCatalog.find((model) => model.installed &&
    !model.setupUnavailableReason && model.state !== "runtime-unavailable" &&
    (["4b", "9b"].includes(model.id) || model.category === "image") &&
    (text.computeDevice !== "CPU" || !model.generationDevices || model.generationDevices.includes("CPU")));
  const recommendedImage = imageCatalog.find((model) =>
    model.id === (window.studio.platform === "darwin" ? "klein-4b-mlx" : "4b") && !model.setupUnavailableReason
  );
  const imageToolBlock = needsImageTools && (text.computeDevice === "CPU"
    ? "Select GPU in Preferences to generate images in chat."
    : imageGpuAvailable === false ? `Image generation in chat requires an available ${window.studio.platform === "darwin" ? "Apple" : "Intel"} GPU.` : null);
  const imageDeviceBlock = setup?.task === "image" && !installedImage && text.computeDevice === "CPU" &&
    recommendedImage?.generationDevices && !recommendedImage.generationDevices.includes("CPU");
  const selection = {
    textModelId: needsText ? installedText?.id : undefined,
    imageModelId: needsImage ? installedImage?.id : undefined,
  };
  const setupReady = (!needsText || (!!selection.textModelId && text.statusLoaded && !text.statusError))
    && (!needsImage || !!selection.imageModelId) && !imageToolBlock;
  useEffect(() => heading.current?.focus(), []);
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab]);
  return <section className="shell-page models-view" aria-labelledby="models-view-title">
    <PageHeader
      className="shell-page-header"
      id="models-view-title"
      title="Models"
      titleRef={heading}
      actions={<SegmentedControl label="Model categories" value={tab} onChange={onCategoryChange} options={[{ value: "image", label: "Image" }, { value: "text", label: "Text" }, { value: "audio", label: "Audio" }, { value: "video", label: "Video" }]} />}
    />
    {setup ? <section className="model-setup-summary" aria-label="Draft setup">
      <div className="model-setup-summary-copy">
        <strong>{needsImageTools ? "Images in chat" : needsVision ? "Chat about an image" : needsText ? "Chat model" : "Image generation"}</strong>
        {needsText && <div className="model-setup-requirement">
          {needsImageTools && <span className="model-setup-role">Chat and vision</span>}
          {installedText && compatibleText.length > 1 ? <Select aria-label="Chat model" className="model-setup-text-choice" value={installedText.id}
            onChange={(modelId) => setTextSelection({ setup, modelId })}
            options={compatibleText.map(({ id, name }) => ({ value: id, label: name }))} /> : <span>{installedText ? `${installedText.name} · ${selectedTextReadiness?.label}` :
            repairTarget ? `${repairTarget.name} · Needs repair` :
            recommendedText ? `${recommendedText.name} · ${(recommendedText.bytes / 1e9).toFixed(2)} GB download` :
            !text.statusLoaded ? "Checking chat models…" :
            needsVision ? "Choose a chat model with vision." : "Choose a compatible chat model."}</span>}
        </div>}
        {needsImage && <div className="model-setup-requirement">
          {needsImageTools && <span className="model-setup-role">Image creation</span>}
          <span>{installedImage ? `${installedImage.label} · Installed` :
            recommendedImage?.installed ? `${recommendedImage.label} · Installed` :
            recommendedImage ? `${recommendedImage.label} · ${(recommendedImage.bytes / 1e9).toFixed(2)} GB download` :
            "Choose an image model."}</span>
        </div>}
        {imageToolBlock && <span>{imageToolBlock}</span>}
        {imageDeviceBlock && <span>Select Available GPU in Preferences to use this image model.</span>}
      </div>
      <div className="model-setup-summary-actions">
        {needsText && !installedText && tab !== "text" && <Button variant="ghost" onClick={() => onCategoryChange("text")}>Choose chat model</Button>}
        {needsImageTools && installedText && !installedImage && tab !== "image" && <Button variant="ghost" onClick={() => onCategoryChange("image")}>Choose image model</Button>}
        {setupReady ? <Button variant="primary" onClick={() => onReturnToDraft(selection)}>Use {needsImageTools ? "models" : "model"} in draft</Button> : null}
        <Button variant="secondary" onClick={() => onReturnToDraft()}>Return to draft</Button>
      </div>
    </section> : null}
    <div className="shell-page-body models-body" ref={body}>
      <div hidden={tab !== "image" && tab !== "video"}><ModelLibrary category={tab === "video" ? "video" : "image"} recommendedId={setup && needsImage ? recommendedImage?.id : undefined} onCatalogChange={setImageCatalog} /></div>
      {tab === "text" ? <TextModelLibrary studio={text} recommendedId={setup ? recommendedText?.id : undefined} /> : tab === "audio" ? <section aria-label="Audio models">
        <div className="models-section-heading"><div><h3>Audio models</h3><p>Qwen3-TTS voice generation and cloning.</p></div></div>
        {audio.statusError || audio.error ? <ErrorMessage>{audio.statusError || audio.error}</ErrorMessage> : null}
        {!audio.statusLoaded ? <p role="status">Checking audio models…</p> : null}
        {audio.status.setupUnavailableReason ? <p className="model-library-note">{audio.status.setupUnavailableReason}</p> : null}
        <div className="model-library-grid">{audio.status.models.map((model) => {
          const settingUp = audio.status.operation === "setup" && audio.status.model === model.id && audio.status.status === "setting_up";
          const ready = model.ready ?? model.installed;
          const showRequirements = !ready && !audio.status.setupUnavailableReason;
          const requirementsId = audioRequirementsPrefix + "-" + model.id;
          return <ModelCard key={model.id}>
            <ModelCardHeading icon={<AudioLines size={17} />}><h4>{model.label}</h4></ModelCardHeading>
            <p>{model.kind === "base" ? "Clone a voice from a recording" : model.kind === "voice_design" ? "Describe and create a voice" : "Generate speech with preset voices"}</p>
            {showRequirements && <SpeechModelRequirements id={requirementsId} model={model} device={audio.computeDevice}
              environmentReady={audio.status.environmentReady} />}
            <ModelStatus installed={model.installed}>{ready ? "Ready" : settingUp ? audio.status.phase || "Installing…" : model.installed ? "Installed · speech runtime required" : "Not installed"}</ModelStatus>
            {settingUp ? <progress aria-label={`${model.label} installation`} /> : null}
            <ModelCardActions>
              {showRequirements && <Button aria-describedby={requirementsId}
                disabled={!audio.statusLoaded || Boolean(audio.statusError) || audio.busy || text.busy || settingUp}
                onClick={() => void audio.setupModel(model.id)}>{settingUp ? "Installing…" : model.installed ? "Set up runtime" : "Install"}</Button>}
              {settingUp && <Button onClick={() => void audio.stopJob()}>Cancel</Button>}
            </ModelCardActions>
          </ModelCard>;
        })}</div>
      </section> : null}
    </div>
  </section>;
}
