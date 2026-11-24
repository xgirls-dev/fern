import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Tooltip } from "./Tooltip";

type PositionerProps = ComponentProps<typeof BasePopover.Positioner>;

export function Popover({ trigger, triggerTooltip, triggerTooltipSide, children, label, className = "", open, onOpenChange, initialFocus,
  anchor, side = "bottom", align = "start" }: {
  trigger: ReactElement;
  triggerTooltip?: string;
  triggerTooltipSide?: ComponentProps<typeof Tooltip>["side"];
  children: ReactNode;
  label: string;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialFocus?: ComponentProps<typeof BasePopover.Popup>["initialFocus"];
  anchor?: PositionerProps["anchor"];
  side?: PositionerProps["side"];
  align?: PositionerProps["align"];
}) {
  const button = <BasePopover.Trigger render={trigger} />;
  return <BasePopover.Root open={open} onOpenChange={onOpenChange}>
    {triggerTooltip ? <Tooltip content={triggerTooltip} side={triggerTooltipSide}>{button}</Tooltip> : button}
    <BasePopover.Portal>
      <BasePopover.Positioner className="ui-popup-positioner" anchor={anchor} side={side} align={align} sideOffset={8}>
        <BasePopover.Popup className={`ui-popup ui-popover ${className}`} aria-label={label} initialFocus={initialFocus}>
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>;
}
