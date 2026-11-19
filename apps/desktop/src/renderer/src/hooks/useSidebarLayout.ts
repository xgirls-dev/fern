import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

const compactSidebarMedia = window.matchMedia("(max-width: 900px)");
function subscribeToCompactSidebar(listener: () => void) {
  compactSidebarMedia.addEventListener("change", listener);
  return () => compactSidebarMedia.removeEventListener("change", listener);
}

export function useSidebarLayout() {
  const [wideSidebarCollapsed, setWideSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("fern-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const compactLayout = useSyncExternalStore(subscribeToCompactSidebar, () => compactSidebarMedia.matches);
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const sidebarOverlayOpen = compactLayout && compactSidebarOpen;
  const sidebarIsCollapsed = compactLayout ? !sidebarOverlayOpen : wideSidebarCollapsed;
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarOpenerRef = useRef<HTMLElement | null>(null);
  const closeSidebarOverlay = useCallback((destination: "opener" | "workspace" | "current") => {
    setCompactSidebarOpen(false);
    if (destination === "current") return;
    if (destination === "opener") {
      const opener = sidebarOpenerRef.current;
      const target = opener?.isConnected && opener.getClientRects().length ? opener : sidebarToggleRef.current;
      target?.focus({ preventScroll: true });
      return;
    }
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused === document.body || sidebarRef.current?.contains(focused)) {
        document.getElementById("main-content")?.focus({ preventScroll: true });
      }
    });
  }, []);
  const toggleWideSidebar = useCallback(() => setWideSidebarCollapsed((value) => !value), []);
  const toggleSidebar = useCallback(() => {
    if (!compactLayout) {
      toggleWideSidebar();
    } else if (sidebarOverlayOpen) {
      closeSidebarOverlay("opener");
    } else {
      const focused = document.activeElement;
      sidebarOpenerRef.current = focused instanceof HTMLElement && focused !== document.body &&
        !sidebarRef.current?.contains(focused) && !focused.closest('[aria-modal="true"]')
        ? focused : sidebarToggleRef.current;
      setCompactSidebarOpen(true);
    }
  }, [compactLayout, sidebarOverlayOpen, closeSidebarOverlay, toggleWideSidebar]);

  useLayoutEffect(() => {
    if (!sidebarOverlayOpen) return;
    const sidebar = sidebarRef.current;
    const target = sidebar?.querySelector<HTMLElement>(".sidebar-new-options button")
      ?? sidebar?.querySelector<HTMLElement>('.sidebar-thread-button[aria-current="page"]')
      ?? sidebar?.querySelector<HTMLElement>(".sidebar-search-button");
    target?.focus();
  }, [sidebarOverlayOpen]);

  useLayoutEffect(() => {
    if (compactLayout || !compactSidebarOpen) return;
    setCompactSidebarOpen(false);
    if (wideSidebarCollapsed && (document.activeElement === document.body ||
      sidebarRef.current?.contains(document.activeElement))) {
      sidebarToggleRef.current?.focus({ preventScroll: true });
    }
  }, [compactLayout, compactSidebarOpen, wideSidebarCollapsed]);

  useEffect(() => {
    if (!sidebarOverlayOpen) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || sidebarRef.current?.contains(target) ||
        sidebarToggleRef.current?.contains(target) ||
        target.closest('.sidebar-thread-actions-menu, [aria-modal="true"]')) return;
      closeSidebarOverlay("current");
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing ||
        document.querySelector('[aria-modal="true"], .sidebar-thread-actions-menu')) return;
      event.preventDefault();
      event.stopPropagation();
      closeSidebarOverlay("opener");
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onEscape);
    };
  }, [sidebarOverlayOpen, closeSidebarOverlay]);

  useEffect(() => {
    try {
      localStorage.setItem("fern-sidebar-collapsed", String(wideSidebarCollapsed));
    } catch {
      // Layout preference is optional.
    }
  }, [wideSidebarCollapsed]);

  return {
    compactLayout,
    sidebarIsCollapsed,
    wideSidebarCollapsed,
    sidebarOverlayOpen,
    sidebarRef,
    sidebarToggleRef,
    toggleSidebar,
    toggleWideSidebar,
    closeSidebarOverlay,
  };
}
