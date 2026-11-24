import { useDeferredValue, useEffect, useMemo, useState, type RefObject } from "react";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { IconButton, Input } from "./ui/controls";
import { Tooltip } from "./ui/Tooltip";
import { useChatSearch } from "../hooks/useChatSearch";
import type { ChatSearchMatch } from "../lib/chatSearch";
import { isComposingKey } from "../lib/keyboard";
import type { TextMessage } from "../lib/textThreads";

export function TextFindBar({ input, messages, liveMessage, initialQuery, onMatch, onClose, showClose = true }: {
  input: RefObject<HTMLInputElement | null>;
  messages: TextMessage[];
  liveMessage: TextMessage | null;
  initialQuery: string;
  onMatch: (match: ChatSearchMatch | null) => void;
  onClose: () => void;
  showClose?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<ChatSearchMatch>();
  const { search, loading, failed } = useChatSearch(true);
  const needle = query.trim();
  const searching = !!needle;
  const entries = useMemo(() => searching && search ? search.chatSearchEntries(messages) : [], [messages, search, searching]);
  const savedMatches = useMemo(() => search?.matchingChatOccurrences(entries, needle) ?? [], [entries, needle, search]);
  const deferredLive = useDeferredValue(liveMessage);
  // Ignore the deferred preview immediately when its reply settles or another one starts.
  const live = deferredLive?.id === liveMessage?.id ? deferredLive : null;
  const liveEntry = useMemo(() => searching && search && live ? [search.liveChatSearchEntry(live)] : [], [live, search, searching]);
  const matches = useMemo(() => search ? [...savedMatches, ...search.matchingChatOccurrences(liveEntry, needle)] : [], [liveEntry, needle, savedMatches, search]);
  const selectedIndex = selected ? matches.findIndex((match) => match.versionId === selected.versionId &&
    match.savedPromptId === selected.savedPromptId && match.section === selected.section && match.occurrence === selected.occurrence) : -1;
  const index = Math.max(0, selectedIndex);
  const active = matches[index];
  const messageId = active?.messageId;
  const versionId = active?.versionId;
  const savedPromptId = active?.savedPromptId;
  const section = active?.section;
  const occurrence = active?.occurrence;
  const searchStatus = !needle ? "" : loading ? "Searching…" : failed ? "Chat search couldn’t open"
    : matches.length ? `${index + 1} of ${matches.length}${savedPromptId ? " · Saved version" : ""}` : "No matches";

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
    <div className="text-find-bar" role="search" aria-label="Find in chat" onKeyDown={(event) => {
      if (isComposingKey(event.nativeEvent)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Enter" && event.target === input.current) { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); input.current?.select(); }
    }}>
      <Input ref={input} type="search" aria-label="Search this chat" placeholder="Find in chat…" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(undefined); }} />
      <span role="status">{searchStatus}</span>
      <Tooltip content="Previous match · Shift + Enter">
        <IconButton aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)}><ChevronUp size={16} aria-hidden="true" /></IconButton>
      </Tooltip>
      <Tooltip content="Next match · Enter">
        <IconButton aria-label="Next match" disabled={!matches.length} onClick={() => step(1)}><ChevronDown size={16} aria-hidden="true" /></IconButton>
      </Tooltip>
      {showClose && <Tooltip content="Close find · Esc">
        <IconButton aria-label="Close find" onClick={onClose}><X size={16} aria-hidden="true" /></IconButton>
      </Tooltip>}
    </div>
  );
}
