import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import MoreHorizontal from "lucide-react/dist/esm/icons/ellipsis.mjs";
import Pause from "lucide-react/dist/esm/icons/pause.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Play from "lucide-react/dist/esm/icons/play.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Star from "lucide-react/dist/esm/icons/star.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/useModalFocus";
import { resolveAssetUrl } from "../lib/api";
import type { AudioOutput, AudioThread } from "../lib/ttsThreads";

type FeedFilter = "all" | "favorites" | "preset" | "clone" | "design";
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const voiceKind = (model?: AudioOutput["model"]) =>
  model?.startsWith("custom-") ? "preset" : model?.startsWith("base-") ? "clone" : model === "voice-design-1.7b" ? "design" : "unknown";
const filterOptions: Array<{ id: FeedFilter; label: string }> = [
  { id: "all", label: "All" }, { id: "favorites", label: "Favorites" },
  { id: "preset", label: "Preset" }, { id: "clone", label: "Clone" }, { id: "design", label: "Design" },
];

interface AudioFeedProps {
  jobProgress?: ReactNode;
  completion?: ReactNode;
  thread: AudioThread;
  revealTake: { name: string; token: number } | null;
  modelLabel: (output: AudioOutput) => string;
  generation: { running: boolean; logs: string[]; error: string | null };
  onUseText: (output: AudioOutput) => void;
  onReuseSetup: (output: AudioOutput) => string;
  onOpenComposer: () => void;
  onUpdateOutput: (name: string, patch: Partial<AudioOutput>) => void;
  onDeleteOutput: (name: string) => Promise<void>;
}

