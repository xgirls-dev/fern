import { Menu } from "@base-ui/react/menu";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactElement, type ReactNode, type RefObject } from "react";
import { Tooltip } from "./Tooltip";

export function useDropdownActions({ dismissOnResize = false, trigger: externalTrigger }: {
  dismissOnResize?: boolean;
  trigger?: RefObject<HTMLButtonElement | null>;
} = {}) {
  const [open, setOpen] = useState(false);
  const internalTrigger = useRef<HTMLButtonElement>(null);
  const trigger = externalTrigger ?? internalTrigger;
  const dismissedByScroll = useRef(false);
  const pendingAction = useRef<{ action: () => void; anchor: HTMLButtonElement | null } | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnResize = () => setOpen(false);
    const closeOnAncestorScroll = ({ target }: Event) => {
      if (target !== window && !(target instanceof Node && target.contains(trigger.current))) return;
      dismissedByScroll.current = true;
      setOpen(false);
    };
    window.addEventListener("scroll", closeOnAncestorScroll, true);
    if (dismissOnResize) window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("scroll", closeOnAncestorScroll, true);
      if (dismissOnResize) window.removeEventListener("resize", closeOnResize);
    };
  }, [dismissOnResize, open, trigger]);

  return {
    trigger,
    choose: (action: () => void) => { pendingAction.current = { action, anchor: trigger.current }; },
    menuProps: {
      open,
      onOpenChange: (next: boolean) => {
        if (next) dismissedByScroll.current = false;
        setOpen(next);
      },
      finalFocus: () => !dismissedByScroll.current,
      onOpenChangeComplete: (next: boolean) => {
        if (next || !pendingAction.current) return;
        const { action, anchor } = pendingAction.current;
        pendingAction.current = null;
        // Finish the menu's focus handoff before opening a dialog or editor.
        requestAnimationFrame(() => {
          if (!anchor?.isConnected) return;
          anchor.focus({ preventScroll: true });
          action();
        });
      },
    },
  };
}

export function Dropdown({
  trigger, triggerTooltip, triggerTooltipSide, children, label, align = "start", side = "bottom",
  className = "", finalFocus, open, onOpenChange, onOpenChangeComplete, onItemHighlighted, portalContainer, collisionPadding,
}: {
  trigger: ReactElement;
  triggerTooltip?: string;
  triggerTooltipSide?: ComponentProps<typeof Tooltip>["side"];
  children: ReactNode;
  label: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  className?: string;
  finalFocus?: ComponentProps<typeof Menu.Popup>["finalFocus"];
  open?: boolean;
  onOpenChange?: ComponentProps<typeof Menu.Root>["onOpenChange"];
  onOpenChangeComplete?: (open: boolean) => void;
  onItemHighlighted?: ComponentProps<typeof Menu.Root>["onItemHighlighted"];
  portalContainer?: ComponentProps<typeof Menu.Portal>["container"];
  collisionPadding?: ComponentProps<typeof Menu.Positioner>["collisionPadding"];
}) {
  const menuTrigger = useMemo(() => {
    const button = <Menu.Trigger render={trigger} />;
    return triggerTooltip ? <Tooltip content={triggerTooltip} side={triggerTooltipSide ?? side}>{button}</Tooltip> : button;
  }, [side, trigger, triggerTooltip, triggerTooltipSide]);
  return <Menu.Root modal={false} open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}
    onItemHighlighted={onItemHighlighted}>
    {menuTrigger}
    <DropdownPopup {...{ portalContainer, align, side, collisionPadding, className, label, finalFocus }}>{children}</DropdownPopup>
  </Menu.Root>;
}

export function DropdownPopup({ portalContainer, align = "start", side = "bottom", collisionPadding, className = "", label, finalFocus, children }: {
  portalContainer?: ComponentProps<typeof Menu.Portal>["container"];
  align?: ComponentProps<typeof Menu.Positioner>["align"];
  side?: ComponentProps<typeof Menu.Positioner>["side"];
  collisionPadding?: ComponentProps<typeof Menu.Positioner>["collisionPadding"];
  className?: string;
  label: string;
  finalFocus?: ComponentProps<typeof Menu.Popup>["finalFocus"];
  children: ReactNode;
}) {
  return <Menu.Portal container={portalContainer}>
    <Menu.Positioner className="ui-popup-positioner" align={align} side={side} sideOffset={5} collisionPadding={collisionPadding}>
      <Menu.Popup className={`ui-popup ui-dropdown-popup ${className}`} aria-label={label} finalFocus={finalFocus}>
        {children}
      </Menu.Popup>
    </Menu.Positioner>
  </Menu.Portal>;
}

export function DropdownItem({ className = "", destructive, ...props }: ComponentProps<typeof Menu.Item> & {
  className?: string;
  destructive?: boolean;
}) {
  return <Menu.Item className={`ui-menu-item ui-popup-item${destructive ? " ui-menu-item--danger" : ""} ${className}`} {...props} />;
}

export function DropdownRadioGroup(props: ComponentProps<typeof Menu.RadioGroup>) {
  return <Menu.RadioGroup {...props} />;
}

export function DropdownGroup({ label, children }: { label?: string; children: ReactNode }) {
  return <Menu.Group>
    {label && <Menu.GroupLabel className="ui-menu-group-label">{label}</Menu.GroupLabel>}
    {children}
  </Menu.Group>;
}

export function DropdownRadioItem(props: Omit<ComponentProps<typeof Menu.RadioItem>, "className">) {
  return <Menu.RadioItem className="ui-menu-item ui-popup-item" closeOnClick {...props} />;
}

export function DropdownSeparator() {
  return <Menu.Separator className="ui-popup-separator" />;
}
