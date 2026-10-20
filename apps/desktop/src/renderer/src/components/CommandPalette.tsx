import ArrowDownUp from "lucide-react/dist/esm/icons/arrow-down-up.mjs";
import Command from "lucide-react/dist/esm/icons/command.mjs";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";

interface CommandPaletteProps {
  open: boolean;
  running: boolean;
  audioRunning: boolean;
  textRunning: boolean;
  sidebarCollapsed: boolean;
  onClose: () => void;
  onNewRender: () => void;
  onNewAudio: () => void;
  onNewText: () => void;
  onOpenAudio: () => void;
  onOpenText: () => void;
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
  textRunning,
  sidebarCollapsed,
  onClose,
  onNewRender,
  onNewAudio,
  onNewText,
  onOpenAudio,
  onOpenText,
  onOpenLibrary,
  onOpenData,
  onOpenPreferences,
  onToggleTheme,
  onToggleSidebar,
  onStop,
  onStopAudio,
  onStopText,
}: CommandPaletteProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  useModalFocus(open, dialogRef, onClose);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  const actions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "new-render",
        label: "New image thread",
        description: "Start a new image generation thread",
        shortcut: "Ctrl N",
        icon: <Sparkles size={16} aria-hidden="true" />,
        onSelect: onNewRender,
      },
      { id: "new-audio", label: "New audio thread", description: "Start a Qwen3-TTS thread", shortcut: "Ctrl Shift N", icon: <AudioLines size={16} aria-hidden="true" />, onSelect: onNewAudio },
      { id: "open-audio", label: "Open audio workspace", description: "Return to the selected audio thread", icon: <AudioLines size={16} aria-hidden="true" />, onSelect: onOpenAudio },
      { id: "new-text", label: "New text thread", description: "Start a local LLM conversation", shortcut: "Ctrl Alt N", icon: <MessageSquare size={16} aria-hidden="true" />, onSelect: onNewText },
      { id: "open-text", label: "Open text workspace", description: "Return to the selected text thread", icon: <MessageSquare size={16} aria-hidden="true" />, onSelect: onOpenText },
      {
        id: "library",
        label: "Open library",
        description: "Browse recent renders",
        shortcut: "Ctrl L",
        icon: <Images size={16} aria-hidden="true" />,
        onSelect: onOpenLibrary,
      },
      {
        id: "toggle-sidebar",
        label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
        description: "Change the workspace layout",
        shortcut: "Ctrl B",
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
      onStopText,
      running,
      audioRunning,
      textRunning,
      sidebarCollapsed,
    ],
  );

  const filteredActions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return actions;
    return actions.filter((action) =>
      `${action.label} ${action.description}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [actions, query]);

  const selectedIndex = Math.min(
    activeIndex,
    Math.max(0, filteredActions.length - 1),
  );

  const selectAction = (action: PaletteAction | undefined) => {
    if (!action) return;
    onClose();
    window.setTimeout(action.onSelect, 0);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) =>
        Math.min(index + 1, Math.max(0, filteredActions.length - 1)),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectAction(filteredActions[selectedIndex]);
    }
  };

  if (!open) return null;

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-palette-search">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search Fern commands…"
            aria-label="Search Fern commands"
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
          <button
            type="button"
            className="command-palette-close"
            onClick={onClose}
            aria-label="Close commands"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="command-palette-heading">
          <div>
            <p className="eyebrow">Command palette</p>
            <h2 id="command-palette-title">What do you want to do?</h2>
          </div>
          <span className="command-palette-hint">
            <span className="kbd">Esc</span>
          </span>
        </div>

        <div
          className="command-palette-list"
          id="fern-command-options"
          role="listbox"
          aria-label="Fern commands"
        >
          {filteredActions.length > 0 ? (
            filteredActions.map((action, index) => (
              <button
                key={action.id}
                id={`command-${action.id}`}
                tabIndex={-1}
                type="button"
                className={`command-palette-action${index === selectedIndex ? " is-active" : ""}`}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setActiveIndex(index)}
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
            ))
          ) : (
            <div className="command-palette-empty">
              <ArrowDownUp size={17} aria-hidden="true" />
              <span>No matching commands.</span>
            </div>
          )}
        </div>

        <footer className="command-palette-footer">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> Navigate
          </span>
          <span>
            <span className="kbd">↵</span> Run command
          </span>
          <span>
            <span className="kbd">Esc</span> Close
          </span>
        </footer>
      </section>
    </div>
  );
}
