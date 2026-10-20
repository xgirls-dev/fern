import { useRef, useState } from "react";
import type { ImageThread } from "../lib/threads";
import { useModalFocus } from "../hooks/useModalFocus";
import X from "lucide-react/dist/esm/icons/x.mjs";
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
        <div className="thread-browser-search command-palette-search"><input
          data-autofocus
          type="search"
          aria-label="Find a thread"
          placeholder="Search threads…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(60);
          }}
        /><button type="button" className="text-icon-button" aria-label="Close thread search" onClick={onClose}><X size={16} aria-hidden="true" /></button></div>
        <div className="thread-browser-filters">
          <div className="inspector-tabs" role="group" aria-label="Thread type">{["All", "Image", "Audio", "Text"].map(value => <button type="button" key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setLimit(60); }}>{value}</button>)}</div>
          <label><input type="checkbox" checked={archivedOnly} onChange={event => { setArchivedOnly(event.target.checked); setLimit(60); }} />Archived only</label>
        </div>
        <div className="thread-browser-list">
          {filtered.slice(0, limit).map((thread) => (
            <article key={thread.id}>
              <button type="button" className="thread-browser-open" onClick={() => { onOpen(thread.id); onClose(); }}>
                <span>{thread.title}</span>
                <small>{thread.id.startsWith("audio-thread-") ? "Audio thread" : thread.id.startsWith("text-thread-") ? "Text thread" : "Image thread"}{thread.archived ? " · Archived" : ""}</small>
              </button>
            </article>
          ))}
          {filtered.length > limit && <button type="button" className="text-secondary-button" onClick={() => setLimit(value => value + 60)}>Show more threads</button>}
        </div>
        {!filtered.length ? <p>No matching threads.</p> : null}
      </div>
    </div>
  );
}
