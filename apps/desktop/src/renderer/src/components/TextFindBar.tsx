import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { IconButton, Input } from "./ui/controls";
import { chatSearchEntries, liveChatSearchEntry, matchingChatOccurrences, type ChatSearchMatch } from "../lib/chatSearch";
import type { TextMessage } from "../lib/textThreads";

export function TextFindBar({ messages, liveMessage, initialQuery, onMatch, onClose }: {
  messages: TextMessage[];
  liveMessage: TextMessage | null;
  initialQuery: string;
  onMatch: (match: ChatSearchMatch | null) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<ChatSearchMatch>();
  const needle = query.trim();
  const searching = !!needle;
  const entries = useMemo(() => searching ? chatSearchEntries(messages) : [], [messages, searching]);
  const savedMatches = useMemo(() => matchingChatOccurrences(entries, needle), [entries, needle]);
  const deferredLive = useDeferredValue(liveMessage);
  // Ignore the deferred preview immediately when its reply settles or another one starts.
  const live = deferredLive?.id === liveMessage?.id ? deferredLive : null;
  const liveEntry = useMemo(() => searching && live ? [liveChatSearchEntry(live)] : [], [live, searching]);
  const matches = useMemo(() => [...savedMatches, ...matchingChatOccurrences(liveEntry, needle)], [liveEntry, needle, savedMatches]);
  const selectedIndex = selected ? matches.findIndex((match) => match.versionId === selected.versionId &&
    match.savedPromptId === selected.savedPromptId && match.section === selected.section && match.occurrence === selected.occurrence) : -1;
  const index = Math.max(0, selectedIndex);
  const active = matches[index];
  const messageId = active?.messageId;
  const versionId = active?.versionId;
  const savedPromptId = active?.savedPromptId;
  const section = active?.section;
  const occurrence = active?.occurrence;

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { if (active && selectedIndex < 0) setSelected(active); }, [active, selectedIndex]);
  useEffect(() => {
    onMatch(messageId && versionId && section && occurrence !== undefined
      ? { messageId, versionId, savedPromptId, section, occurrence, query: needle } : null);
  }, [messageId, versionId, savedPromptId, section, occurrence, needle, onMatch]);
  useEffect(() => () => onMatch(null), [onMatch]);

  const step = (direction: number) => {
    if (matches.length) setSelected(matches[(index + matches.length + direction) % matches.length]);
  };
  return (
    <form className="text-find-bar" role="search" aria-label="Find in chat" onSubmit={(event) => { event.preventDefault(); step(1); }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); step(-1); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); input.current?.select(); }
    }}>
      <Input ref={input} type="search" aria-label="Search this chat" placeholder="Find in chat…" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(undefined); }} />
      <span role="status">{needle ? matches.length ? `${index + 1} of ${matches.length}${savedPromptId ? " · Saved version" : ""}` : "No matches" : ""}</span>
      <IconButton aria-label="Previous match" title="Previous match (Shift + Enter)" disabled={!matches.length} onClick={() => step(-1)}><ChevronUp size={16} aria-hidden="true" /></IconButton>
      <IconButton aria-label="Next match" title="Next match (Enter)" disabled={!matches.length} onClick={() => step(1)}><ChevronDown size={16} aria-hidden="true" /></IconButton>
      <IconButton aria-label="Close find" title="Close find" onClick={onClose}><X size={16} aria-hidden="true" /></IconButton>
    </form>
  );
}
