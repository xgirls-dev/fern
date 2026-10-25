import Play from "lucide-react/dist/esm/icons/play.mjs";
import Upload from "lucide-react/dist/esm/icons/upload.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useState } from "react";
import type { useQwen3Tts } from "../hooks/useQwen3Tts";
import type { AudioOutput, QwenTtsModel } from "../lib/ttsThreads";
import { AudioFeed } from "./AudioFeed";
import { TtsJobProgress } from "./TtsJobProgress";

type VoiceMode = "custom" | "clone" | "design";
const modes: Array<{ id: VoiceMode; title: string; summary: string }> = [
  { id: "custom", title: "Preset voice", summary: "Pick a built-in speaker" },
  { id: "clone", title: "Clone a voice", summary: "Use a reference clip" },
  { id: "design", title: "Design a voice", summary: "Describe a new voice" },
];
const models: Array<{ id: QwenTtsModel; mode: VoiceMode; size: "0.6B" | "1.7B"; label: string }> = [
  { id: "custom-0.6b", mode: "custom", size: "0.6B", label: "Preset voice · 0.6B" },
  { id: "custom-1.7b", mode: "custom", size: "1.7B", label: "Preset voice · 1.7B" },
  { id: "base-0.6b", mode: "clone", size: "0.6B", label: "Voice clone · 0.6B" },
  { id: "base-1.7b", mode: "clone", size: "1.7B", label: "Voice clone · 1.7B" },
  { id: "voice-design-1.7b", mode: "design", size: "1.7B", label: "Voice design · 1.7B" },
];
const languages = ["Auto", "Chinese", "English", "Japanese", "Korean", "French", "German", "Spanish", "Portuguese", "Russian", "Italian"];
const speakers = ["Vivian", "Serena", "Uncle_fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_anna", "Sohee"];
const outputLabel = (output: AudioOutput) => models.find((item) => item.id === output.model)?.label ?? "Qwen3-TTS";

