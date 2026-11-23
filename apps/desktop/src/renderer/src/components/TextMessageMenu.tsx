import { useMemo, type RefObject } from "react";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal.mjs";
import type { LucideIcon } from "lucide-react";
import { Dropdown, DropdownItem, useDropdownActions } from "./ui/Dropdown";
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
  const { choose, menuProps } = useDropdownActions({ trigger });
  const button = useMemo(() => <IconButton ref={trigger} className="text-icon-button" aria-label="More message actions">
    <MoreHorizontal size={16} aria-hidden="true" />
  </IconButton>, [trigger]);
  return <Dropdown label="Message actions" triggerTooltip="More message actions" triggerTooltipSide="bottom"
    className="text-message-action-menu" align={align} side="top" {...menuProps} trigger={button}>
    {actions.map(({ label, icon: Icon, run, destructive, disabled }) =>
      <DropdownItem key={label} destructive={destructive} disabled={disabled} onClick={() => choose(run)}>
        <Icon size={15} aria-hidden="true" /><span>{label}</span>
      </DropdownItem>)}
  </Dropdown>;
}
