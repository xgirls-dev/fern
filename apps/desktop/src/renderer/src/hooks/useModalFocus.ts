import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const OPEN_POPUP = '[role="menu"][data-open], [role="listbox"][data-open]';
const POPUP_TARGET = '[role="menu"], [role="listbox"], [aria-haspopup="menu"][aria-expanded="true"], [aria-haspopup="listbox"][aria-expanded="true"]';

function tabbableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") &&
      element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible");
}

export function useModalFocus(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  onClose?: () => void,
): void {
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  onCloseRef.current = onClose;
  openRef.current = open;

  useLayoutEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    // StrictMode replays effects after initial focus has moved into the dialog.
    // Preserve the real opener instead of replacing it with a dialog control.
    if (!dialog.contains(document.activeElement)) {
      openerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement : null;
    }

    const focusInitialElement = () => {
      if (dialog.contains(document.activeElement)) return;
      const firstFocusable =
        dialog.querySelector<HTMLElement>("[data-autofocus]") ??
        tabbableElements(dialog)[0];
      (firstFocusable ?? dialog).focus();
    };

    const isTopModal = () => {
      const modals = document.querySelectorAll('[aria-modal="true"]');
      return modals[modals.length - 1] === dialog;
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !onCloseRef.current || !isTopModal()) return;
      const target = event.target;
      // Menus and selects own Escape while open. A passive tooltip should
      // never take an extra keypress to get out of the dialog.
      if (dialog.querySelector(OPEN_POPUP) || (target instanceof Element && dialog.contains(target) && target.closest(POPUP_TARGET))) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };

    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || !isTopModal()) return;

      const focusable = tabbableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    focusInitialElement();
    const focusFrame = requestAnimationFrame(focusInitialElement);
    document.addEventListener("keydown", onEscape, true);
    document.addEventListener("keydown", onTab);

    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onEscape, true);
      document.removeEventListener("keydown", onTab);
      requestAnimationFrame(() => {
        if (openRef.current && dialogRef.current === dialog) return;
        const focused = document.activeElement;
        if (!focused || focused === document.body || dialog.contains(focused)) {
          openerRef.current?.focus();
        }
      });
    };
  }, [dialogRef, open]);
}
