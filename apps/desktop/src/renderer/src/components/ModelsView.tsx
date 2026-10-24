import { useEffect, useRef } from "react";
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
  useEffect(() => heading.current?.focus(), []);
  return <section className="shell-page models-view" aria-labelledby="models-view-title">
    <header className="shell-page-header"><div><h2 id="models-view-title" tabIndex={-1} ref={heading}>Models</h2><p>Install and manage the models that power your threads.</p></div></header>
    <div className="models-category-bar" role="group" aria-label="Model categories">{(["image", "text", "audio"] as const).map((id) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => onCategoryChange(id)}>{id === "image" ? "Image" : id === "text" ? "Text" : "Audio"}</button>)}</div>
    <div className="shell-page-body models-body">
      {tab === "image" ? <ModelLibrary /> : tab === "text" ? <TextModelLibrary studio={text} /> : <section aria-label="Audio models">
        <div className="models-section-heading"><div><h3>Audio models</h3><p>Qwen3-TTS voice generation and cloning.</p></div></div>
        {audio.statusError || audio.error ? <p role="alert">{audio.statusError || audio.error}</p> : null}
        {!audio.statusLoaded ? <p role="status">Checking audio models…</p> : null}
        <div className="model-library-grid">{audio.status.models.map((model) => {
          const settingUp = audio.status.operation === "setup" && audio.status.model === model.id && audio.status.status === "setting_up";
          return <article className="model-library-card" key={model.id}><h4>{model.label}</h4><p>{model.kind === "base" ? "Clone a voice from a recording" : model.kind === "voice_design" ? "Describe and create a voice" : "Generate speech with preset voices"}</p><p role="status">{model.installed ? "Installed" : settingUp ? audio.status.phase || "Installing…" : "Not installed"}</p>{settingUp ? <progress aria-label={`${model.label} installation`} /> : null}<div className="model-library-actions"><button type="button" className="btn btn-secondary" disabled={audio.busy || text.busy || model.installed} onClick={() => void audio.setupModel(model.id)}>{model.installed ? "Installed" : settingUp ? "Installing…" : "Install"}</button>{settingUp ? <button type="button" className="btn btn-secondary" disabled={audio.status.status === "stopping"} onClick={() => void audio.stopJob()}>Cancel</button> : null}</div></article>;
        })}</div>
      </section>}
    </div>
  </section>;
}