export function Qwen3TtsWorkspace({ studio }: { studio: ReturnType<typeof useQwen3Tts> }) {
  const { activeThread, status, busy, error, updateThread } = studio;
  const [fileError, setFileError] = useState<string | null>(null);
  const [referenceReady, setReferenceReady] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const model = models.find((item) => item.id === activeThread.model) ?? models[0];
  const modelReady = status.models.find((item) => item.id === model.id)?.installed ?? false;
  const working = status.status === "running" || status.status === "setting_up" || status.status === "stopping";
  const workingHere = working && status.threadId === activeThread.id;
  const [revealTake, setRevealTake] = useState<{ name: string; token: number } | null>(null);
  const referenceFile = studio.referenceFiles[activeThread.id];
  const [referenceUrl, setReferenceUrl] = useState<string | undefined>();
  const [dismissedCompletion, setDismissedCompletion] = useState<string | null>(null);
  useEffect(() => {
    setReferenceReady(false);
    if (!referenceFile) { setReferenceUrl(undefined); return; }
    const url = URL.createObjectURL(referenceFile);
    setReferenceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [referenceFile]);
  const canGenerate = studio.statusLoaded && !studio.statusError && modelReady && !busy && !working && !!activeThread.text.trim() && (model.mode !== "clone" || (!!referenceFile && referenceReady && !fileError)) && (model.mode !== "design" || !!activeThread.designInstruction.trim());

  useEffect(() => { setFileError(null); }, [activeThread.id]);

  const chooseMode = (nextMode: VoiceMode) => {
    const next = models.find((item) => item.mode === nextMode && item.size === model.size) ?? models.find((item) => item.mode === nextMode)!;
    updateThread(activeThread.id, { model: next.id });
  };
  const chooseReference = (file: File | null) => {
    setFileError(null);
    setReferenceReady(false);
    if (file && !file.size) { studio.setReferenceFile(activeThread.id, null); setFileError("This clip is empty. Choose a WAV or FLAC with recorded speech."); return; }
    if (file && !/\.(wav|flac)$/i.test(file.name)) { studio.setReferenceFile(activeThread.id, null); setFileError("Choose a WAV or FLAC audio file."); return; }
    if (file && file.size > 12_000_000) { studio.setReferenceFile(activeThread.id, null); setFileError("Reference audio must be smaller than 12 MB."); return; }
    studio.setReferenceFile(activeThread.id, file);
  };
  const focusScript = () => window.setTimeout(() => document.getElementById("tts-script")?.focus(), 0);
  const viewLatestTake = () => {
    const name = status.output?.name;
    if (name) setRevealTake((previous) => ({ name, token: (previous?.token ?? 0) + 1 }));
  };
  const latestTakeReady = status.status === "complete" && status.operation === "generate" && status.threadId === activeThread.id
    && !!status.output && activeThread.outputs.some((output) => output.name === status.output?.name);
  const reuseSetup = (output: AudioOutput) => {
    const patch: Partial<typeof activeThread> = { text: output.prompt };
    if (output.model) patch.model = output.model;
    if (output.language) patch.language = output.language;
    if (output.speaker) patch.speaker = output.speaker;
    if (output.instruction !== undefined) patch.instruction = output.instruction;
    if (output.designInstruction !== undefined) patch.designInstruction = output.designInstruction;
    if (output.referenceText !== undefined) patch.referenceText = output.referenceText;
    if (output.device) patch.device = output.device === "CPU" ? "AUTO" : output.device;
    updateThread(activeThread.id, patch);
    focusScript();
    if (output.model?.startsWith("base-")) {
      if (referenceFile && referenceFile.name === output.referenceFileName) return "Script and settings loaded. The matching reference clip is still selected.";
      studio.setReferenceFile(activeThread.id, null);
      setFileInputKey((value) => value + 1);
      return "Script and settings loaded. Choose the reference voice clip again.";
    }
    return output.model ? "Script and voice settings loaded into the composer." : "Script and available settings loaded into the composer.";
  };

  return <section className="tts-workspace" aria-labelledby="tts-heading" onPlayCapture={(event) => {
    for (const audio of event.currentTarget.querySelectorAll("audio")) if (audio !== event.target) audio.pause();
  }} onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing && canGenerate && !document.querySelector('[aria-modal="true"]')) {
      event.preventDefault();
      void studio.generate();
    }
  }}>
    <header className="tts-header workspace-header">
      <div className="workspace-heading">
        <h2 id="tts-heading" title={activeThread.title}>{activeThread.title}</h2>
        <select className="thread-switcher" aria-label="Open audio thread" value={activeThread.id} onChange={(event) => studio.selectThread(event.target.value)}>
          {studio.threads.filter((thread) => !thread.archived || thread.id === activeThread.id).map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
        </select>
        <span className="workspace-heading-divider" aria-hidden="true">/</span><span>Qwen3-TTS {model.size}</span>
      </div>
      <div className="tts-header-actions"><span className={`tts-header-meta${working ? " is-working" : ""}`} role="status"><span className="tts-status-dot" aria-hidden="true" />{status.status === "stopping" ? "Stopping audio" : workingHere ? status.operation === "setup" ? "Setting up model" : "Generating take" : working ? "Audio busy" : studio.statusError ? "Audio unavailable" : status.status === "stopped" && status.threadId === activeThread.id ? "Audio stopped" : !studio.statusLoaded ? "Checking audio" : modelReady ? "Ready" : "Setup needed"}</span>{working ? <button type="button" className="btn btn-secondary" disabled={status.status === "stopping"} onClick={() => void studio.stopJob()}>{status.status === "stopping" ? "Stopping…" : "Stop audio"}</button> : null}</div>
    </header>
    {working && !workingHere ? <div className="tts-elsewhere" role="status"><span>A Qwen3-TTS {status.operation === "setup" ? "setup" : "generation"} is running in another thread.</span>{status.threadId && studio.threads.some((thread) => thread.id === status.threadId) ? <button type="button" onClick={() => studio.selectThread(status.threadId!)}>View running thread</button> : null}</div> : null}

    <div className="tts-layout">
      <AudioFeed
        key={activeThread.id}
        thread={activeThread}
        revealTake={revealTake}
        modelLabel={outputLabel}
        completion={latestTakeReady && dismissedCompletion !== status.id ? <div className="tts-completion" role="status"><div><strong>Your take is ready</strong><span>Listen below, or jump to the finished take.</span></div><button type="button" className="btn btn-secondary" onClick={viewLatestTake}>View take</button><button type="button" aria-label="Dismiss take notification" onClick={() => setDismissedCompletion(status.id)}><X size={16} /></button></div> : null}
        jobProgress={status.threadId === activeThread.id && status.operation ? <TtsJobProgress status={status} onStop={() => void studio.stopJob()} /> : null}
        generation={{ running: workingHere, logs: status.logs, error: status.threadId === activeThread.id && status.operation === "generate" && status.status === "failed" ? status.error : null }}
        onUseText={(output) => { updateThread(activeThread.id, { text: output.prompt }); focusScript(); }}
        onReuseSetup={reuseSetup}
        onOpenComposer={focusScript}
        onUpdateOutput={(name, patch) => studio.updateOutput(activeThread.id, name, patch)}
        onDeleteOutput={(name) => studio.deleteOutput(activeThread.id, name)}
      />

      <section className="tts-composer" aria-label="Speech generation settings">
        <div className="tts-composer-scroll">
        <div className="tts-section-heading"><div><h3>Create speech</h3><p>Write, choose a voice, and generate a take.</p></div></div>
        <div className="tts-control-group tts-script-group"><div className="tts-group-heading"><strong>Script</strong><small>Write the words you want to hear.</small></div><label className="tts-field"><span className="sr-only">Text to speak</span><textarea id="tts-script" value={activeThread.text} maxLength={10000} rows={7} placeholder="Write or paste your script…" onChange={(event) => updateThread(activeThread.id, { text: event.target.value })} /><small className="tts-character-count">{activeThread.text.length.toLocaleString()} / 10,000</small></label></div>
        <div className="tts-control-group"><div className="tts-group-heading"><strong>Voice source</strong><small>Choose how this take gets its voice.</small></div><div className="tts-mode-list" role="group" aria-label="Voice source">{modes.map((item) => <button key={item.id} type="button" className={`tts-mode-option${model.mode === item.id ? " is-selected" : ""}`} aria-pressed={model.mode === item.id} disabled={busy || working} onClick={() => chooseMode(item.id)}><span className="tts-choice-indicator" aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.summary}</small></span></button>)}</div></div>
        <div className="tts-control-group tts-voice-detail"><div className="tts-group-heading"><strong>{model.mode === "custom" ? "Speaker & delivery" : model.mode === "clone" ? "Reference voice" : "Voice direction"}</strong><small>{model.mode === "custom" ? "Pick a speaker and guide the performance." : model.mode === "clone" ? "Use a clear sample of the voice to match." : "Describe the voice you want to create."}</small></div>
          {model.mode === "custom" ? <div className="tts-control-stack"><label className="tts-field">Preset speaker<select value={activeThread.speaker} onChange={(event) => updateThread(activeThread.id, { speaker: event.target.value })}>{speakers.map((speaker) => <option key={speaker} value={speaker}>{speaker.replaceAll("_", " ")}</option>)}</select></label><label className="tts-field">Delivery direction <span className="tts-optional">Optional</span><textarea value={activeThread.instruction} maxLength={2000} rows={2} placeholder="For example: calm, warm, and measured" onChange={(event) => updateThread(activeThread.id, { instruction: event.target.value })} /></label></div> : null}
          {model.mode === "design" ? <label className="tts-field">Voice description<textarea value={activeThread.designInstruction} maxLength={2000} rows={3} placeholder="For example: a low, warm voice with a relaxed pace" onChange={(event) => updateThread(activeThread.id, { designInstruction: event.target.value })} /><small>A specific description gives the model more to work with.</small></label> : null}
          {model.mode === "clone" ? <div className="tts-control-stack"><div className="tts-reference"><label className="tts-reference-picker" htmlFor="tts-reference-file"><Upload size={16} aria-hidden="true" /><span>{referenceFile ? "Replace reference clip" : "Choose a reference clip"}</span></label><input key={`${activeThread.id}-${fileInputKey}`} id="tts-reference-file" type="file" accept=".wav,.flac,audio/wav,audio/flac" onChange={(event) => { chooseReference(event.target.files?.[0] ?? null); event.currentTarget.value = ""; }} />{referenceFile ? <div className="tts-reference-selected"><span>{referenceFile.name} · {(referenceFile.size / 1_000_000).toFixed(1)} MB</span><button type="button" aria-label="Remove reference clip" onClick={() => { chooseReference(null); setFileInputKey((value) => value + 1); }}><X size={14} /></button></div> : null}{referenceUrl ? <audio className="tts-reference-preview" controls preload="metadata" src={referenceUrl} aria-label="Reference clip preview" onLoadedMetadata={(event) => {
            const valid = Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration > 0;
            setReferenceReady(valid);
            if (!valid) setFileError("This clip contains no playable audio. Choose another recording.");
          }} onError={() => { setReferenceReady(false); setFileError("This clip could not be decoded. Choose a playable WAV or FLAC."); }} /> : null}<small>WAV or FLAC, under 12 MB. This clip is kept in memory while Fern is open; choose it again after restarting.</small>{fileError ? <small className="tts-error" role="alert">{fileError}</small> : null}</div><label className="tts-field">Words spoken in the clip <span className="tts-optional">Optional</span><textarea value={activeThread.referenceText} maxLength={5000} rows={2} placeholder="Transcribe the reference clip for closer cloning" onChange={(event) => updateThread(activeThread.id, { referenceText: event.target.value })} /><small>Without a transcript, Qwen uses speaker embedding mode.</small></label></div> : null}
        </div>
        <div className="tts-control-group tts-output-group"><div className="tts-group-heading"><strong>Output</strong><small>Language and model for this take.</small></div><div className="tts-output-fields"><label className="tts-field">Language<select value={activeThread.language} onChange={(event) => updateThread(activeThread.id, { language: event.target.value })}>{languages.map((language) => <option key={language}>{language}</option>)}</select></label><div className="tts-field"><span>Model size</span><div className="tts-size-list" role="group" aria-label="Model size">{models.filter((item) => item.mode === model.mode).map((item) => <button key={item.id} type="button" className={`tts-size-option${item.id === model.id ? " is-selected" : ""}`} aria-pressed={item.id === model.id} disabled={busy || working} onClick={() => updateThread(activeThread.id, { model: item.id })}><span><strong>{item.size}</strong><small>{item.size === "0.6B" ? "Faster setup and generation · less memory" : "More voice detail · slower, more memory"}</small></span><em>{studio.statusError ? "Unknown" : !studio.statusLoaded ? "Checking" : status.models.find((candidate) => candidate.id === item.id)?.installed ? "Ready" : "Set up"}</em></button>)}</div></div></div></div>
        {studio.statusLoaded && !modelReady ? <div className="tts-setup-card"><div><strong>Set up {model.label}</strong><p>Install the speech runtime and download the ready-made OpenVINO model. No conversion is needed.</p></div><button type="button" className="btn btn-secondary" disabled={busy || working} onClick={() => void studio.setupModel(model.id)}>Set up model</button></div> : null}

        </div>
        <div className="tts-composer-footer">


          {studio.statusError || error || fileError || (status.threadId === activeThread.id && status.status === "failed" && status.error) ? <div className="tts-footer-error" role="alert"><span>{studio.statusError ?? error ?? fileError ?? status.error}</span>{studio.statusError ? <button type="button" onClick={() => void studio.retryStatus()}>Retry</button> : null}</div> : null}
          <div className="tts-submit"><button type="button" className="btn btn-primary-lg" disabled={!canGenerate} onClick={() => void studio.generate()}><Play size={15} aria-hidden="true" /> {workingHere && status.operation === "generate" ? "Generating…" : "Generate speech"}</button><span>{status.status === "stopping" ? "Stopping the current audio job" : working ? workingHere ? "This take is in progress" : "Another audio thread is busy" : studio.statusError ? "Audio service unavailable · retry above" : !studio.statusLoaded ? "Checking audio models…" : !modelReady ? "Set up this model to continue" : !activeThread.text.trim() ? "Add a script to continue" : model.mode === "clone" && !referenceFile ? "Add a reference clip to continue" : model.mode === "clone" && fileError ? "Replace the reference clip to continue" : model.mode === "clone" && !referenceReady ? "Checking the reference clip…" : model.mode === "design" && !activeThread.designInstruction.trim() ? "Describe the voice to continue" : "Ctrl + Enter to generate"}</span></div>
        </div>
      </section>
    </div>
  </section>;
}
