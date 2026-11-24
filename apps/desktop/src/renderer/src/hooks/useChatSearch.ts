import { useEffect, useState } from "react";

type ChatSearch = typeof import("../lib/chatSearch");

export function useChatSearch(enabled: boolean) {
  const [search, setSearch] = useState<ChatSearch>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || search || failed) return;
    let mounted = true;
    // Keep the Markdown parser off the initial chat and thread picker paths.
    void import("../lib/chatSearch").then((module) => {
      if (mounted) setSearch(module);
    }, () => {
      if (mounted) setFailed(true);
    });
    return () => { mounted = false; };
  }, [enabled, failed, search]);

  return { search, loading: enabled && !search && !failed, failed: enabled && failed };
}
