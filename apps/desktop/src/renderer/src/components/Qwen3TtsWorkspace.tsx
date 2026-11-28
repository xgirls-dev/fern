import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Upload from "lucide-react/dist/esm/icons/upload.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { useQwen3Tts } from "../hooks/useQwen3Tts";
import type { AudioOutput, QwenTtsModel } from "../lib/ttsThreads";
import { Button, ChoiceCard, IconButton, Select, Textarea } from "./ui/controls";
import { AudioFeed } from "./AudioFeed";
import { SpeechModelRequirements } from "./SpeechModelRequirements";
import { TtsJobProgress } from "./TtsJobProgress";
import { WorkspaceThreadTitle } from "./WorkspaceThreadTitle";
import { Disclosure } from "./ui/Disclosure";

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

export function Qwen3TtsWorkspace({ studio, sidebarCollapsed, onOpenThreadSearch, activity }: {
  studio: ReturnType<typeof useQwen3Tts>;
  sidebarCollapsed: boolean;
  onOpenThreadSearch: () => void;
  activity: ReactNode;
}) {
  const { activeThread, status, busy, error, stopping, updateThread } = studio;
  const setupRequirementsId = useId();
  const scriptCountId = useId();
  const setupFocusThread = useRef<string | undefined>(undefined);
  const script = useRef<HTMLTextAreaElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [referenceReady, setReferenceReady] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const model = models.find((item) => item.id === activeThread.model) ?? models[0];
  const selectedModel = status.models.find((item) => item.id === model.id);
  const modelReady = selectedModel?.ready ?? selectedModel?.installed ?? false;
  const setupUnavailable = !modelReady ? status.setupUnavailableReason : null;
  const setupNeeded = studio.statusLoaded && !studio.statusError && !modelReady && !setupUnavailable;
  const working = status.status === "running" || status.status === "setting_up" || status.status === "stopping";
  const workingHere = working && status.threadId === activeThread.id;
  const diagnostics = status.threadId === activeThread.id ? status.diagnostics : undefined;
  const failedHere = status.threadId === activeThread.id && status.status === "failed";
  const availability = studio.statusError ? "Audio unavailable"
    : !studio.statusLoaded ? "Checking audio"
    : failedHere ? status.operation === "setup" ? "Setup failed" : "Generation failed"
    : status.threadId === activeThread.id && status.status === "stopped" ? "Audio stopped"
    : modelReady ? "Ready"
    : setupUnavailable ? "Setup unavailable" : "Setup needed";
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
  useEffect(() => {
    if (busy || !setupFocusThread.current) return;
    const finishedHere = status.operation === "setup" && status.status === "complete" &&
      status.threadId === activeThread.id && setupFocusThread.current === activeThread.id;
    setupFocusThread.current = undefined;
    if (finishedHere && document.activeElement === document.body) script.current?.focus({ preventScroll: true });
  }, [activeThread.id, busy, status.operation, status.status, status.threadId]);

  const chooseMode = (nextMode: VoiceMode) => {
    if (nextMode === model.mode) return;
    const options = models.filter((item) => item.mode === nextMode);
    const next = options.find((item) => status.models.some((available) => available.id === item.id && available.installed)) ?? options[0];
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
  const viewTake = (name: string) => {
    setRevealTake((previous) => ({ name, token: (previous?.token ?? 0) + 1 }));
  };
  const latestTake = activeThread.outputs[0];
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
        <WorkspaceThreadTitle
          id="tts-heading"
          title={activeThread.title}
          switchLabel="Open audio thread"
          sidebarCollapsed={sidebarCollapsed}
          onOpen={onOpenThreadSearch}
        />
        <span className="workspace-heading-divider" aria-hidden="true">/</span><span>Qwen3-TTS {model.size}</span>
      </div>
      {working ? <TtsJobProgress
        label={stopping ? "Stopping audio" : status.operation === "setup" ? "Setting up model" : "Generating take"}
        phase={status.phase} startedAt={status.startedAt} stopping={stopping} onStop={() => void studio.stopJob()}
      /> : <span className={`tts-header-meta${failedHere ? " tts-header-meta--failure" : ""}`} role="status">{availability}</span>}
    </header>
    {working && !workingHere ? <div className="tts-elsewhere" role="status"><span>A Qwen3-TTS {status.operation === "setup" ? "setup" : "generation"} is running in another thread.</span>{status.threadId && studio.threads.some((thread) => thread.id === status.threadId) ? <Button variant="ghost" className="tts-view-thread" onClick={() => studio.selectThread(status.threadId!)}>View running thread</Button> : null}</div> : null}

    <div className={`tts-layout${activeThread.outputs.length ? "" : " tts-layout--empty"}`}>
      <AudioFeed
        key={activeThread.id}
        thread={activeThread}
        revealTake={revealTake}
        modelLabel={outputLabel}
        completion={latestTakeReady && dismissedCompletion !== status.id ? <div className="tts-completion" role="status"><div><strong>Your take is ready</strong></div><Button variant="secondary" onClick={() => { if (status.output) viewTake(status.output.name); }}>View take</Button><IconButton aria-label="Dismiss take notification" onClick={() => setDismissedCompletion(status.id)}><X size={16} /></IconButton></div> : null}
        diagnostics={diagnostics?.length ? <Disclosure className="tts-job-diagnostics" label={`Technical diagnostics (${diagnostics.length})`}>
          <pre>{diagnostics.join("\n")}</pre>
        </Disclosure> : null}
        generating={workingHere && status.operation === "generate"}
        onUseText={(output) => { updateThread(activeThread.id, { text: output.prompt }); focusScript(); }}
        onReuseSetup={reuseSetup}
        onOpenComposer={focusScript}
        setupUnavailable={setupUnavailable}
        setupNeeded={!modelReady}
        onUpdateOutput={(name, patch) => studio.updateOutput(activeThread.id, name, patch)}
        onDeleteOutput={(name) => studio.deleteOutput(activeThread.id, name)}
      />

      <section className="tts-composer" aria-label="Speech generation settings">
        <div className="tts-composer-scroll">
        <div className="tts-section-heading">
          <h3>Create speech</h3>
          {latestTake && <Button variant="ghost" className="tts-latest-take" onClick={() => viewTake(latestTake.name)}>
            <ArrowDown size={14} aria-hidden="true" /> Latest take
          </Button>}
        </div>
        <div className="tts-control-group tts-script-group"><div className="tts-group-heading"><strong>Script</strong></div><label className="tts-field"><Textarea id="tts-script" ref={script} aria-label="Text to speak" aria-describedby={scriptCountId} value={activeThread.text} maxLength={10000} rows={7} placeholder="Write or paste your script…" onChange={(event) => updateThread(activeThread.id, { text: event.target.value })} /><small className="tts-character-count" id={scriptCountId}>{activeThread.text.length.toLocaleString()} / 10,000</small></label></div>
        <div className="tts-control-group"><div className="tts-group-heading"><strong>Voice source</strong></div><div className="tts-mode-list" role="group" aria-label="Voice source">{modes.map((item) => <ChoiceCard key={item.id} className="tts-mode-option" selected={model.mode === item.id} disabled={busy || working} onClick={() => chooseMode(item.id)}>{model.mode === item.id && <Check className="tts-voice-selected" size={12} aria-hidden="true" />}<span><strong>{item.title}</strong><small>{item.summary}</small></span></ChoiceCard>)}</div></div>
        <div className="tts-control-group tts-voice-detail"><div className="tts-group-heading"><strong>{model.mode === "custom" ? "Speaker & delivery" : model.mode === "clone" ? "Reference voice" : "Voice direction"}</strong><small>{model.mode === "custom" ? "Pick a speaker and guide the performance." : model.mode === "clone" ? "Use a clear sample of the voice to match." : "Describe the voice you want to create."}</small></div>
          {model.mode === "custom" ? <div className="tts-control-stack"><label className="tts-field">Preset speaker<Select value={activeThread.speaker} onChange={(speaker) => updateThread(activeThread.id, { speaker })} options={speakers.map((speaker) => ({ value: speaker, label: speaker.replaceAll("_", " ") }))} /></label><label className="tts-field">Delivery direction <span className="tts-optional">Optional</span><Textarea value={activeThread.instruction} maxLength={2000} rows={2} placeholder="For example: calm, warm, and measured" onChange={(event) => updateThread(activeThread.id, { instruction: event.target.value })} /></label></div> : null}
          {model.mode === "design" ? <label className="tts-field">Voice description<Textarea value={activeThread.designInstruction} maxLength={2000} rows={3} placeholder="For example: a low, warm voice with a relaxed pace" onChange={(event) => updateThread(activeThread.id, { designInstruction: event.target.value })} /><small>A specific description gives the model more to work with.</small></label> : null}
          {model.mode === "clone" ? <div className="tts-control-stack"><div className="tts-reference"><label className="tts-reference-picker" htmlFor="tts-reference-file"><Upload size={16} aria-hidden="true" /><span>{referenceFile ? "Replace reference clip" : "Choose a reference clip"}</span></label><input key={`${activeThread.id}-${fileInputKey}`} id="tts-reference-file" type="file" accept=".wav,.flac,audio/wav,audio/flac" onChange={(event) => { chooseReference(event.target.files?.[0] ?? null); event.currentTarget.value = ""; }} />{referenceFile ? <div className="tts-reference-selected"><span>{referenceFile.name} · {(referenceFile.size / 1_000_000).toFixed(1)} MB</span><IconButton aria-label="Remove reference clip" onClick={() => { chooseReference(null); setFileInputKey((value) => value + 1); }}><X size={15} aria-hidden="true" /></IconButton></div> : null}{referenceUrl ? <audio className="tts-reference-preview" controls preload="metadata" src={referenceUrl} aria-label="Reference clip preview" onLoadedMetadata={(event) => {
            const valid = Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration > 0;
            setReferenceReady(valid);
            if (!valid) setFileError("This clip contains no playable audio. Choose another recording.");
          }} onError={() => { setReferenceReady(false); setFileError("This clip could not be decoded. Choose a playable WAV or FLAC."); }} /> : null}<small>WAV or FLAC, under 12 MB. This clip is kept in memory while Fern is open; choose it again after restarting.</small>{fileError ? <small className="tts-error" role="alert">{fileError}</small> : null}</div><label className="tts-field">Words spoken in the clip <span className="tts-optional">Optional</span><Textarea value={activeThread.referenceText} maxLength={5000} rows={2} placeholder="Transcribe the reference clip for closer cloning" onChange={(event) => updateThread(activeThread.id, { referenceText: event.target.value })} /><small>A transcript helps Fern match how the sample is spoken.</small></label></div> : null}
        </div>
        <div className="tts-control-group tts-output-group"><div className="tts-group-heading"><strong>Output</strong><small>Language and model for this take.</small></div><div className="tts-output-fields"><label className="tts-field">Language<Select value={activeThread.language} onChange={(language) => updateThread(activeThread.id, { language })} options={languages.map((language) => ({ value: language, label: language }))} /></label><div className="tts-field"><span>Model size</span><div className="tts-size-list" role="group" aria-label="Model size">{models.filter((item) => item.mode === model.mode).map((item) => <ChoiceCard key={item.id} className="tts-size-option" selected={item.id === model.id} disabled={busy || working} onClick={() => updateThread(activeThread.id, { model: item.id })}><span><strong>{item.size}</strong><small>{item.size === "0.6B" ? "Faster setup and generation · less memory" : "More voice detail · slower, more memory"}</small></span><em>{studio.statusError ? "Unknown" : !studio.statusLoaded ? "Checking" : status.models.some((candidate) => candidate.id === item.id && (candidate.ready ?? candidate.installed)) ? "Ready" : status.setupUnavailableReason ? "Unavailable" : "Set up"}</em></ChoiceCard>)}</div></div></div></div>

        </div>
        <div className="tts-composer-footer">


          {studio.statusError || error || fileError || (status.threadId === activeThread.id && status.status === "failed" && status.error) ? <div className="tts-footer-error" role="alert"><span>{studio.statusError ?? error ?? fileError ?? status.error}</span>{studio.statusError ? <Button variant="secondary" className="tts-retry-status" onClick={() => void studio.retryStatus()}>Retry</Button> : null}</div> : null}
          {setupNeeded && !working ? <div className="tts-submit tts-submit--setup">
            <SpeechModelRequirements id={setupRequirementsId} model={selectedModel} device={studio.computeDevice}
              environmentReady={status.environmentReady} label={model.label} />
            <Button variant="primary" className="tts-generate-button" disabled={busy} aria-describedby={setupRequirementsId}
              onClick={() => { setupFocusThread.current = activeThread.id; void studio.setupModel(model.id); }}>Set up model</Button>
          </div> : <div className="tts-submit">
            <span>{stopping ? "Stopping the current audio job" : working ? workingHere ? "This take is in progress" : "Another audio thread is busy" : studio.statusError ? "Audio service unavailable · retry above" : !studio.statusLoaded ? "Checking audio models…" : setupUnavailable ? setupUnavailable : !modelReady ? "Set up this model to continue" : !activeThread.text.trim() ? "Add a script to continue" : model.mode === "clone" && !referenceFile ? "Add a reference clip to continue" : model.mode === "clone" && fileError ? "Replace the reference clip to continue" : model.mode === "clone" && !referenceReady ? "Checking the reference clip…" : model.mode === "design" && !activeThread.designInstruction.trim() ? "Describe the voice to continue" : "Ctrl + Enter to generate"}</span>
            <Button variant="primary" className="tts-generate-button" disabled={!canGenerate} onClick={() => void studio.generate()}>{workingHere && status.operation === "generate" ? "Generating…" : "Generate speech"}</Button>
          </div>}
        </div>
      </section>
    </div>
    {activity}
  </section>;
}
