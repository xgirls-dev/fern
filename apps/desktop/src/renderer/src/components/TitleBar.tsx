import { useEffect, useState, type RefObject } from "react";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Button, IconButton } from "./ui/controls";
import { shortcutLabel, shortcuts } from "../lib/workspaceNavigation";

interface TitleBarProps {
  sidebarCollapsed: boolean;
  sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  onToggleSidebar: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenCommands: () => void;
}

const useNativeWindowControls =
  window.studio.platform === "win32" || window.studio.platform === "darwin";

export function TitleBar({
  sidebarCollapsed,
  sidebarToggleRef,
  onToggleSidebar,
  theme,
  onToggleTheme,
  onOpenCommands,
}: TitleBarProps) {
  const commandShortcut = shortcutLabel(shortcuts.commands);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!useNativeWindowControls) return window.studio.onWindowMaximizedChanged(setMaximized);
  }, []);
  const resizeLabel = maximized ? "Restore window" : "Maximize";
  return (
    <header
      className={`titlebar${useNativeWindowControls ? " titlebar--native-controls" : ""}`}
    >
      <IconButton
        ref={sidebarToggleRef}
        className="titlebar-sidebar-toggle"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!sidebarCollapsed}
        aria-controls="studio-sidebar"
        title={`Toggle sidebar · ${shortcutLabel(shortcuts.sidebar)}`}
      >
        <PanelLeft size={18} strokeWidth={1.6} aria-hidden="true" />
      </IconButton>

      <div className="titlebar-actions">
        <Button
          variant="ghost"
          className="titlebar-command-button"
          onClick={onOpenCommands}
          title={`Open command palette · ${commandShortcut}`}
          aria-label={`Commands ${commandShortcut}`}
        >
          <Search size={14} aria-hidden="true" />
          <span>Commands</span>{" "}
          <span className="titlebar-command-shortcut" aria-hidden="true">{commandShortcut}</span>
        </Button>
        <IconButton
          onClick={onToggleTheme}
          title="Toggle theme"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? (
            <Sun size={14} aria-hidden="true" />
          ) : (
            <Moon size={14} aria-hidden="true" />
          )}
        </IconButton>

        {!useNativeWindowControls ? (
          <div className="titlebar-window-controls">
            <button
              type="button"
              onClick={() => void window.studio.minimizeWindow()}
              aria-label="Minimize"
            >
              <Minus size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => void window.studio.toggleMaximizeWindow()}
              aria-label={resizeLabel}
              title={resizeLabel}
            >
              {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="close"
              onClick={() => void window.studio.closeWindow()}
              aria-label="Close"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

