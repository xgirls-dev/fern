import Archive from "lucide-react/dist/esm/icons/archive.mjs";
import ArchiveRestore from "lucide-react/dist/esm/icons/archive-restore.mjs";
import HardDrive from "lucide-react/dist/esm/icons/hard-drive.mjs";
import Images from "lucide-react/dist/esm/icons/images.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { memo, useRef, useState } from "react";
import type { ImageThread } from "../lib/threads";

interface StudioSidebarProps {
  threads: Array<Pick<ImageThread, "id" | "title" | "archived">>;
  activeThreadId: string;
  runningThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (id: string) => boolean;
  onArchiveThread: (id: string) => void;
  onOpenSearch: () => void;
  submitting: boolean;
  collapsed: boolean;
  activeSection: "create" | "library" | "preferences" | "storage";
  onOpenLibrary: () => void;
  onOpenData: () => void;
  onOpenPreferences: () => void;
}

export const StudioSidebar = memo(function StudioSidebar({
  threads,
  activeThreadId,
  runningThreadId,
  onSelectThread,
  onNewThread,
  onRenameThread,
  onDeleteThread,
  onArchiveThread,
  onOpenSearch,
  submitting,
  collapsed,
  activeSection,
  onOpenLibrary,
  onOpenData,
  onOpenPreferences,
}: StudioSidebarProps) {
  const [limit, setLimit] = useState(60);
  const filtered = threads.filter((thread) => !thread.archived);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [threadName, setThreadName] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const cancelRename = useRef(false);
  const focusThread = (id?: string) =>
    requestAnimationFrame(() => {
      const buttons = sidebarRef.current?.querySelectorAll<HTMLButtonElement>(
        ".sidebar-thread-button",
      );
      const target =
        Array.from(buttons ?? []).find((button) =>
          id
            ? button.dataset.threadId === id
            : button.getAttribute("aria-current") === "page",
        ) ?? buttons?.[0];
      target?.focus();
    });
  return (
    <aside
      id="studio-sidebar"
      ref={sidebarRef}
      className={`studio-sidebar${collapsed ? " is-collapsed" : ""}`}
      aria-label="Fern navigation"
    >
      <div className="sidebar-brand">
        <svg
          className="sidebar-mark"
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="1" width="22" height="22" rx="7" fill="black" />
          <path
            d="M6 20c5.8-3.7 6.8-9.7 8.7-15.3"
            stroke="#2DD4A3"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path d="m8.3 17.1-3.5-2.8.1 3.4 2.6 1.4Z" fill="#2DD4A3" />
          <path d="m10.7 13.4-3.6-2.5.2 3.4 2.7 1.2Z" fill="#42D77D" />
          <path d="m12.3 9.6-2.9-2.2.1 2.8 2.2 1.1Z" fill="#8EEA3B" />
          <path d="m12 16.8 4.7-.6-1.2 3.2-4.1.2Z" fill="#2DD4A3" />
          <path d="m13.2 12.7 4.1-1-1 3.3-3.7.6Z" fill="#55DC67" />
          <path d="m14.2 8.7 3.1-1-.7 2.8-2.8.7Z" fill="#A3E635" />
          <path d="m15 4.6 2.4-1.7v2.7l-2.5 1.5Z" fill="#FF715B" />
        </svg>
        <div className="sidebar-brand-copy">
          <strong translate="no">Fern</strong>
          <span>Local image studio</span>
        </div>
        <button
          type="button"
          className="sidebar-search-button"
          aria-label="Search threads"
          title="Search threads"
          onClick={onOpenSearch}
        >
          <Search size={16} aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        className="sidebar-new-button"
        onClick={onNewThread}
        aria-label="New thread"
        aria-controls="prompt"
        title="New thread · Ctrl N"
      >
        <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
        <span>New thread</span>
        <span className="sidebar-shortcut">Ctrl N</span>
      </button>

      <div className="sidebar-new-divider" />
      <nav className="sidebar-nav" aria-label="Studio">
        <button
          type="button"
          className={`sidebar-nav-button${activeSection === "library" ? " is-active" : ""}`}
          onClick={onOpenLibrary}
          aria-label="Library"
          aria-controls="recent-renders"
          aria-current={activeSection === "library" ? "page" : undefined}
          title="Library · Ctrl L"
        >
          <Images size={15} aria-hidden="true" />
          <span>Library</span>
        </button>
      </nav>

      <section className="sidebar-threads" aria-label="Threads">
        <div className="sidebar-threads-heading">Threads</div>
        {!filtered.length ? (
          <p className="thread-empty">No active threads.</p>
        ) : null}
        {filtered.slice(0, limit).map((thread) => (
          <div
            className={`sidebar-thread-row${activeSection === "create" && thread.id === activeThreadId ? " is-active" : ""}`}
            key={thread.id}
          >
            {renamingId === thread.id ? (
              <input
                className="thread-name-input"
                aria-label="Thread name"
                autoFocus
                maxLength={80}
                value={threadName}
                onChange={(event) => setThreadName(event.target.value)}
                onFocus={(event) => event.target.select()}
                onBlur={() => {
                  if (!cancelRename.current)
                    onRenameThread(thread.id, threadName);
                  setRenamingId(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    cancelRename.current = true;
                    onRenameThread(thread.id, threadName);
                    setRenamingId(null);
                    focusThread(thread.id);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename.current = true;
                    setRenamingId(null);
                    focusThread(thread.id);
                  }
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="sidebar-thread-button"
                  data-thread-id={thread.id}
                  aria-label={thread.title}
                  aria-description={
                    runningThreadId === thread.id ? "Rendering" : undefined
                  }
                  onClick={() => {
                    setDeletingId(null);
                    onSelectThread(thread.id);
                  }}
                  aria-current={
                    activeSection === "create" && thread.id === activeThreadId
                      ? "page"
                      : undefined
                  }
                  title={thread.title}
                >
                  <MessageSquare size={14} aria-hidden="true" />
                  <span>{thread.title}</span>
                  {runningThreadId === thread.id ? (
                    <span
                      className="thread-running-dot"
                      aria-label="Rendering"
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  className="thread-action thread-rename"
                  title="Rename thread"
                  aria-label={`Rename thread ${thread.title}`}
                  onClick={() => {
                    cancelRename.current = false;
                    setDeletingId(null);
                    setThreadName(thread.title);
                    setRenamingId(thread.id);
                  }}
                >
                  <Pencil size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="thread-action thread-archive"
                  aria-label={`${thread.archived ? "Restore" : "Archive"} thread ${thread.title}`}
                  title={thread.archived ? "Restore thread" : "Archive thread"}
                  onClick={() => onArchiveThread(thread.id)}
                  disabled={submitting || runningThreadId === thread.id}
                >
                  {thread.archived ? (
                    <ArchiveRestore size={14} aria-hidden="true" />
                  ) : (
                    <Archive size={14} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  className="thread-action thread-delete"
                  aria-label={`Delete thread ${thread.title}`}
                  title={
                    runningThreadId === thread.id
                      ? "Stop generation before deleting this thread"
                      : "Delete thread"
                  }
                  disabled={submitting || runningThreadId === thread.id}
                  aria-expanded={deletingId === thread.id}
                  onClick={() =>
                    setDeletingId(deletingId === thread.id ? null : thread.id)
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
                {deletingId === thread.id ? (
                  <div
                    className="thread-delete-confirm"
                    role="group"
                    aria-label={`Confirm deletion of ${thread.title}`}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setDeletingId(null);
                        focusThread(thread.id);
                      }
                    }}
                  >
                    <p>Delete this thread?</p>
                    <small>
                      Its draft and reference will be removed. Generated images
                      stay in Library.
                    </small>
                    <div>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        autoFocus
                        onClick={() => {
                          setDeletingId(null);
                          focusThread(thread.id);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger-outline"
                        disabled={submitting || runningThreadId === thread.id}
                        onClick={() => {
                          if (onDeleteThread(thread.id)) {
                            setDeletingId(null);
                            focusThread();
                          }
                        }}
                      >
                        Delete thread
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ))}
        {filtered.length > limit ? (
          <button
            type="button"
            className="text-action"
            onClick={() => setLimit((value) => value + 60)}
          >
            Show more threads
          </button>
        ) : null}
      </section>

      <div className="sidebar-spacer" />

      <nav
        className="sidebar-nav sidebar-nav--secondary"
        aria-label="Application"
      >
        <button
          type="button"
          className={`sidebar-nav-button${activeSection === "storage" ? " is-active" : ""}`}
          aria-current={activeSection === "storage" ? "page" : undefined}
          onClick={onOpenData}
          aria-label="Local data"
          title="Manage local data"
        >
          <HardDrive size={15} aria-hidden="true" />
          <span>Local data</span>
        </button>
        <button
          type="button"
          className={`sidebar-nav-button${activeSection === "preferences" ? " is-active" : ""}`}
          aria-current={activeSection === "preferences" ? "page" : undefined}
          onClick={onOpenPreferences}
          aria-label="Preferences"
          title="Open preferences"
        >
          <Settings2 size={15} aria-hidden="true" />
          <span>Preferences</span>
        </button>
      </nav>

      <footer className="sidebar-footer">
        <span>Private by default</span>
        <span className="sidebar-footer-dot" aria-hidden="true" />
        <span>On device</span>
      </footer>
    </aside>
  );
});
