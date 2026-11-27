import { memo, useEffect, useState, type MouseEvent, type RefObject } from "react";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Menu from "lucide-react/dist/esm/icons/menu.mjs";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Button } from "./ui/controls";
import { Tooltip, TooltipIconButton, TooltipScope } from "./ui/Tooltip";
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

export const TitleBar = memo(function TitleBar({
  sidebarCollapsed,
  sidebarToggleRef,
  onToggleSidebar,
  theme,
  onToggleTheme,
  onOpenCommands,
}: TitleBarProps) {
  const commandShortcut = shortcutLabel(shortcuts.commands);
  const [maximized, setMaximized] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!useNativeWindowControls) return window.studio.onWindowMaximizedChanged(setMaximized);
  }, []);
  const resizeLabel = maximized ? "Restore window" : "Maximize";
  const openApplicationMenu = async (event: MouseEvent<HTMLButtonElement>) => {
    const { left, bottom } = event.currentTarget.getBoundingClientRect();
    setMenuOpen(true);
    try {
      await window.studio.openApplicationMenu?.(left, bottom);
    } finally {
      setMenuOpen(false);
    }
  };
  return (
    <TooltipScope><header
      className={`titlebar${useNativeWindowControls ? " titlebar--native-controls" : ""}`}
    >
      <TooltipIconButton
        ref={sidebarToggleRef}
        className="titlebar-sidebar-toggle"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!sidebarCollapsed}
        aria-controls="studio-sidebar"
        tooltip={`Toggle sidebar · ${shortcutLabel(shortcuts.sidebar)}`}
        tooltipSide="bottom"
      >
        <PanelLeft size={18} strokeWidth={1.6} aria-hidden="true" />
      </TooltipIconButton>

      <div className="titlebar-actions">
        <Tooltip content={`Open command palette · ${commandShortcut}`} side="bottom"><Button
          variant="ghost"
          className="titlebar-command-button"
          onClick={onOpenCommands}
          aria-label={`Commands ${commandShortcut}`}
        >
          <Search size={14} aria-hidden="true" />
          <span>Commands</span>{" "}
          <span className="titlebar-command-shortcut" aria-hidden="true">{commandShortcut}</span>
        </Button></Tooltip>
        <TooltipIconButton
          onClick={onToggleTheme}
          tooltip={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          tooltipSide="bottom"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? (
            <Sun size={14} aria-hidden="true" />
          ) : (
            <Moon size={14} aria-hidden="true" />
          )}
        </TooltipIconButton>
        {window.studio.openApplicationMenu && (
          <TooltipIconButton aria-label="Application menu" aria-haspopup="menu" aria-expanded={menuOpen}
            tooltip="Application menu" tooltipSide="bottom" onClick={openApplicationMenu}>
            <Menu size={16} aria-hidden="true" />
          </TooltipIconButton>
        )}

        {!useNativeWindowControls ? (
          <div className="titlebar-window-controls">
            <Tooltip content="Minimize" side="bottom"><button
              type="button"
              onClick={() => void window.studio.minimizeWindow()}
              aria-label="Minimize"
            >
              <Minus size={13} aria-hidden="true" />
            </button></Tooltip>
            <Tooltip content={resizeLabel} side="bottom"><button
              type="button"
              onClick={() => void window.studio.toggleMaximizeWindow()}
              aria-label={resizeLabel}
            >
              {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
            </button></Tooltip>
            <Tooltip content="Close window" side="bottom"><button
              type="button"
              className="close"
              onClick={() => void window.studio.closeWindow()}
              aria-label="Close"
            >
              <X size={13} aria-hidden="true" />
            </button></Tooltip>
          </div>
        ) : null}
      </div>
    </header></TooltipScope>
  );
});

