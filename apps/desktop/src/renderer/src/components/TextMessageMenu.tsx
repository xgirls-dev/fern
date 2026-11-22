import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal.mjs";
import type { LucideIcon } from "lucide-react";
import { IconButton, MenuItem } from "./ui/controls";

export interface MessageAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
  destructive?: boolean;
}

export function TextMessageMenu({ actions, trigger }: { actions: MessageAction[]; trigger: RefObject<HTMLButtonElement | null> }) {
  const menu = useRef<HTMLDivElement>(null);
  const fromEnd = useRef(false);
  const id = useId();
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const popup = menu.current;
    const anchor = trigger.current;
    if (!open || !anchor || !popup?.matches(":popover-open")) return;
    const feed = anchor.closest(".text-conversation");
    const placeMenu = () => {
      const space = feed?.getBoundingClientRect();
      const bounds = anchor.getBoundingClientRect();
      const above = bounds.top - (space?.top ?? 0);
      const below = (space?.bottom ?? window.innerHeight) - bounds.bottom;
      popup.dataset.placement = below < popup.offsetHeight + 6 && above > below ? "above" : "below";
    };
    placeMenu();
    const items = popup.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items[fromEnd.current ? items.length - 1 : 0]?.focus({ preventScroll: true });
    fromEnd.current = false;
    feed?.addEventListener("scroll", placeMenu, { passive: true });
    window.addEventListener("resize", placeMenu);
    return () => {
      feed?.removeEventListener("scroll", placeMenu);
      window.removeEventListener("resize", placeMenu);
    };
  }, [open, trigger]);

  const dismiss = (restoreFocus = false) => {
    if (menu.current?.matches(":popover-open")) menu.current.hidePopover();
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  return <>
    <IconButton ref={trigger} className="text-icon-button" aria-label="More message actions" title="More actions"
      popoverTarget={id} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        if (menu.current?.matches(":popover-open")) return;
        fromEnd.current = event.key === "ArrowUp";
        event.currentTarget.click();
      }}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </IconButton>
    <div id={id} ref={menu} popover="auto" className="text-message-action-menu" role="menu" aria-label="Message actions"
      onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) dismiss(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss(true);
          return;
        }
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        let next: number;
        switch (event.key) {
          case "Home": next = 0; break;
          case "End": next = items.length - 1; break;
          case "ArrowDown": next = (index + 1) % items.length; break;
          case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
          default: return;
        }
        event.preventDefault();
        items[next]?.focus({ preventScroll: true });
      }}>
      {open && actions.map(({ label, icon: Icon, run, destructive }) =>
        <MenuItem key={label} role="menuitem" tabIndex={-1} destructive={destructive} onClick={() => { dismiss(true); run(); }}>
          <Icon size={15} aria-hidden="true" /><span>{label}</span>
        </MenuItem>)}
    </div>
  </>;
}
