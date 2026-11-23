import Clapperboard from "lucide-react/dist/esm/icons/clapperboard.mjs";
import ArrowDownUp from "lucide-react/dist/esm/icons/arrow-down-up.mjs";
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
import X from "lucide-react/dist/esm/icons/x.mjs";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogClose, DialogTitle } from "./ui/Dialog";
import { IconButton, Input } from "./ui/controls";
import { shortcutLabel, shortcuts } from "../lib/workspaceNavigation";
import type { TranscriptDestination } from "../lib/textTranscript";

interface CommandPaletteProps {
  open: boolean;
  running: boolean;
  audioRunning: boolean;
  videoRunning: boolean;
  onOpenVideo: () => void;
  onStopVideo: () => void;
  textRunning: boolean;
  threads: Array<{ id: string; title: string; updatedAt: number; archived?: boolean; excerpt?: string; folderPath?: string }>;
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
  open,
  running,
  audioRunning,
  videoRunning,
  onOpenVideo,
  onStopVideo,
  textRunning,
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
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useLayoutEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

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
      { id: "open-text", label: "Open current chat", description: "Return to the selected chat", icon: <MessageSquare size={16} aria-hidden="true" />, onSelect: onOpenText },
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
      ...(textRunning ? [{ id: "stop-text", label: "Stop text generation", description: "Stop the active local LLM response", icon: <Square size={16} fill="currentColor" aria-hidden="true" />, onSelect: onStopText }] : []),
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
      sidebarCollapsed,
    ],
  );

  const normalized = query.trim().toLowerCase();
  const searchAllThreads: PaletteAction = {
    id: "search-all-threads",
    label: "Search all threads",
    description: "Filter by type or find archived work",
    icon: <Search size={16} aria-hidden="true" />,
    onSelect: () => onOpenThreadSearch(query.trim()),
  };
  const matchingCommands = actions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(normalized));
  const recentThreads: PaletteAction[] = open ? threads
    .filter((thread) => !thread.archived && `${thread.title} ${thread.folderPath ?? ""} ${thread.excerpt ?? ""}`.toLowerCase().includes(normalized))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, normalized ? 20 : 6)
    .map((thread) => {
      const kind = thread.id.startsWith("text-thread-") ? "Chat" : thread.id.startsWith("audio-thread-") ? "Speech" : "Image";
      const Icon = kind === "Chat" ? MessageSquare : kind === "Speech" ? AudioLines : Images;
      const date = Number.isFinite(thread.updatedAt) ? new Date(thread.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
      const duplicate = threads.some((other) => other.id !== thread.id && !other.archived && other.title === thread.title);
      const excerpt = thread.excerpt?.trim().replace(/\s+/g, " ").slice(0, 90);
      const description = [kind, thread.folderPath, duplicate && excerpt ? excerpt : date].filter(Boolean).join(" · ");
      const duplicateDate = duplicate && threads.some((other) => other.id !== thread.id && !other.archived &&
        other.title === thread.title && other.excerpt?.trim() === thread.excerpt?.trim() &&
        Math.floor(other.updatedAt / 60_000) === Math.floor(thread.updatedAt / 60_000));
      return { id: `thread-${thread.id}`, label: thread.title, description: duplicateDate ? `${description} · ${thread.id.slice(-6)}` : description, icon: <Icon size={16} aria-hidden="true" />, onSelect: () => onOpenThread(thread.id) };
    }) : [];
  const groups = [
    { label: "Commands", actions: matchingCommands },
    { label: "Recent threads", actions: recentThreads },
    { label: "Thread search", actions: normalized ? [searchAllThreads] : [] },
  ];
  const filteredActions = groups.flatMap((group) => group.actions);

  const selectedIndex = Math.min(
    activeIndex,
    Math.max(0, filteredActions.length - 1),
  );

  useLayoutEffect(() => {
    if (!open) { keyboardNavigation.current = false; return; }
    if (!keyboardNavigation.current) return;
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const listBounds = list.getBoundingClientRect();
    const selectedBounds = selected.getBoundingClientRect();
    if (selectedBounds.top < listBounds.top) list.scrollTop -= listBounds.top - selectedBounds.top;
    else if (selectedBounds.bottom > listBounds.bottom) list.scrollTop += selectedBounds.bottom - listBounds.bottom;
  }, [open, selectedIndex, filteredActions]);

  const selectAction = (action: PaletteAction | undefined) => {
    if (!action) return;
    onClose();
    window.setTimeout(action.onSelect, 0);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      keyboardNavigation.current = true;
      setActiveIndex((index) =>
        Math.min(index + 1, Math.max(0, filteredActions.length - 1)),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      keyboardNavigation.current = true;
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectAction(filteredActions[selectedIndex]);
    }
  };

  if (!open) return null;

  return (
    <Dialog variant="search" onClose={onClose} initialFocus={searchRef}>
      <DialogTitle className="sr-only">Commands</DialogTitle>
      <div className="command-palette-search">
        <Search size={17} aria-hidden="true" />
        <Input
          ref={searchRef}
          className="command-palette-input"
          value={query}
          onChange={(event) => {
            keyboardNavigation.current = false;
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder="Search commands or threads…"
          aria-label="Search commands or threads"
          role="combobox"
          aria-expanded="true"
          aria-controls="fern-command-options"
          aria-autocomplete="list"
          aria-activedescendant={
            filteredActions[selectedIndex]
              ? `command-${filteredActions[selectedIndex].id}`
              : undefined
          }
          autoComplete="off"
        />
        <DialogClose render={<IconButton aria-label="Close commands">
          <X size={15} aria-hidden="true" />
        </IconButton>} />
      </div>

      <div
        ref={listRef}
        className="command-palette-list"
        id="fern-command-options"
        role="listbox"
        aria-label="Commands and threads"
        tabIndex={-1}
      >
        {filteredActions.length > 0 ? (
          groups.filter((group) => group.actions.length).map((group) => <div key={group.label} role="group" aria-label={group.label}>
            <div className="command-palette-group-label" aria-hidden="true">{group.label}</div>
            {group.actions.map((action) => {
              const index = filteredActions.indexOf(action);
              return (
            <button
              key={action.id}
              id={`command-${action.id}`}
              tabIndex={-1}
              type="button"
              className="command-palette-action"
              role="option"
              aria-selected={index === selectedIndex}
              onMouseMove={() => { keyboardNavigation.current = false; setActiveIndex(index); }}
              onClick={() => selectAction(action)}
            >
              <span className="command-palette-icon">{action.icon}</span>
              <span className="command-palette-copy">
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </span>
              {action.shortcut ? (
                <span className="command-palette-shortcut">
                  {action.shortcut}
                </span>
              ) : null}
            </button>
              );
            })}
          </div>)
        ) : (
          <div className="command-palette-empty">
            <ArrowDownUp size={17} aria-hidden="true" />
            <span>No matching commands or threads.</span>
          </div>
        )}
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
