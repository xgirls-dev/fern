import { useCallback, useRef } from "react";

/** Restore focus after a conditional action is rendered again. */
export function useReturnFocus() {
  const targets = useRef(new Map<string, HTMLButtonElement>());
  const register = useCallback((key: string) => (element: HTMLButtonElement | null) => {
    if (element) targets.current.set(key, element);
    else targets.current.delete(key);
  }, []);
  const restore = useCallback((key: string) => {
    requestAnimationFrame(() => targets.current.get(key)?.focus());
  }, []);
  return { register, restore };
}
