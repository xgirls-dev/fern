import { trashName } from "../lib/trash";
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
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { resolveAssetUrl } from "../lib/api";
import type { AudioOutput, AudioThread } from "../lib/ttsThreads";
import { Button, IconButton, Input, SegmentedControl, Select } from "./ui/controls";
import { Slider } from "./ui/Slider";
import { Dialog, DialogDescription, DialogTitle } from "./ui/Dialog";
import { Disclosure } from "./ui/Disclosure";
import { Dropdown, DropdownItem, DropdownSeparator, useDropdownActions } from "./ui/Dropdown";
import { TooltipIconButton, TooltipScope } from "./ui/Tooltip";

type FeedFilter = "all" | "favorites" | "preset" | "clone" | "design";
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatDuration = (seconds: number, tenths = false) => {
  if (!Number.isFinite(seconds)) return "—";
  const ticks = Math.max(0, Math.round(seconds * (tenths ? 10 : 1)));
  const total = tenths ? Math.floor(ticks / 10) : ticks;
  const fraction = tenths && ticks % 10 ? `.${ticks % 10}` : "";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}${fraction}`;
};
const voiceKind = (model?: AudioOutput["model"]) =>
  model?.startsWith("custom-") ? "preset" : model?.startsWith("base-") ? "clone" : model === "voice-design-1.7b" ? "design" : "unknown";
const filterOptions: Array<{ id: FeedFilter; label: string }> = [
  { id: "all", label: "All" }, { id: "favorites", label: "Favorites" },
  { id: "preset", label: "Preset" }, { id: "clone", label: "Clone" }, { id: "design", label: "Design" },
];

interface AudioFeedProps {
  diagnostics?: ReactNode;
  completion?: ReactNode;
  thread: AudioThread;
  revealTake: { name: string; token: number } | null;
  modelLabel: (output: AudioOutput) => string;
  generating: boolean;
  onUseText: (output: AudioOutput) => void;
  onReuseSetup: (output: AudioOutput) => string;
  onOpenComposer: () => void;
  setupNeeded?: boolean;
  setupUnavailable?: string | null;
  onUpdateOutput: (name: string, patch: Partial<AudioOutput>) => void;
  onDeleteOutput: (name: string) => Promise<void>;
}

export function AudioFeed({ thread, revealTake, modelLabel, generating, diagnostics, completion, onUseText, onReuseSetup, onOpenComposer, setupNeeded, setupUnavailable, onUpdateOutput, onDeleteOutput }: AudioFeedProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [limit, setLimit] = useState(12);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AudioOutput | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const feedHeading = useRef<HTMLHeadingElement>(null);
  const players = useRef(new Map<string, HTMLAudioElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const handledRevealToken = useRef<number | null>(null);
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);

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
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      card?.scrollIntoView({ block: "start", behavior: reduce ? "instant" : "smooth" });
      card?.querySelector<HTMLButtonElement>(".audio-take-play")?.focus({ preventScroll: true });
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
    const visibleTakes = filtered.slice(0, limit);
    const index = visibleTakes.findIndex(({ output }) => output.name === deleteTarget.name);
    const neighborName = (visibleTakes[index + 1] ?? visibleTakes[index - 1])?.output.name;
    setDeleting(true);
    setDeleteError("");
    try {
      await onDeleteOutput(deleteTarget.name);
      setNotice(`Take moved to ${trashName}.`);
      setDeleteTarget(null);
      requestAnimationFrame(() => {
        const nextPlay = neighborName && listRef.current?.querySelector<HTMLButtonElement>(
          `[data-output-name="${CSS.escape(neighborName)}"] .audio-take-play`,
        );
        (nextPlay || feedHeading.current)?.focus({ preventScroll: true });
      });
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "Could not delete this take.");
    } finally { setDeleting(false); }
  };

  return <section className="audio-feed" aria-label="Audio thread feed">
    <header className="audio-feed-header">
      <h3 ref={feedHeading} tabIndex={-1}>Takes <span>{thread.outputs.length}</span></h3>
      <p>Listen, compare, and reuse.</p>
    </header>
    {completion}
    {diagnostics}

    {thread.outputs.length > 1 || query || filter !== "all" ? <div className="audio-feed-tools">
      <label className="audio-feed-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search takes</span><Input type="search" value={query} placeholder="Search scripts or voices…" onChange={(event) => { setQuery(event.target.value); setLimit(12); }} /></label>
      <Select<"newest" | "oldest"> aria-label="Sort takes" value={sort} onChange={setSort}
        options={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]} />
      <SegmentedControl
        className="audio-feed-filters"
        label="Filter takes"
        value={filter}
        options={filterOptions.map((option) => ({
          value: option.id,
          label: option.id === "favorites" && favoriteCount ? `${option.label} ${favoriteCount}` : option.label,
        }))}
        onChange={(value) => { setFilter(value); setLimit(12); }}
      />
    </div> : null}

    {notice ? <div className="audio-feed-notice" role="status"><span>{notice}</span><IconButton aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={15} aria-hidden="true" /></IconButton></div> : null}

    {generating ? <article className="audio-take audio-take--pending">
      <div className="audio-take-pending-icon"><AudioLines size={23} aria-hidden="true" /></div>
      <span>The new take will appear here.</span>
    </article> : null}

    {!thread.outputs.length && !generating ? <div className="audio-feed-empty">
      <strong>No takes yet</strong>
      <p>{setupUnavailable ?? (setupNeeded ? "Set up a voice model in the composer to create your first take." : "Your first take will appear here.")}</p>
      {!setupUnavailable && !setupNeeded ? <Button variant="secondary" onClick={onOpenComposer}>Write a script</Button> : null}
    </div> : null}
    {thread.outputs.length && !filtered.length ? <div className="audio-feed-no-results"><strong>No matching takes</strong><p>Try another search or filter.</p><Button variant="ghost" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</Button></div> : null}

    <TooltipScope><div className="audio-feed-list" ref={listRef}>
      {filtered.slice(0, limit).map(({ output, number }) => <AudioTakeCard
        key={output.name}
        output={output}
        number={number}
        featured={output.name === thread.outputs[0]?.name}
        modelLabel={modelLabel(output)}
        onUseText={() => onUseText(output)}
        onReuseSetup={() => setNotice(onReuseSetup(output))}
        onUpdate={(patch) => onUpdateOutput(output.name, patch)}
        onDelete={(trigger) => {
          deleteTrigger.current = trigger;
          setDeleteError("");
          setDeleteTarget(output);
        }}
        onSave={() => void saveOutput(output)}
        onPlay={(element) => { for (const other of players.current.values()) if (other !== element) other.pause(); }}
        registerPlayer={(element) => { if (element) players.current.set(output.name, element); else players.current.delete(output.name); }}
        nativeActions={showNativeActions}
        runAction={runAction}
      />)}
    </div></TooltipScope>
    {filtered.length > limit ? <Button className="audio-feed-more" onClick={() => setLimit((value) => value + 12)}>Show more takes ({filtered.length - limit} remaining)</Button> : null}
    {deleteTarget && <Dialog alert initialFocus={cancelDelete} finalFocus={deleteTrigger}
      onClose={() => { if (!deleting) setDeleteTarget(null); }}>
      <DialogTitle>Move this take to {trashName}?</DialogTitle>
      <DialogDescription>
        <strong>{deleteTarget.title?.trim() || deleteTarget.prompt.slice(0, 90) || deleteTarget.name}</strong>
        The WAV will leave this thread and move to {trashName}. Restoring the file later will not restore its thread card.
      </DialogDescription>
      {deleteError && <p role="alert">{deleteError}</p>}
      <div className="ui-dialog-actions">
        <Button ref={cancelDelete} variant="secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button>
        <Button variant="danger" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "Moving…" : `Move to ${trashName}`}</Button>
      </div>
    </Dialog>}
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
  onDelete: (trigger: HTMLButtonElement) => void;
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
  const { trigger, choose, menuProps } = useDropdownActions({ dismissOnResize: true });
  const renameButton = useRef<HTMLButtonElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const title = output.title?.trim() || `Take ${number}`;
  const createdAt = new Date(output.createdAt);
  const validDate = !Number.isNaN(createdAt.getTime());
  const longScript = output.prompt.length > 240;
  const finishRenaming = () => {
    setEditing(false);
    requestAnimationFrame(() => renameButton.current?.focus({ preventScroll: true }));
  };
  const saveTitle = () => { onUpdate({ title: draftTitle.trim().slice(0, 80) || undefined }); finishRenaming(); };
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

        {editing ? <form className="audio-take-rename" onSubmit={(event) => { event.preventDefault(); saveTitle(); }}>
          <Input aria-label="Take name" autoFocus maxLength={80} value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); finishRenaming(); } }} />
          <Button type="submit" variant="secondary">Save</Button><Button type="button" variant="ghost" onClick={finishRenaming}>Cancel</Button>
        </form> : <div className="audio-take-title"><h4 tabIndex={-1}>{title}</h4>
          <TooltipIconButton ref={renameButton} aria-label={`Rename ${title}`} tooltip="Rename take"
            onClick={() => { setDraftTitle(output.title ?? ""); setEditing(true); }}><Pencil size={13} aria-hidden="true" /></TooltipIconButton>
        </div>}
        <time dateTime={validDate ? createdAt.toISOString() : undefined}>{featured ? "Latest · " : ""}{validDate ? dateTime.format(createdAt) : "Unknown date"}</time>
      </div>
      <TooltipIconButton className={`audio-take-favorite${output.favorite ? " is-favorite" : ""}`}
        aria-label={output.favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
        aria-pressed={!!output.favorite} tooltip={output.favorite ? "Remove favorite" : "Favorite"}
        onClick={() => onUpdate({ favorite: !output.favorite })}><Star size={17} fill={output.favorite ? "currentColor" : "none"} aria-hidden="true" /></TooltipIconButton>
    </header>
    <div className="audio-take-player">
      <div className="audio-take-transport">
        <IconButton variant="primary" shape="circle" className="audio-take-play" disabled={loading} aria-busy={loading} aria-label={`${playing ? "Pause" : "Play"} ${title}`} onClick={() => void togglePlayback()}>
          {playing ? <Pause size={16} fill="currentColor" aria-hidden="true" /> : <Play size={16} fill="currentColor" aria-hidden="true" />}
        </IconButton>
        <span className="audio-take-time">{formatDuration(position)}</span>
        <Slider compact min={0} max={Math.max(duration, 0.1)} step={0.1} value={Math.min(position, Math.max(duration, 0.1))}
          aria-label={`Seek ${title}`} aria-valuetext={`${formatDuration(position, true)} of ${formatDuration(duration, true)}`} onChange={(next) => {
            if (audioRef.current) audioRef.current.currentTime = next;
            setPosition(next);
          }} />
        <span className="audio-take-time">{formatDuration(duration)}</span>
      </div>
      <audio preload="metadata" src={resolveAssetUrl(output.url, output.createdAt)}
        ref={(element) => { audioRef.current = element; registerPlayer(element); }}
        onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
        onCanPlay={() => { setAudioError(null); setLoading(false); }} onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onPlay={(event) => { setPlaying(true); onPlay(event.currentTarget); }} onPause={() => setPlaying(false)}
        onEnded={(event) => { setPlaying(false); setPosition(event.currentTarget.duration); }} onError={() => { setLoading(false); setAudioError("Could not load this take. Retry playback or check the output folder."); }} />
    </div>
    {audioError ? <div className="audio-take-error" role="alert"><span>{audioError}</span><Button variant="secondary" onClick={() => void togglePlayback()}>Retry playback</Button></div> : null}
    <Disclosure className="audio-take-provenance" label="Script and voice settings">
        <div className="audio-take-meta"><span>{modelLabel}</span>{output.device ? <span>{output.device === "CPU" ? "CPU" : "Intel GPU"}</span> : null}{output.generationSeconds != null ? <span>Generated in {formatDuration(output.generationSeconds)}</span> : null}<span>{output.language && output.language !== "Auto" ? output.language : "Auto language"}</span>{output.speaker && voiceKind(output.model) === "preset" ? <span>{output.speaker.replaceAll("_", " ")}</span> : null}</div>
        <div className="audio-take-script"><span>Spoken text</span><p className={!expanded && longScript ? "is-clamped" : ""}>{output.prompt || "No script saved for this take."}</p>{longScript ? <Button variant="ghost" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? "Show less" : "Show full script"}</Button> : null}</div>
    </Disclosure>
    <footer className="audio-take-actions">
      <Button variant="secondary" onClick={onReuseSetup}>Use setup</Button>
      <Button variant="secondary" onClick={onSave}><Download size={14} aria-hidden="true" /> Save audio as…</Button>
      <Dropdown {...menuProps} label={`Actions for ${title}`} align="end" className="audio-take-menu" triggerTooltip="Take actions"
        trigger={<IconButton ref={trigger} className="audio-take-menu-trigger" aria-label={`More actions for ${title}`}>
          <MoreHorizontal size={16} aria-hidden="true" />
        </IconButton>}>
        <DropdownItem onClick={() => choose(onUseText)}>Use script only</DropdownItem>
        <DropdownItem onClick={() => choose(() => void runAction(
          () => nativeActions ? window.studio.copyText(output.prompt) : navigator.clipboard.writeText(output.prompt), "Script copied.",
        ))}><Copy size={13} aria-hidden="true" /><span>Copy script</span></DropdownItem>
        {nativeActions && <>
          <DropdownItem onClick={() => choose(() => void runAction(() => window.studio.openOutputAudio(output.name), "Opened WAV."))}>
            Open in default app
          </DropdownItem>
          <DropdownItem onClick={() => choose(() => void runAction(() => window.studio.revealOutputAudio(output.name), "Opened output folder."))}>
            <FolderOpen size={13} aria-hidden="true" /><span>Show in folder</span>
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem destructive onClick={() => choose(() => { if (trigger.current) onDelete(trigger.current); })}>
            <Trash2 size={13} aria-hidden="true" /><span>Delete take</span>
          </DropdownItem>
        </>}
      </Dropdown>
    </footer>
  </article>;
}