export function AudioFeed({ thread, revealTake, modelLabel, generation, jobProgress, completion, onUseText, onReuseSetup, onOpenComposer, onUpdateOutput, onDeleteOutput }: AudioFeedProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [limit, setLimit] = useState(12);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AudioOutput | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const players = useRef(new Map<string, HTMLAudioElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const handledRevealToken = useRef<number | null>(null);
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  useModalFocus(Boolean(deleteTarget), dialog, () => { if (!deleting) setDeleteTarget(null); });

  const numbered = useMemo(() => thread.outputs.map((output, index) => ({ output, number: thread.outputs.length - index })), [thread.outputs]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const matches = numbered.filter(({ output }) => {
      if (filter === "favorites" && !output.favorite) return false;
      if (filter !== "all" && filter !== "favorites" && voiceKind(output.model) !== filter) return false;
      return !term || [output.title, output.prompt, modelLabel(output), output.speaker, output.language]
        .some((value) => value?.toLocaleLowerCase().includes(term));
    });
    return sort === "oldest" ? [...matches].reverse() : matches;
  }, [filter, modelLabel, numbered, query, sort]);
  useEffect(() => {
    if (!revealTake || handledRevealToken.current === revealTake.token || !thread.outputs.some((output) => output.name === revealTake.name)) return;
    handledRevealToken.current = revealTake.token;
    setQuery(""); setFilter("all"); setSort("newest"); setLimit(Math.max(12, thread.outputs.findIndex((output) => output.name === revealTake.name) + 1));
    setPendingReveal(revealTake.name);
  }, [revealTake, thread.outputs]);
  useEffect(() => {
    if (!pendingReveal || !filtered.slice(0, limit).some(({ output }) => output.name === pendingReveal)) return;
    const frame = requestAnimationFrame(() => {
      const card = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-output-name]") ?? [])
        .find((item) => item.dataset.outputName === pendingReveal);
      card?.scrollIntoView({ block: "start", behavior: "smooth" });
      card?.querySelector<HTMLHeadingElement>("h4")?.focus({ preventScroll: true });
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) card?.animate([{ outline: "2px solid var(--accent)" }, { outline: "2px solid transparent" }], { duration: 1800 });
      setPendingReveal(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [filtered, limit, pendingReveal]);
  const favoriteCount = thread.outputs.filter((output) => output.favorite).length;
  const showNativeActions = typeof window.studio !== "undefined";

  const runAction = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); setNotice(success); }
    catch (caught) { setNotice(caught instanceof Error ? caught.message : "Could not complete that action."); }
  };

  const saveOutput = async (output: AudioOutput) => {
    try {
      if (showNativeActions) {
        const savedPath = await window.studio.saveOutputAudio(output.name);
        if (savedPath) setNotice(`Saved ${output.name}.`);
        return;
      }
      const response = await fetch(resolveAssetUrl(output.url));
      if (!response.ok) throw new Error("Could not download this WAV.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = output.name;
      document.body.append(link);
      setNotice("WAV download started.");
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Could not save this WAV."); }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await onDeleteOutput(deleteTarget.name);
      setNotice("Take moved to the Recycle Bin.");
      setDeleteTarget(null);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not delete this take.");
    } finally { setDeleting(false); }
  };

  return <section className="audio-feed" aria-label="Audio thread feed">
    <header className="audio-feed-header">
      <h3>Takes <span>{thread.outputs.length}</span></h3>
      <p>Listen, compare, and reuse.</p>
    </header>
    {completion}
    {jobProgress}

    {thread.outputs.length ? <div className="audio-feed-tools">
      <label className="audio-feed-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search takes</span><input type="search" value={query} placeholder="Search scripts or voices…" onChange={(event) => { setQuery(event.target.value); setLimit(12); }} /></label>
      <select aria-label="Sort takes" value={sort} onChange={(event) => setSort(event.target.value as "newest" | "oldest")}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
      <div className="audio-feed-filters" role="group" aria-label="Filter takes">
        {filterOptions.map((option) => <button key={option.id} type="button" aria-pressed={filter === option.id} onClick={() => { setFilter(option.id); setLimit(12); }}>{option.label}{option.id === "favorites" && favoriteCount ? ` ${favoriteCount}` : ""}</button>)}
      </div>
    </div> : null}

    {notice ? <div className="audio-feed-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">×</button></div> : null}

    {generation.running && !jobProgress ? <article className="audio-take audio-take--pending" role="status" aria-label="Generating a new take">
      <div className="audio-take-pending-icon"><AudioLines size={23} aria-hidden="true" /></div>
      <div><strong>Generating a new take</strong><p>Fern is preparing speech locally. The finished take will appear at the top of this feed.</p>
        <details><summary>View progress</summary><pre>{generation.logs.slice(-8).join("\n") || "Starting…"}</pre></details>
      </div>
    </article> : null}
    {generation.error ? <div className="audio-feed-failure" role="alert"><strong>Speech generation failed</strong><p>{generation.error}</p><span>Check the script and voice settings, then generate again.</span></div> : null}

    {!thread.outputs.length && !generation.running ? <div className="audio-feed-empty"><strong>No takes yet</strong><p>Write a script in the composer to create your first take.</p><button type="button" className="btn btn-secondary" onClick={onOpenComposer}>Write a script</button></div> : null}
    {thread.outputs.length && !filtered.length ? <div className="audio-feed-no-results"><strong>No matching takes</strong><p>Try another search or filter.</p><button type="button" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div> : null}

    <div className="audio-feed-list" ref={listRef}>
      {filtered.slice(0, limit).map(({ output, number }) => <AudioTakeCard
        key={output.name}
        output={output}
        number={number}
        featured={output.name === thread.outputs[0]?.name}
        modelLabel={modelLabel(output)}
        onUseText={() => onUseText(output)}
        onReuseSetup={() => setNotice(onReuseSetup(output))}
        onUpdate={(patch) => onUpdateOutput(output.name, patch)}
        onDelete={() => setDeleteTarget(output)}
        onSave={() => void saveOutput(output)}
        onPlay={(element) => { for (const other of players.current.values()) if (other !== element) other.pause(); }}
        registerPlayer={(element) => { if (element) players.current.set(output.name, element); else players.current.delete(output.name); }}
        nativeActions={showNativeActions}
        runAction={runAction}
      />)}
    </div>
    {filtered.length > limit ? <button type="button" className="btn btn-secondary audio-feed-more" onClick={() => setLimit((value) => value + 12)}>Show more takes ({filtered.length - limit} remaining)</button> : null}
    {deleteTarget ? createPortal(<div className="dialog-backdrop"><div className="delete-image-dialog" ref={dialog} role="alertdialog" aria-modal="true" aria-label="Delete audio take" tabIndex={-1}>
      <h3>Move this take to the Recycle Bin?</h3>
      <p>{deleteTarget.title?.trim() || deleteTarget.prompt.slice(0, 90) || deleteTarget.name}</p>
      <p>The WAV will leave this thread and move to the Windows Recycle Bin. Restoring the file later will not restore its thread card.</p>
      <div className="image-actions"><button type="button" className="btn btn-secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</button><button type="button" className="btn btn-danger" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "Moving…" : "Move to Recycle Bin"}</button></div>
    </div></div>, document.body) : null}
  </section>;
}

