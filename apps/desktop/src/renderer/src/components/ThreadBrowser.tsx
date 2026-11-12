import { useRef, useState } from "react";
import type { ImageThread } from "../lib/threads";
import { useModalFocus } from "../hooks/useModalFocus";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { Button, Checkbox, IconButton, Input, SegmentedControl } from "./ui/controls";
export function ThreadBrowser({
  threads,
  onOpen,
  onClose,
}: {
  threads: Array<Pick<ImageThread, "id" | "title" | "archived">>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useModalFocus(true, dialog, onClose);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("All");
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [limit, setLimit] = useState(60);
  const threadKind = (id: string) => id.startsWith("audio-thread-") ? "Audio" : id.startsWith("text-thread-") ? "Text" : "Image";
  const filtered = threads.filter(
    (thread) =>
      thread.title.toLowerCase().includes(query.trim().toLowerCase()) &&
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
        aria-label="Search threads"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="thread-browser-search command-palette-search"><Input
          ref={search}
          className="thread-browser-search-field"
          data-autofocus
          type="search"
          aria-label="Find a thread"
          placeholder="Search threads…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(60);
          }}
        /><IconButton aria-label="Close thread search" onClick={onClose}><X size={16} aria-hidden="true" /></IconButton></div>
        <div className="thread-browser-filters">
          <SegmentedControl label="Thread type" value={kind} options={["All", "Image", "Audio", "Text"].map(value => ({ value, label: value }))} onChange={value => { setKind(value); setLimit(60); }} />
          <label><Checkbox checked={archivedOnly} onChange={event => { setArchivedOnly(event.target.checked); setLimit(60); }} />Archived only</label>
        </div>
        <div className="thread-browser-list">
          {filtered.slice(0, limit).map((thread) => (
            <article key={thread.id}>
              <button type="button" className="thread-browser-open" title={thread.title} onClick={() => { onOpen(thread.id); onClose(); }}>
                <span>{thread.title}</span>
                <small>{thread.id.startsWith("audio-thread-") ? "Audio thread" : thread.id.startsWith("text-thread-") ? "Text thread" : "Image thread"}{thread.archived ? " · Archived" : ""}</small>
              </button>
            </article>
          ))}
          {filtered.length > limit && <Button variant="secondary" onClick={() => setLimit(value => value + 60)}>Show more threads</Button>}
          {!filtered.length ? <div className="thread-browser-empty">
            <p role="status">{hasFilters ? "No matching threads" : "No threads yet"}</p>
            {hasFilters ? <><small>Try a different search or clear the filters.</small><Button variant="ghost" onClick={() => { setQuery(""); setKind("All"); setArchivedOnly(false); setLimit(60); search.current?.focus(); }}>Clear filters</Button></> : null}
          </div> : null}
        </div>
      </div>
    </div>
  );
}
