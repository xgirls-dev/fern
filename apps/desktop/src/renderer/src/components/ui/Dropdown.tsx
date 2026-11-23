import { Menu } from "@base-ui/react/menu";
import { useEffect, useRef, useState, type ComponentProps, type ReactElement, type ReactNode, type RefObject } from "react";
import { Tooltip } from "./Tooltip";

export function useDropdownActions({ dismissOnResize = false, trigger: externalTrigger }: {
  dismissOnResize?: boolean;
  trigger?: RefObject<HTMLButtonElement | null>;
} = {}) {
  const [open, setOpen] = useState(false);
  const internalTrigger = useRef<HTMLButtonElement>(null);
  const trigger = externalTrigger ?? internalTrigger;
  const dismissedByScroll = useRef(false);
  const pendingAction = useRef<(() => void) | null>(null);

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
    choose: (action: () => void) => { pendingAction.current = action; },
    menuProps: {
      open,
      onOpenChange: (next: boolean) => {
        if (next) dismissedByScroll.current = false;
        setOpen(next);
      },
      finalFocus: () => !dismissedByScroll.current,
      onOpenChangeComplete: (next: boolean) => {
        if (next || !pendingAction.current) return;
        const action = pendingAction.current;
        pendingAction.current = null;
        // Finish the menu's focus handoff before opening a dialog or editor.
        requestAnimationFrame(() => {
          if (!trigger.current?.isConnected) return;
          trigger.current.focus({ preventScroll: true });
          action();
        });
      },
    },
  };
}

export function Dropdown({
  trigger, triggerTooltip, triggerTooltipSide, children, label, align = "start", side = "bottom",
  className = "", finalFocus, open, onOpenChange, onOpenChangeComplete, portalContainer, collisionPadding,
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
  onOpenChange?: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  portalContainer?: ComponentProps<typeof Menu.Portal>["container"];
  collisionPadding?: ComponentProps<typeof Menu.Positioner>["collisionPadding"];
}) {
  const menuTrigger = <Menu.Trigger render={trigger} />;
  return <Menu.Root modal={false} open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
    {triggerTooltip ? <Tooltip content={triggerTooltip} side={triggerTooltipSide ?? side}>{menuTrigger}</Tooltip> : menuTrigger}
    <Menu.Portal container={portalContainer}>
      <Menu.Positioner className="ui-popup-positioner" align={align} side={side} sideOffset={5}
        collisionPadding={collisionPadding}>
        <Menu.Popup className={`ui-popup ui-dropdown-popup ${className}`} aria-label={label} finalFocus={finalFocus}>
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
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

export function DropdownGroup({ label, children }: { label: string; children: ReactNode }) {
  return <Menu.Group>
    <Menu.GroupLabel className="ui-menu-group-label">{label}</Menu.GroupLabel>
    {children}
  </Menu.Group>;
}

export function DropdownRadioItem(props: Omit<ComponentProps<typeof Menu.RadioItem>, "className">) {
  return <Menu.RadioItem className="ui-menu-item ui-popup-item" closeOnClick {...props} />;
}

export function DropdownSeparator() {
  return <Menu.Separator className="ui-popup-separator" />;
}
