import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Clapperboard from "lucide-react/dist/esm/icons/clapperboard.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import type { BackendFailure } from "../../../preload/types";
import { resolveAssetUrl } from "../lib/api";
import { notify } from "../lib/notifications";
import { readReference } from "../lib/reference";
import type { useVideo } from "../hooks/useVideo";
import { Button, ErrorMessage, InlineConfirmation, Input, PageHeader, Textarea } from "./ui/controls";
import { Select } from "./ui/Select";
import "./VideoWorkspace.css";

export function VideoWorkspace({ video, device, busyElsewhere, openModels, openCompute, backendFailure, backendConnecting, onRestartBackend, activity }: {
  video: ReturnType<typeof useVideo>;
  device: "GPU" | "CPU";
  busyElsewhere: boolean;
  openModels: () => void;
  openCompute: () => void;
  backendFailure: BackendFailure | null;
  backendConnecting: boolean;
  onRestartBackend?: () => Promise<void>;
  activity: ReactNode;
}) {
  const { clips, model, job, running, available, recovering, pending, interrupted, error, connectionError, reference, frames } = video;
  const format = model?.videoFormat;
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const allClips = job?.output && !clips?.some((clip) => clip.id === job.output?.id)
    ? [job.output, ...(clips ?? [])] : clips ?? [];
  const clip = allClips.find((item) => item.id === selected) ?? allClips[0];
  const canGenerate = available && model?.runtimeReady && device !== "CPU" && !running && !busyElsewhere && !pending;
  const serviceStatus = backendConnecting ? "Connecting to the local service…" : recovering ? "Checking for your last clip…" : null;
  useEffect(() => heading.current?.focus(), []);

  async function attach(file: File | undefined) {
    if (!file || running) return;
    setLoadingImage(true);
    video.setError("");
    try {
      video.setReference({ dataUrl: await readReference(file), label: file.name });
    } catch (cause) {
      video.setError(cause instanceof Error ? cause.message : "The image could not be read.");
    } finally {
      setLoadingImage(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canGenerate && !connectionError && !loadingImage) {
      setSelected(null);
      video.generate();
    }
  }

  async function exportClip() {
    if (!clip || saving) return;
    setSaving(true);
    try {
      const path = await window.studio.saveOutputVideo(clip.name);
      if (path) notify("Saved video.");
    } catch (cause) {
      video.setError(cause instanceof Error ? cause.message : "The video could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="shell-page video-workspace" aria-labelledby="video-heading">
    <PageHeader className="shell-page-header" id="video-heading" title="Video" titleRef={heading}
      description="Animate a still image with Wan 2.2 Turbo." />
    <div className="shell-page-body video-body">
      <div className="video-columns">
        <form className="video-form" onSubmit={submit}>
          <h2>Create a clip</h2>
          <fieldset disabled={running || pending || loadingImage}>
            <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose first frame"
              onChange={(event) => { void attach(event.target.files?.[0]); event.target.value = ""; }} />
            <div className="video-field">
              <span className="video-field-label" id="video-reference-label">First frame</span>
              <button type="button" className={`video-reference${reference ? " has-reference" : ""}`}
                aria-label={reference ? "Replace first frame" : "Choose first frame"}
                onClick={() => input.current?.click()} onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); void attach(event.dataTransfer.files[0]); }}>
                {reference ? <img alt="First frame cropped to the output dimensions" src={reference.dataUrl} /> :
                  <><ImagePlus size={21} aria-hidden="true" /><span>Choose or drop an image</span><small>PNG, JPEG, or WebP · up to 10 MB</small></>}
              </button>
              {reference ? <div className="video-reference-caption"><span title={reference.label}>{reference.label}</span>
                <Button variant="ghost" onClick={() => video.setReference(undefined)}>Remove</Button></div> : null}
            </div>
            <div className="video-field">
              <label htmlFor="video-prompt">Motion prompt</label>
              <Textarea id="video-prompt" value={video.prompt} onChange={(event) => video.setPrompt(event.target.value)}
                maxLength={2000} rows={4} placeholder="Describe how the subject and camera move…" />
            </div>
            <div className="video-format-row">
              {format && frames !== undefined ? <div className="video-field">
                <label htmlFor="video-duration">Duration</label>
                <Select id="video-duration" value={frames} onChange={video.setFrames} disabled={running || pending || loadingImage}
                  options={format.frameOptions.map((count) => ({ value: count,
                    label: `${(count / format.fps).toFixed(count === format.defaultFrames ? 2 : 0)} s`,
                  }))} />
              </div> : null}
              <div className="video-field">
                <label htmlFor="video-seed">Seed</label>
                <Input id="video-seed" value={video.seed} onChange={(event) => video.setSeed(event.target.value)}
                  type="number" inputMode="numeric" min={0} max={2147483647} step={1} required />
              </div>
            </div>
            <span className="video-status">{format ? `${format.width} × ${format.height} · ${format.fps} fps` : "544 × 704 · 1.31 s · 16 fps"}
              {format && frames !== format.defaultFrames ? " · Longer clips take more time and GPU memory." : ""}</span>
          </fieldset>
          {backendFailure ? <div className="video-setup">
            <ErrorMessage>{backendFailure.message}</ErrorMessage>
            {onRestartBackend && <Button onClick={() => {
              heading.current?.focus({ preventScroll: true });
              void onRestartBackend();
            }}>{backendFailure.stage === "running" ? "Restart local service" : "Retry starting Fern"}</Button>}
          </div> : serviceStatus ? <p role="status" className="video-status">{connectionError || serviceStatus}</p>
            : !model && !connectionError ? <p role="status" className="video-status">Checking local video model…</p> : null}
          {available && model && !model.runtimeReady ? <div className="video-setup">
            <p>{model.runtimeNote}</p>
            {model.platformSupported ? <Button onClick={openModels}>Open video models</Button> : null}
          </div> : null}
          {available && model?.runtimeReady && device === "CPU" ? <div className="video-setup">
            <p>Video generation requires Intel GPU. Select GPU in Preferences.</p>
            <Button onClick={openCompute}>Open compute settings</Button>
          </div> : null}
          {available && busyElsewhere && !running ? <p className="video-status">Finish or stop the active job to generate a video.</p> : null}
          {!backendFailure && !serviceStatus && (error || connectionError || job?.error)
            ? <ErrorMessage>{error || connectionError || job?.error}</ErrorMessage> : null}
          <div className="video-actions">
            {running ? <Button onClick={() => void video.update("stop")} disabled={!available || pending || job?.status === "stopping"}>
              <Square size={13} fill="currentColor" aria-hidden="true" /> Stop
            </Button> : <Button type="submit" variant="primary"
              disabled={!canGenerate || Boolean(connectionError) || !reference || !video.prompt.trim() || loadingImage}>
              Generate video
            </Button>}
            <span className="video-status" role="status">{loadingImage ? "Reading first frame…" : available && (running ? job?.phase
              : interrupted ? "Video generation was interrupted. Generate again to retry this clip."
              : job?.status === "cancelled" ? "Generation stopped." : "")}</span>
          </div>
        </form>

        <section className="video-results" aria-labelledby="video-preview-heading">
          <div className="video-results-header">
            <h2 id="video-preview-heading">Preview</h2>
            {clip ? <Button onClick={() => void exportClip()} disabled={saving}><Download size={15} aria-hidden="true" /> Save WebM</Button> : null}
          </div>
          {clip ? <>
            <div className="video-preview">
              <video key={clip.id} controls playsInline preload="metadata" src={resolveAssetUrl(clip.url)}
                poster={resolveAssetUrl(clip.posterUrl)} aria-label="Generated video" onError={() => setPlaybackError(clip.id)}
                onLoadedMetadata={() => setPlaybackError((previous) => previous === clip.id ? null : previous)} />
            </div>
            {available && playbackError === clip.id ? <ErrorMessage>Video playback failed. You can still save the file.</ErrorMessage> : null}
            <p className="video-clip-prompt">{clip.prompt}</p>
            <div className="video-clip-details">
              <span>{clip.width} × {clip.height} · {clip.duration.toFixed(2)} s · Seed {clip.seed}</span>
              <Button ref={deleteButton} variant="ghost" disabled={!available} onClick={() => setRemoving(clip.id)}>Delete</Button>
            </div>
            {removing === clip.id ? <InlineConfirmation confirmLabel="Delete clip" disabled={!available || pending}
              onCancel={() => { setRemoving(null); deleteButton.current?.focus(); }}
              onConfirm={async () => { await video.update("remove", { id: clip.id }); setRemoving(null); heading.current?.focus(); }}>
              Permanently delete this video from Fern?
            </InlineConfirmation> : null}
          </> : <div className="video-preview video-preview-empty">
            <Clapperboard size={24} strokeWidth={1.5} aria-hidden="true" />
            <span>{available && running ? "Rendering your first clip…" : "Generated clips appear here."}</span>
          </div>}
          {allClips.length > 0 ? <section className="video-history" aria-labelledby="video-history-heading">
            <h3 id="video-history-heading">Clips</h3>
            <div className="video-history-list">
              {allClips.map((item) => <button key={item.id} type="button" className="video-history-clip"
                aria-label={item.prompt} aria-pressed={clip?.id === item.id}
                onClick={() => { setSelected(item.id); setRemoving(null); }}>
                <img src={resolveAssetUrl(item.posterUrl)} alt="" loading="lazy" />
                <span title={item.prompt}>{item.prompt}</span>
              </button>)}
            </div>
          </section> : null}
        </section>
      </div>
    </div>
    {activity}
  </section>;
}
