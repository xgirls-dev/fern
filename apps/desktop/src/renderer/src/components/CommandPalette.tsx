import Clapperboard from "lucide-react/dist/esm/icons/clapperboard.mjs";
import Command from "lucide-react/dist/esm/icons/command.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import HardDrive from "lucide-react/dist/esm/icons/hard-drive.mjs";
import Images from "lucide-react/dist/esm/icons/images.mjs";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogTitle } from "./ui/Dialog";
import { SearchDialogField } from "./ui/SearchDialogField";
import { shortcutLabel, shortcuts } from "../lib/workspaceNavigation";
import { commandSearchRank, indexPaletteThreads, normalizeCommandSearch, searchPaletteThreads, type PaletteThread } from "../lib/commandSearch";
import { isComposingKey } from "../lib/keyboard";
import type { TranscriptDestination } from "../lib/textTranscript";

interface CommandPaletteProps {
  running: boolean;
  audioRunning: boolean;
  videoRunning: boolean;
  onOpenVideo: () => void;
  onStopVideo: () => void;
  textRunning: boolean;
  textModelLoading: boolean;
  threads: readonly PaletteThread[];
  onOpenThread: (id: string) => void;
  onOpenThreadSearch: (query: string) => void;
  sidebarCollapsed: boolean;
  onClose: () => void;
  onNewRender: () => void;
  onNewAudio: () => void;
  onNewText: () => void;
  onOpenAudio: () => void;
  onOpenText: () => void;
  onExportChat?: (destination: TranscriptDestination) => void;
  onOpenLibrary: () => void;
  onOpenData: () => void;
  onOpenPreferences: () => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onStop: () => void;
  onStopAudio: () => void;
  onStopText: () => void;
}

