import type { RefObject } from "react";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal.mjs";
import type { LucideIcon } from "lucide-react";
import { Dropdown, DropdownItem } from "./ui/Dropdown";
import { IconButton } from "./ui/controls";

export interface MessageAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export function TextMessageMenu({ actions, trigger, align }: {
  actions: MessageAction[];
  trigger: RefObject<HTMLButtonElement | null>;
  align: "start" | "end";
}) {
  return <Dropdown label="Message actions" triggerTooltip="More message actions" triggerTooltipSide="bottom"
    className="text-message-action-menu" align={align} side="top"
    trigger={<IconButton ref={trigger} className="text-icon-button" aria-label="More message actions">
      <MoreHorizontal size={16} aria-hidden="true" />
    </IconButton>}
  >
    {actions.map(({ label, icon: Icon, run, destructive, disabled }) =>
      <DropdownItem key={label} destructive={destructive} disabled={disabled} onClick={run}>
        <Icon size={15} aria-hidden="true" /><span>{label}</span>
      </DropdownItem>)}
  </Dropdown>;
}
