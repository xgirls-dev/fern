import { useRef, useState } from "react";
import type { ImageThread } from "../lib/threads";
import { useModalFocus } from "../hooks/useModalFocus";
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
  const filtered = threads.filter(
    (thread) =>
      thread.title.toLowerCase().includes(query.toLowerCase()),
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
          }}
        /></div>
        <div className="thread-browser-list">
          {filtered.map((thread) => (
            <article key={thread.id}>
              <button type="button" className="thread-browser-open" onClick={() => { onOpen(thread.id); onClose(); }}>
                <span>{thread.title}</span>
                <small>{thread.archived ? "Archived" : "Open thread"}</small>
              </button>
            </article>
          ))}
        </div>
        {!filtered.length ? <p>No matching threads.</p> : null}
      </div>
    </div>
  );
}
