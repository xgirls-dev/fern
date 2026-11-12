import { useEffect, useLayoutEffect, useRef } from "react";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import { Button, ErrorMessage, ModelCard, ModelCardActions, ModelCardHeading, ModelStatus, PageHeader, SegmentedControl } from "./ui/controls";
import type { useTextChat } from "../hooks/useTextChat";
import type { useQwen3Tts } from "../hooks/useQwen3Tts";
import { ModelLibrary } from "./ModelLibrary";
import { TextModelLibrary } from "./TextModelLibrary";

export type ModelCategory = "image" | "text" | "audio";
export function ModelsView({ category: tab, onCategoryChange, text, audio }: {
  category: ModelCategory;
  onCategoryChange: (category: ModelCategory) => void;
  text: ReturnType<typeof useTextChat>; audio: ReturnType<typeof useQwen3Tts>;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab]);
  return <section className="shell-page models-view" aria-labelledby="models-view-title">
    <PageHeader className="shell-page-header" id="models-view-title" title="Models" description="Install and manage the models that power your threads." titleRef={heading} />
    <SegmentedControl className="models-category-bar" label="Model categories" value={tab} onChange={onCategoryChange} options={[{ value: "image", label: "Image" }, { value: "text", label: "Text" }, { value: "audio", label: "Audio" }]} />
    <div className="shell-page-body models-body" ref={body}>
      <div hidden={tab !== "image"}><ModelLibrary /></div>
      {tab === "text" ? <TextModelLibrary studio={text} /> : tab === "audio" ? <section aria-label="Audio models">
        <div className="models-section-heading"><div><h3>Audio models</h3><p>Qwen3-TTS voice generation and cloning.</p></div></div>
        {audio.statusError || audio.error ? <ErrorMessage>{audio.statusError || audio.error}</ErrorMessage> : null}
        {!audio.statusLoaded ? <p role="status">Checking audio models…</p> : null}
        <div className="model-library-grid">{audio.status.models.map((model) => {
          const settingUp = audio.status.operation === "setup" && audio.status.model === model.id && audio.status.status === "setting_up";
          return <ModelCard key={model.id}>
            <ModelCardHeading icon={<AudioLines size={17} />}><h4>{model.label}</h4></ModelCardHeading>
            <p>{model.kind === "base" ? "Clone a voice from a recording" : model.kind === "voice_design" ? "Describe and create a voice" : "Generate speech with preset voices"}</p>
            <ModelStatus installed={model.installed}>{model.installed ? "Installed" : settingUp ? audio.status.phase || "Installing…" : "Not installed"}</ModelStatus>
            {settingUp ? <progress aria-label={`${model.label} installation`} /> : null}
            <ModelCardActions><Button disabled={audio.busy || text.busy || model.installed} onClick={() => void audio.setupModel(model.id)}>{model.installed ? "Installed" : settingUp ? "Installing…" : "Install"}</Button>{settingUp ? <Button disabled={audio.status.status === "stopping"} onClick={() => void audio.stopJob()}>Cancel</Button> : null}</ModelCardActions>
          </ModelCard>;
        })}</div>
      </section> : null}
    </div>
  </section>;
}