interface PaletteAction {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

export function CommandPalette({
  running,
  audioRunning,
  videoRunning,
  onOpenVideo,
  onStopVideo,
  textRunning,
  textModelLoading,
  threads,
  onOpenThread,
  onOpenThreadSearch,
  sidebarCollapsed,
  onClose,
  onNewRender,
  onNewAudio,
  onNewText,
  onOpenAudio,
  onOpenText,
  onExportChat,
  onOpenLibrary,
  onOpenData,
  onOpenPreferences,
  onToggleTheme,
  onToggleSidebar,
  onStop,
  onStopAudio,
  onStopText,
}: CommandPaletteProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyboardNavigation = useRef(false);
  const restoringFocus = useRef(true);
  const finalFocus = useCallback(() => restoringFocus.current, []);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const threadIndex = useMemo(() => indexPaletteThreads(threads), [threads]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }), []);

  const actions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "new-render",
        label: shortcuts.image.label,
        description: "Start a new image generation thread",
        shortcut: shortcutLabel(shortcuts.image),
        icon: <Sparkles size={16} aria-hidden="true" />,
        onSelect: onNewRender,
      },
      { id: "new-audio", label: shortcuts.speech.label, description: "Start a Qwen3-TTS thread", shortcut: shortcutLabel(shortcuts.speech), icon: <AudioLines size={16} aria-hidden="true" />, onSelect: onNewAudio },
      { id: "open-audio", label: "Open audio workspace", description: "Return to the selected audio thread", icon: <AudioLines size={16} aria-hidden="true" />, onSelect: onOpenAudio },
      { id: "new-text", label: shortcuts.chat.label, description: "Start a local conversation", shortcut: shortcutLabel(shortcuts.chat), icon: <MessageSquare size={16} aria-hidden="true" />, onSelect: onNewText },
      { id: "open-text", label: "Open current chat", description: "Focus the draft in the selected chat", icon: <MessageSquare size={16} aria-hidden="true" />, onSelect: onOpenText },
      ...(onExportChat ? [
        { id: "copy-chat", label: "Copy chat transcript", description: "Copy this conversation as Markdown", icon: <Copy size={16} aria-hidden="true" />, onSelect: () => onExportChat("clipboard") },
        { id: "save-chat", label: "Save chat as Markdown", description: "Write this conversation to a local file", icon: <Download size={16} aria-hidden="true" />, onSelect: () => onExportChat("file") },
      ] : []),
      {
        id: "library",
        label: shortcuts.images.label,
        description: "Browse recent renders",
        shortcut: shortcutLabel(shortcuts.images),
        icon: <Images size={16} aria-hidden="true" />,
        onSelect: onOpenLibrary,
      },
      { id: "video", label: "Open Video", description: "Animate an image or browse saved clips", icon: <Clapperboard size={16} aria-hidden="true" />, onSelect: onOpenVideo },
      { id: "models", label: "Manage models", description: "Install image, text, audio, and video models", icon: <Images size={16} aria-hidden="true" />, onSelect: () => window.dispatchEvent(new CustomEvent("fern-models")) },
      {
        id: "toggle-sidebar",
        label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
        description: "Change the workspace layout",
        shortcut: shortcutLabel(shortcuts.sidebar),
        icon: <PanelLeft size={16} aria-hidden="true" />,
        onSelect: onToggleSidebar,
      },
      {
        id: "toggle-theme",
        label: "Toggle appearance",
        description: "Switch between dark and light mode",
        icon: <Command size={16} aria-hidden="true" />,
        onSelect: onToggleTheme,
      },
      {
        id: "local-data",
        label: "Manage local data",
        description: "Review storage, cache, and model usage",
        icon: <HardDrive size={16} aria-hidden="true" />,
        onSelect: onOpenData,
      },
      {
        id: "preferences",
        label: "Open preferences",
        description: "Appearance, layout, runtime, and shortcuts",
        icon: <Settings2 size={16} aria-hidden="true" />,
        onSelect: onOpenPreferences,
      },
      ...(running
        ? [
            {
              id: "stop-generation",
              label: "Stop generation",
              description: "Cancel the current render",
              icon: <Square size={16} fill="currentColor" aria-hidden="true" />,
              onSelect: onStop,
            },
          ]
        : []),
      ...(videoRunning ? [{ id: "stop-video", label: "Stop video generation", description: "Cancel the active video render", icon: <Square size={16} fill="currentColor" aria-hidden="true" />, onSelect: onStopVideo }] : []),
      ...(audioRunning ? [{ id: "stop-audio", label: "Stop audio job", description: "Cancel Qwen3-TTS setup or generation", icon: <Square size={16} fill="currentColor" aria-hidden="true" />, onSelect: onStopAudio }] : []),
      ...(textRunning ? [{ id: "stop-text", label: textModelLoading ? "Cancel model load" : "Stop text generation",
        description: textModelLoading ? "Stop loading the local chat model" : "Stop the active local LLM response",
        icon: <Square size={16} fill="currentColor" aria-hidden="true" />, onSelect: onStopText }] : []),
    ],
    [
      onNewRender,
      onNewAudio,
      onOpenAudio,
      onOpenLibrary,
      onToggleSidebar,
      onToggleTheme,
      onOpenData,
      onOpenPreferences,
      onStop,
      onStopAudio,
      onNewText,
      onOpenText,
      onExportChat,
      onStopText,
      running,
      audioRunning,
      videoRunning,
      onOpenVideo,
      onStopVideo,
      textRunning,
      textModelLoading,
      sidebarCollapsed,
    ],
  );

  const normalized = normalizeCommandSearch(query);
  const groups = useMemo(() => {
    const words = normalized ? normalized.split(" ") : [];
    const commands = normalized
      ? actions.map((action) => ({
          action,
          rank: commandSearchRank(normalized, words, normalizeCommandSearch(action.label), normalizeCommandSearch(action.description)),
        })).filter(({ rank }) => rank > 0).sort((a, b) => b.rank - a.rank)
      : actions.map((action) => ({ action, rank: 0 }));
    const matches = normalized
      ? searchPaletteThreads(threadIndex.entries, normalized, words, 20)
      : { entries: threadIndex.entries.slice(0, 3), bestRank: 1 };

    const recentThreads: PaletteAction[] = matches.entries.map(({ thread, title, body, excerpt, summaryKey }) => {
      const kind = thread.id.startsWith("text-thread-") ? "Chat" : thread.id.startsWith("audio-thread-") ? "Speech" : "Image";
      const Icon = kind === "Chat" ? MessageSquare : kind === "Speech" ? AudioLines : Images;
      const date = new Date(thread.updatedAt);
      const duplicate = (threadIndex.titles.get(thread.title) ?? 0) > 1;
      const bodyMatch = words.some((word) => !title.includes(word) && body.includes(word));
      const showId = (threadIndex.summaries.get(summaryKey) ?? 0) > 1;
      const description = [
        kind, thread.folderPath, duplicate || bodyMatch ? excerpt : undefined,
        (duplicate || !bodyMatch) && Number.isFinite(date.getTime()) ? dateFormatter.format(date) : undefined,
        showId ? thread.id.slice(-6) : undefined,
      ].filter(Boolean).join(" · ");
      return { id: `thread-${thread.id}`, label: thread.title, description, icon: <Icon size={16} aria-hidden="true" />, onSelect: () => onOpenThread(thread.id) };
    });
    const commandsGroup = { label: "Commands", actions: commands.map(({ action }) => action) };
    const recentGroup = { label: "Recent threads", actions: recentThreads };
    const result = matches.bestRank > (commands[0]?.rank ?? 0)
      ? [recentGroup, commandsGroup]
      : [commandsGroup, recentGroup];
    return result.filter((group) => group.actions.length);
  }, [actions, dateFormatter, normalized, onOpenThread, threadIndex]);
  const searchAllThreads = useMemo<PaletteAction>(() => ({
    id: "search-all-threads",
    label: "Search all threads",
    description: "Search chat messages and archived threads",
    icon: <Search size={16} aria-hidden="true" />,
    onSelect: () => onOpenThreadSearch(query.trim()),
  }), [onOpenThreadSearch, query]);
  const resultGroups = useMemo(() => normalized
    ? [...groups, { label: "Thread search", actions: [searchAllThreads] }]
    : groups, [groups, normalized, searchAllThreads]);
  const filteredActions = useMemo(() => resultGroups.flatMap((group) => group.actions), [resultGroups]);
  const selectedIndex = Math.max(0, filteredActions.findIndex((action) => action.id === activeId));
  const selected = filteredActions[selectedIndex];

  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);
  useLayoutEffect(() => {
    if (!keyboardNavigation.current) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !row) return;
    const listBounds = list.getBoundingClientRect();
    const selectedBounds = row.getBoundingClientRect();
    if (selectedBounds.top < listBounds.top) list.scrollTop -= listBounds.top - selectedBounds.top;
    else if (selectedBounds.bottom > listBounds.bottom) list.scrollTop += selectedBounds.bottom - listBounds.bottom;
  }, [selected, filteredActions]);

  const selectAction = (action: PaletteAction | undefined) => {
    if (!action) return;
    if (action.id === "open-text") {
      // The chat focuses its draft after the palette unmounts in this commit.
      restoringFocus.current = false;
      onClose();
      action.onSelect();
      return;
    }
    onClose();
    window.setTimeout(action.onSelect, 0);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event.nativeEvent) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      keyboardNavigation.current = true;
      const next = selectedIndex + (event.key === "ArrowDown" ? 1 : -1);
      setActiveId(filteredActions[Math.max(0, Math.min(next, filteredActions.length - 1))]?.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectAction(selected);
    }
  };

  return (
    <Dialog variant="search" onClose={onClose} initialFocus={searchRef} finalFocus={finalFocus}>
      <DialogTitle className="sr-only">Commands</DialogTitle>
      <SearchDialogField
        closeLabel="Close commands"
        ref={searchRef}
        value={query}
        onChange={(event) => {
          keyboardNavigation.current = false;
          setQuery(event.target.value);
          setActiveId(undefined);
        }}
        onKeyDown={onSearchKeyDown}
        placeholder="Search commands or threads…"
        aria-label="Search commands or threads"
        role="combobox"
        aria-expanded="true"
        aria-controls="fern-command-options"
        aria-autocomplete="list"
        aria-activedescendant={selected ? `command-${selected.id}` : undefined}
      />

      <div
        ref={listRef}
        className="command-palette-list"
        id="fern-command-options"
        role="listbox"
        aria-label="Commands and threads"
        tabIndex={-1}
      >
        {resultGroups.map((group) => <div key={group.label} role="group" aria-label={group.label}>
          {group.label !== "Thread search" && <div className="command-palette-group-label" aria-hidden="true">{group.label}</div>}
          {group.actions.map((action) => (
            <button
              key={action.id}
              id={`command-${action.id}`}
              tabIndex={-1}
              type="button"
              className="command-palette-action"
              role="option"
              aria-selected={action.id === selected?.id}
              onMouseMove={() => { keyboardNavigation.current = false; setActiveId(action.id); }}
              onClick={() => selectAction(action)}
            >
              <span className="command-palette-icon">{action.icon}</span>
              <span className="command-palette-copy">
                <strong title={action.label}>{action.label}</strong>
                <small>{action.description}</small>
              </span>
              {action.shortcut && <span className="command-palette-shortcut">{action.shortcut}</span>}
            </button>
          ))}
        </div>)}
      </div>

      <footer className="command-palette-footer">
        <span>
          <span className="kbd">↑</span>
          <span className="kbd">↓</span> Navigate
        </span>
        <span>
          <span className="kbd">↵</span> Open result
        </span>
        <span>
          <span className="kbd">Esc</span> Close
        </span>
      </footer>
    </Dialog>
  );
}
