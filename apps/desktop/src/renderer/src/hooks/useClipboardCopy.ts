import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { notify } from "../lib/notifications";

export function useClipboardCopy(source: unknown, errorMessage: string, version?: string) {
  const scope = useMemo(() => ({}), [source, version]);
  const request = useRef<symbol | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const [copiedScope, setCopiedScope] = useState<typeof scope>();

  useLayoutEffect(() => () => {
    request.current = undefined;
    window.clearTimeout(timer.current);
  }, [scope]);

  const copy = async (text: string) => {
    const current = Symbol();
    request.current = current;
    try {
      await window.studio.copyText(text);
      if (request.current !== current) return;
      setCopiedScope(scope);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopiedScope(undefined), 1500);
    } catch {
      if (request.current !== current) return;
      window.clearTimeout(timer.current);
      setCopiedScope(undefined);
      notify(errorMessage, "error");
    }
  };

  return { copied: copiedScope === scope, copy };
}