interface AudioTakeCardProps {
  output: AudioOutput;
  number: number;
  featured: boolean;
  modelLabel: string;
  onUseText: () => void;
  onReuseSetup: () => void;
  onUpdate: (patch: Partial<AudioOutput>) => void;
  onDelete: () => void;
  onSave: () => void;
  onPlay: (element: HTMLAudioElement) => void;
  registerPlayer: (element: HTMLAudioElement | null) => void;
  nativeActions: boolean;
  runAction: (action: () => Promise<unknown>, success: string) => Promise<void>;
}

function AudioTakeCard({ output, number, featured, modelLabel, onUseText, onReuseSetup, onUpdate, onDelete, onSave, onPlay, registerPlayer, nativeActions, runAction }: AudioTakeCardProps) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(output.duration || 0);
  const [menuUp, setMenuUp] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const title = output.title?.trim() || `Take ${number}`;
  const createdAt = new Date(output.createdAt);
  const validDate = !Number.isNaN(createdAt.getTime());
  const longScript = output.prompt.length > 240;
  const saveTitle = () => { onUpdate({ title: draftTitle.trim().slice(0, 80) || undefined }); setEditing(false); };
  const closeMenu = (element: HTMLElement) => { element.closest("details")?.removeAttribute("open"); };
  const togglePlayback = async () => {
    const player = audioRef.current;
    if (!player) return;
    if (!player.paused) { player.pause(); return; }
    setAudioError(null);
    setLoading(true);
    try {
      if (player.error) player.load();
      if (player.ended) player.currentTime = 0;
      await player.play();
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError"))
        setAudioError(caught instanceof DOMException && caught.name === "NotAllowedError" ? "Playback was blocked. Press Play to try again." : "Could not load this take. Retry playback or check the output folder.");
    } finally { setLoading(false); }
  };

  return <article className={`audio-take${featured ? " audio-take--featured" : ""}`} aria-label={title} data-output-name={output.name}>
    <header className="audio-take-header">
      <div className="audio-take-title-block">
        <span className="audio-take-number">{featured ? "LATEST" : String(number).padStart(2, "0")}</span>
        {editing ? <form className="audio-take-rename" onSubmit={(event) => { event.preventDefault(); saveTitle(); }}><input aria-label="Take name" autoFocus maxLength={80} value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }} /><button type="submit">Save</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></form>
          : <div className="audio-take-title"><h4 tabIndex={-1}>{title}</h4><button type="button" aria-label={`Rename ${title}`} title="Rename take" onClick={() => { setDraftTitle(output.title ?? ""); setEditing(true); }}><Pencil size={13} aria-hidden="true" /></button></div>}
        <time dateTime={validDate ? createdAt.toISOString() : undefined}>{validDate ? dateTime.format(createdAt) : "Unknown date"}</time>
      </div>
      <button type="button" className={`audio-take-favorite${output.favorite ? " is-favorite" : ""}`} aria-label={output.favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`} aria-pressed={!!output.favorite} title={output.favorite ? "Remove favorite" : "Favorite"} onClick={() => onUpdate({ favorite: !output.favorite })}><Star size={17} fill={output.favorite ? "currentColor" : "none"} aria-hidden="true" /></button>
    </header>
    <div className="audio-take-meta"><span>{modelLabel}</span>{output.device ? <span>{output.device === "CPU" ? "CPU" : "Intel GPU"}</span> : null}{output.generationSeconds != null ? <span>Generated in {formatDuration(output.generationSeconds)}</span> : null}<span>{output.language && output.language !== "Auto" ? output.language : "Auto language"}</span>{output.speaker && voiceKind(output.model) === "preset" ? <span>{output.speaker.replaceAll("_", " ")}</span> : null}</div>
    <div className="audio-take-script"><span>Spoken text</span><p className={!expanded && longScript ? "is-clamped" : ""}>{output.prompt || "No script saved for this take."}</p>{longScript ? <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? "Show less" : "Show full script"}</button> : null}</div>
    <div className="audio-take-player">
      <div className="audio-take-transport">
        <button type="button" className="audio-take-play" disabled={loading} aria-busy={loading} aria-label={`${playing ? "Pause" : "Play"} ${title}`} onClick={() => void togglePlayback()}>
          {playing ? <Pause size={16} fill="currentColor" aria-hidden="true" /> : <Play size={16} fill="currentColor" aria-hidden="true" />}
        </button>
        <span className="audio-take-time">{formatDuration(position)}</span>
        <input type="range" min={0} max={Math.max(duration, 0.1)} step="0.1" value={Math.min(position, Math.max(duration, 0.1))}
          aria-label={`Seek ${title}`} onChange={(event) => {
            const next = Number(event.target.value);
            if (audioRef.current) audioRef.current.currentTime = next;
            setPosition(next);
          }} style={{ "--audio-progress": `${duration ? (position / duration) * 100 : 0}%` } as CSSProperties} />
        <span className="audio-take-time">{formatDuration(duration)}</span>
      </div>
      <audio preload="metadata" src={resolveAssetUrl(output.url, output.createdAt)}
        ref={(element) => { audioRef.current = element; registerPlayer(element); }}
        onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
        onCanPlay={() => { setAudioError(null); setLoading(false); }} onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onPlay={(event) => { setPlaying(true); onPlay(event.currentTarget); }} onPause={() => setPlaying(false)}
        onEnded={(event) => { setPlaying(false); setPosition(event.currentTarget.duration); }} onError={() => { setLoading(false); setAudioError("Could not load this take. Retry playback or check the output folder."); }} />
    </div>
    {audioError ? <div className="audio-take-error" role="alert"><span>{audioError}</span><button type="button" className="btn btn-secondary" onClick={() => void togglePlayback()}>Retry playback</button></div> : null}
    <footer className="audio-take-actions">
      <button type="button" className="btn btn-secondary" onClick={onReuseSetup}>Use setup</button>
      <button type="button" className="btn btn-secondary" onClick={onSave}><Download size={14} aria-hidden="true" /> Download</button>
      <details className={`audio-take-menu${menuUp ? " is-up" : ""}`} onToggle={(event) => {
        if (!event.currentTarget.open) return;
        const feed = event.currentTarget.closest<HTMLElement>(".audio-feed");
        const scrollport = feed && getComputedStyle(feed).overflowY === "auto" ? feed : event.currentTarget.closest<HTMLElement>(".dashboard--tts");
        const viewport = scrollport?.getBoundingClientRect();
        const summary = event.currentTarget.querySelector("summary")?.getBoundingClientRect();
        const menu = event.currentTarget.querySelector(".audio-take-menu-items")?.getBoundingClientRect();
        if (viewport && summary && menu) setMenuUp(viewport.bottom - summary.bottom < menu.height + 8 && summary.top - viewport.top > viewport.bottom - summary.bottom);
      }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
        <summary className="btn btn-secondary" aria-label={`More actions for ${title}`}><MoreHorizontal size={16} aria-hidden="true" /> More</summary>
        <div className="audio-take-menu-items">
          <button type="button" onClick={(event) => { closeMenu(event.currentTarget); onUseText(); }}>Use script only</button>
          <button type="button" onClick={(event) => { closeMenu(event.currentTarget); void runAction(() => nativeActions ? window.studio.copyText(output.prompt) : navigator.clipboard.writeText(output.prompt), "Script copied."); }}><Copy size={13} aria-hidden="true" /> Copy script</button>
          {nativeActions ? <><button type="button" onClick={(event) => { closeMenu(event.currentTarget); void runAction(() => window.studio.openOutputAudio(output.name), "Opened WAV."); }}>Open in default app</button><button type="button" onClick={(event) => { closeMenu(event.currentTarget); void runAction(() => window.studio.revealOutputAudio(output.name), "Opened output folder."); }}><FolderOpen size={13} aria-hidden="true" /> Show in folder</button><button type="button" className="danger-text" onClick={(event) => { closeMenu(event.currentTarget); onDelete(); }}><Trash2 size={13} aria-hidden="true" /> Delete take</button></> : null}
        </div>
      </details>
    </footer>
  </article>;
}
