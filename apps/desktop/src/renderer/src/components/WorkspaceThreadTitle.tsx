import { memo } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { TooltipIconButton } from "./ui/Tooltip";

interface WorkspaceThreadTitleProps {
  id?: string;
  title: string;
  switchLabel: string;
  sidebarCollapsed: boolean;
  onOpen?: () => void;
}

export const WorkspaceThreadTitle = memo(function WorkspaceThreadTitle({
  id, title, switchLabel, sidebarCollapsed, onOpen,
}: WorkspaceThreadTitleProps) {
  return (
    <div className="workspace-thread-title">
      <h2 id={id} title={title}>{title}</h2>
      {onOpen && <TooltipIconButton className={`workspace-thread-switcher${sidebarCollapsed ? " is-visible" : ""}`}
        aria-label={switchLabel} aria-haspopup="dialog" tooltip={switchLabel} tooltipSide="bottom" onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); onOpen(); }
        }}>
        <ChevronDown size={14} aria-hidden="true" />
      </TooltipIconButton>}
    </div>
  );
});
