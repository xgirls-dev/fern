import { useRef, useState } from "react";
import type { ImageThread } from "../lib/threads";
import { useModalFocus } from "../hooks/useModalFocus";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Button, Checkbox, IconButton, Input, SegmentedControl } from "./ui/controls";
export function ThreadBrowser({
  threads,
  initialQuery,
  onOpen,
  onClose,
  onNewChat,
}: {
  threads: Array<Pick<ImageThread, "id" | "title" | "archived"> & { excerpt?: string; folderPath?: string }>;
  initialQuery: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  onNewChat?: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useModalFocus(true, dialog, onClose);
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState("All");
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [limit, setLimit] = useState(60);
  const threadKind = (id: string) => id.startsWith("audio-thread-") ? "Speech" : id.startsWith("text-thread-") ? "Chat" : "Image";
  const filtered = threads.filter(
    (thread) =>
      `${thread.title} ${thread.folderPath ?? ""} ${thread.excerpt ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()) &&
      (kind === "All" || threadKind(thread.id) === kind) && (!archivedOnly || thread.archived),
  );
  const hasFilters = Boolean(query.trim()) || kind !== "All" || archivedOnly;
  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <div
        className="thread-browser command-palette"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={onNewChat ? "Choose a chat" : "Search threads"}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="thread-browser-search command-palette-search"><Input
          ref={search}
          className="thread-browser-search-field"
          data-autofocus
          type="search"
          aria-label={onNewChat ? "Find a chat" : "Find a thread"}
          placeholder={onNewChat ? "Search chats…" : "Search threads…"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(60);
          }}
        /><IconButton aria-label={onNewChat ? "Close chat picker" : "Close thread search"} onClick={onClose}><X size={16} aria-hidden="true" /></IconButton></div>
        {onNewChat ? <div className="thread-browser-filters">
          <Button variant="secondary" onClick={() => { onNewChat(); onClose(); }}>New chat in this pane</Button>
        </div> : <div className="thread-browser-filters">
          <SegmentedControl label="Thread type" value={kind} options={["All", "Chat", "Image", "Speech"].map(value => ({ value, label: value }))} onChange={value => { setKind(value); setLimit(60); }} />
          <label><Checkbox checked={archivedOnly} onChange={event => { setArchivedOnly(event.target.checked); setLimit(60); }} />Archived only</label>
        </div>}
        <div className="thread-browser-list">
          {filtered.slice(0, limit).map((thread) => (
            <article key={thread.id}>
              <button type="button" className="thread-browser-open" title={thread.title} onClick={() => { onOpen(thread.id); onClose(); }}>
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
      </div>
    </div>
  );
}
