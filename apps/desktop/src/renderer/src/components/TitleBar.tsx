import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import Command from "lucide-react/dist/esm/icons/command.mjs";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";

interface TitleBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenCommands: () => void;
}

const useNativeWindowControls =
  window.studio.platform === "win32" || window.studio.platform === "darwin";

export function TitleBar({
  sidebarCollapsed,
  onToggleSidebar,
  theme,
  onToggleTheme,
  onOpenCommands,
}: TitleBarProps) {
  return (
    <header
      className={`titlebar${useNativeWindowControls ? " titlebar--native-controls" : ""}`}
    >
      <button
        type="button"
        className="titlebar-sidebar-toggle"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!sidebarCollapsed}
        aria-controls="studio-sidebar"
        title="Toggle sidebar · Ctrl B"
      >
        <PanelLeft size={18} strokeWidth={1.6} aria-hidden="true" />
      </button>

      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-command-button"
          onClick={onOpenCommands}
          title="Open command palette"
          aria-label="Open command palette"
        >
          <Command size={13} aria-hidden="true" />
          <span>Commands</span>
          <span className="titlebar-command-shortcut">Ctrl K</span>
        </button>
        <button
          type="button"
          className="btn-icon btn-icon-sm"
          onClick={onToggleTheme}
          title="Toggle theme"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? (
            <Sun size={14} aria-hidden="true" />
          ) : (
            <Moon size={14} aria-hidden="true" />
          )}
        </button>

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
              aria-label="Maximize"
            >
              <Square size={11} aria-hidden="true" />
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

