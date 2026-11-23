import { useMemo, useRef, useState } from "react";
import type { ImageThread } from "../lib/threads";
import { chatSearchPattern, chatSearchText, findChatSearchRange } from "../lib/chatSearch";
import type { TextMessage } from "../lib/textThreads";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Dialog, DialogClose, DialogTitle } from "./ui/Dialog";
import { Button, Checkbox, IconButton, Input, SegmentedControl } from "./ui/controls";
export function ThreadBrowser({
  threads,
  initialQuery,
  onOpen,
  onClose,
  onNewChat,
}: {
  threads: Array<Pick<ImageThread, "id" | "title" | "archived"> & { excerpt?: string; folderPath?: string; messages?: TextMessage[] }>;
  initialQuery: string;
  onOpen: (id: string, messageQuery?: string) => void;
  onClose: () => void;
  onNewChat?: () => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const firstResult = useRef<HTMLButtonElement>(null);
  const focusDestination = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState("All");
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [limit, setLimit] = useState(60);
  const threadKind = (id: string) => id.startsWith("audio-thread-") ? "Speech" : id.startsWith("text-thread-") ? "Chat" : "Image";
  const needle = query.trim();
  const searching = !!needle;
  const pattern = chatSearchPattern(needle);
  const includesQuery = (value: string | undefined) => value !== undefined && value.normalize().search(pattern) !== -1;
  const searchText = useMemo(() => new Map(searching ? threads.flatMap((thread) =>
    thread.messages ? [[thread.id, chatSearchText(thread.messages)] as const] : []) : []), [searching, threads]);
  const filtered = threads.flatMap((thread) => {
    if ((kind !== "All" && threadKind(thread.id) !== kind) || (archivedOnly && !thread.archived)) return [];
    const inside = needle ? searchText.get(thread.id)?.find(includesQuery) : undefined;
    const messageQuery = inside ? needle : undefined;
    const excerpt = inside ?? (includesQuery(thread.excerpt) ? thread.excerpt : undefined);
    if (!needle || !excerpt) return !needle || (includesQuery(thread.title) || includesQuery(thread.folderPath)) ? [{ ...thread, messageQuery }] : [];
    const match = findChatSearchRange(excerpt, pattern);
    if (!match) return [{ ...thread, messageQuery, excerpt }];
    const start = Math.max(0, match.start - 45);
    const end = match.end + 75;
    return [{ ...thread, messageQuery, excerpt: `${start > 0 ? "…" : ""}${excerpt.slice(start, end)}${end < excerpt.length ? "…" : ""}` }];
  });
  const hasFilters = Boolean(needle) || kind !== "All" || archivedOnly;
  const open = (thread: (typeof filtered)[number]) => {
    focusDestination.current = Boolean(onNewChat || thread.messageQuery);
    onOpen(thread.id, thread.messageQuery);
    onClose();
  };
  return (
    <Dialog variant="search" className="thread-browser" onClose={onClose} initialFocus={search} finalFocus={() => !focusDestination.current}>
      <DialogTitle className="sr-only">{onNewChat ? "Choose a chat" : "Search threads"}</DialogTitle>
      <div className="thread-browser-search command-palette-search">
        <Input
          ref={search}
          className="thread-browser-search-field"
          type="search"
          aria-label={onNewChat ? "Find a chat" : "Find a thread"}
          placeholder={onNewChat ? "Search chats…" : "Search threads…"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(60);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || !filtered.length) return;
            if (event.key === "Enter") { event.preventDefault(); open(filtered[0]); }
            else if (event.key === "ArrowDown") { event.preventDefault(); firstResult.current?.focus(); }
          }}
        />
        <DialogClose render={<IconButton aria-label={onNewChat ? "Close chat picker" : "Close thread search"}>
          <X size={16} aria-hidden="true" />
        </IconButton>} />
      </div>
      {onNewChat ? <div className="thread-browser-filters">
        <Button variant="secondary" onClick={() => {
          focusDestination.current = true;
          onNewChat();
          onClose();
        }}>New chat in this pane</Button>
      </div> : <div className="thread-browser-filters">
        <SegmentedControl label="Thread type" value={kind} options={["All", "Chat", "Image", "Speech"].map(value => ({ value, label: value }))} onChange={value => { setKind(value); setLimit(60); }} />
        <label><Checkbox checked={archivedOnly} onChange={event => { setArchivedOnly(event.target.checked); setLimit(60); }} />Archived only</label>
      </div>}
      <div className="thread-browser-list">
        {filtered.slice(0, limit).map((thread, index) => (
          <article key={thread.id}>
            <button ref={index === 0 ? firstResult : undefined} type="button" className="thread-browser-open" title={thread.title} onClick={() => open(thread)}>
              <span className="thread-browser-result"><strong>{thread.title}</strong>
                {thread.folderPath && <span title={thread.folderPath}>{thread.folderPath}</span>}
                {thread.excerpt?.trim() && thread.excerpt.trim() !== thread.title && <span>{thread.excerpt.trim()}</span>}
              </span>
              <small>{threadKind(thread.id)}{thread.archived ? " · Archived" : ""}</small>
            </button>
          </article>
        ))}
        {filtered.length > limit && <Button variant="secondary" onClick={() => setLimit(value => value + 60)}>Show more threads</Button>}
        {!filtered.length ? <div className="thread-browser-empty">
          <p role="status">{hasFilters ? (onNewChat ? "No matching chats" : "No matching threads") : (onNewChat ? "No other chats" : "No threads yet")}</p>
          {hasFilters ? <><small>Try a different search or clear the filters.</small><Button variant="ghost" onClick={() => { setQuery(""); setKind("All"); setArchivedOnly(false); setLimit(60); search.current?.focus(); }}>Clear filters</Button></> : null}
        </div> : null}
      </div>
    </Dialog>
  );
}
