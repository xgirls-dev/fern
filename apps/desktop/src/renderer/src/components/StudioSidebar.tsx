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
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import { memo, useRef, useState } from "react";
import type { ImageThread } from "../lib/threads";
import type { AudioThread } from "../lib/ttsThreads";
import type { TextThread } from "../lib/textThreads";

interface StudioSidebarProps {
  threads: Array<Pick<ImageThread, "id" | "title" | "archived">>;
  audioThreads: Array<Pick<AudioThread, "id" | "title" | "archived" | "outputs">>;
  textThreads: Array<Pick<TextThread, "id" | "title" | "archived" | "messages">>;
  activeThreadId: string;
  activeAudioThreadId: string;
  activeTextThreadId: string;
  runningAudioThreadId: string | null;
  runningTextThreadId: string | null;
  runningThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onSelectAudioThread: (id: string) => void;
  onNewAudioThread: () => void;
  onSelectTextThread: (id: string) => void;
  onNewTextThread: () => void;
  onRenameTextThread: (id: string, title: string) => void;
  onArchiveTextThread: (id: string) => void;
  onDeleteTextThread: (id: string) => void;
  onRenameAudioThread: (id: string, title: string) => void;
  onArchiveAudioThread: (id: string) => void;
  onDeleteAudioThread: (id: string) => Promise<void>;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (id: string) => Promise<boolean>;
  onArchiveThread: (id: string) => void;
  onOpenSearch: () => void;
  submitting: boolean;
  collapsed: boolean;
  activeSection: "create" | "tts" | "text" | "library" | "preferences" | "storage";
  onOpenLibrary: () => void;
  onOpenData: () => void;
  onOpenPreferences: () => void;
}

export const StudioSidebar = memo(function StudioSidebar({
  threads,
  audioThreads,
  textThreads,
  activeThreadId,
  activeAudioThreadId,
  activeTextThreadId,
  runningAudioThreadId,
  runningTextThreadId,
  runningThreadId,
  onSelectThread,
  onNewThread,
  onSelectAudioThread,
  onNewAudioThread,
  onSelectTextThread,
  onNewTextThread,
  onRenameTextThread,
  onArchiveTextThread,
  onDeleteTextThread,
  onRenameAudioThread,
  onArchiveAudioThread,
  onDeleteAudioThread,
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
  const [audioLimit, setAudioLimit] = useState(30);
  const [textLimit, setTextLimit] = useState(30);
  const [textDeleteId, setTextDeleteId] = useState<string | null>(null);
  const [textDeletingBusy, setTextDeletingBusy] = useState(false);
  const [textDeleteError, setTextDeleteError] = useState<string | null>(null);
  const filtered = threads.filter((thread) => !thread.archived);
  const visibleAudioThreads = audioThreads.filter((thread) => !thread.archived || thread.id === activeAudioThreadId);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [threadName, setThreadName] = useState("");
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [audioDeletingId, setAudioDeletingId] = useState<string | null>(null);
  const [audioDeleteError, setAudioDeleteError] = useState<string | null>(null);
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
            <span>Your local AI studio</span>
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
        aria-label="New image thread"
        aria-controls="prompt"
        title="New image thread · Ctrl N"
      >
        <Plus size={16} strokeWidth={1.6} aria-hidden="true" />
        <span>New image thread</span>
        <span className="sidebar-shortcut">Ctrl N</span>
      </button>

      <button
        type="button"
        className="sidebar-new-button sidebar-new-audio-button"
        onClick={onNewAudioThread}
        aria-label="New audio thread"
        title="New audio thread · Ctrl Shift N"
      >
        <AudioLines size={16} strokeWidth={1.6} aria-hidden="true" />
        <span>New audio thread</span>
      </button>

      <button
        type="button"
        className="sidebar-new-button sidebar-new-text-button"
        onClick={onNewTextThread}
        aria-label="New text thread"
        title="New text thread · Ctrl Alt N"
      >
        <MessageSquare size={16} strokeWidth={1.6} aria-hidden="true" />
        <span>New text thread</span>
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

      <section className="sidebar-threads" aria-label="Image threads">
        <div className="sidebar-threads-heading">Image threads</div>
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
                  disabled={
                    deletingBusy || submitting || runningThreadId === thread.id
                  }
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
                  disabled={
                    deletingBusy || submitting || runningThreadId === thread.id
                  }
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
                      Its generated images, prompts, settings, and references
                      will be permanently deleted. Images owned by other threads
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
                        disabled={
                          deletingBusy ||
                          submitting ||
                          runningThreadId === thread.id
                        }
                        onClick={async () => {
                          if (deletingBusy) return;
                          setDeletingBusy(true);
                          try {
                            if (await onDeleteThread(thread.id)) {
                              setDeletingId(null);
                              focusThread();
                            }
                          } finally {
                            setDeletingBusy(false);
                          }
                        }}
                      >
                        {deletingBusy ? "Deleting…" : "Delete thread"}
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

      <section className="sidebar-threads sidebar-text-threads" aria-label="Text threads">
        <div className="sidebar-threads-heading">Text threads</div>
        {!textThreads.filter((thread) => !thread.archived || thread.id === activeTextThreadId).length
          ? <p className="thread-empty">No active text threads.</p> : null}
        {textThreads.filter((thread) => !thread.archived || thread.id === activeTextThreadId).slice(0, textLimit).map((thread) => (
          <div className={`sidebar-thread-row${activeSection === "text" && thread.id === activeTextThreadId ? " is-active" : ""}`} key={thread.id}>
            {renamingId === thread.id ? <input className="thread-name-input" aria-label="Text thread name" autoFocus maxLength={80} value={threadName} onChange={(event) => setThreadName(event.target.value)} onFocus={(event) => event.target.select()} onBlur={() => { if (!cancelRename.current) onRenameTextThread(thread.id, threadName); setRenamingId(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); cancelRename.current = true; onRenameTextThread(thread.id, threadName); setRenamingId(null); focusThread(thread.id); } if (event.key === "Escape") { event.preventDefault(); cancelRename.current = true; setRenamingId(null); focusThread(thread.id); } }} /> : <>
              <button type="button" className="sidebar-thread-button" data-thread-id={thread.id} title={thread.title} aria-label={`Text thread: ${thread.title}${thread.archived ? " (archived)" : ""}`} aria-current={activeSection === "text" && thread.id === activeTextThreadId ? "page" : undefined} aria-description={runningTextThreadId === thread.id ? "Text response running" : undefined} onClick={() => onSelectTextThread(thread.id)}>
                <MessageSquare size={14} aria-hidden="true" /><span>{thread.title}</span>{runningTextThreadId === thread.id ? <span className="thread-running-dot" aria-label="Text response running" /> : null}
              </button>
              <button type="button" className="thread-action thread-rename" title="Rename text thread" aria-label={`Rename text thread ${thread.title}`} onClick={() => { cancelRename.current = false; setThreadName(thread.title); setRenamingId(thread.id); }}><Pencil size={12} aria-hidden="true" /></button>
              <button type="button" className="thread-action thread-archive" title={thread.archived ? "Restore text thread" : "Archive text thread"} aria-label={`${thread.archived ? "Restore" : "Archive"} text thread ${thread.title}`} onClick={() => onArchiveTextThread(thread.id)}>{thread.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}</button>
              <button type="button" className="thread-action thread-delete" title={runningTextThreadId === thread.id ? "Stop the response before deleting" : "Delete text thread"} aria-label={`Delete text thread ${thread.title}`} aria-expanded={textDeleteId === thread.id} disabled={textDeletingBusy || runningTextThreadId === thread.id} onClick={() => { setTextDeleteError(null); setTextDeleteId(textDeleteId === thread.id ? null : thread.id); }}><Trash2 size={13} aria-hidden="true" /></button>
              {textDeleteId === thread.id ? <div className="thread-delete-confirm" role="group" aria-label={`Confirm deletion of text thread ${thread.title}`} onKeyDown={(event) => { if (event.key === "Escape" && !textDeletingBusy) { setTextDeleteId(null); setTextDeleteError(null); focusThread(thread.id); } }}><p>Delete this text thread?</p><small>The conversation and its settings will be removed.</small>{textDeleteError && <small role="alert">{textDeleteError}</small>}<div><button type="button" className="btn btn-secondary" autoFocus disabled={textDeletingBusy} onClick={() => { setTextDeleteId(null); setTextDeleteError(null); focusThread(thread.id); }}>Cancel</button><button type="button" className="btn btn-danger-outline" disabled={textDeletingBusy || runningTextThreadId === thread.id} onClick={async () => { setTextDeletingBusy(true); setTextDeleteError(null); try { await onDeleteTextThread(thread.id); setTextDeleteId(null); focusThread(); } catch (cause) { setTextDeleteError(cause instanceof Error ? cause.message : "Could not delete this text thread."); } finally { setTextDeletingBusy(false); } }}>{textDeletingBusy ? "Deleting…" : "Delete thread"}</button></div></div> : null}
            </>}
          </div>
        ))}
        {textThreads.filter((thread) => !thread.archived || thread.id === activeTextThreadId).length > textLimit ? <button type="button" className="text-action" onClick={() => setTextLimit((value) => value + 60)}>Show more text threads</button> : null}
      </section>

      <section className="sidebar-threads sidebar-audio-threads" aria-label="Audio threads">
        <div className="sidebar-threads-heading">Audio threads</div>
        {!visibleAudioThreads.length ? <p className="thread-empty">No active audio threads.</p> : null}
        {visibleAudioThreads.slice(0, audioLimit).map((thread) => (
          <div className={`sidebar-thread-row${activeSection === "tts" && thread.id === activeAudioThreadId ? " is-active" : ""}`} key={thread.id}>
            {renamingId === thread.id ? <input className="thread-name-input" aria-label="Audio thread name" autoFocus maxLength={80} value={threadName} onChange={(event) => setThreadName(event.target.value)} onFocus={(event) => event.target.select()} onBlur={() => { if (!cancelRename.current) onRenameAudioThread(thread.id, threadName); setRenamingId(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); cancelRename.current = true; onRenameAudioThread(thread.id, threadName); setRenamingId(null); focusThread(thread.id); } if (event.key === "Escape") { event.preventDefault(); cancelRename.current = true; setRenamingId(null); focusThread(thread.id); } }} /> : <>
              <button type="button" className="sidebar-thread-button" data-thread-id={thread.id} title={thread.title} aria-label={`Audio thread: ${thread.title}${thread.archived ? " (archived)" : ""}`} aria-description={runningAudioThreadId === thread.id ? "Qwen3-TTS job running" : undefined} aria-current={activeSection === "tts" && thread.id === activeAudioThreadId ? "page" : undefined} onClick={() => onSelectAudioThread(thread.id)}>
                <AudioLines size={14} aria-hidden="true" /><span>{thread.title}</span>{runningAudioThreadId === thread.id ? <span className="thread-running-dot" aria-label="Qwen3-TTS job running" /> : null}
              </button>
              <button type="button" className="thread-action thread-rename" title="Rename audio thread" aria-label={`Rename audio thread ${thread.title}`} onClick={() => { cancelRename.current = false; setThreadName(thread.title); setRenamingId(thread.id); }}><Pencil size={12} aria-hidden="true" /></button>
              <button type="button" className="thread-action thread-archive" aria-label={`${thread.archived ? "Restore" : "Archive"} audio thread ${thread.title}`} title={thread.archived ? "Restore audio thread" : "Archive audio thread"} onClick={() => onArchiveAudioThread(thread.id)}>{thread.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}</button>
              <button type="button" className="thread-action thread-delete" aria-label={`Delete audio thread ${thread.title}`} aria-expanded={audioDeletingId === thread.id} title={runningAudioThreadId === thread.id ? "Stop audio before deleting this thread" : "Delete audio thread"} disabled={deletingBusy || runningAudioThreadId === thread.id} onClick={() => { setAudioDeleteError(null); setAudioDeletingId(audioDeletingId === thread.id ? null : thread.id); }}><Trash2 size={13} aria-hidden="true" /></button>
              {audioDeletingId === thread.id ? <div className="thread-delete-confirm" role="group" aria-label={`Confirm deletion of audio thread ${thread.title}`} onKeyDown={(event) => { if (event.key === "Escape") { setAudioDeletingId(null); focusThread(thread.id); } }}>
                <p>Delete this audio thread?</p><small>{thread.outputs.length ? `Up to ${thread.outputs.length} WAV ${thread.outputs.length === 1 ? "take" : "takes"} will move to the Recycle Bin. ` : "No WAV files are attached. "}The thread and its settings will be removed.{thread.outputs.length ? " Restoring WAV files later will not restore their cards." : ""}</small>
                {audioDeleteError ? <small role="alert">{audioDeleteError}</small> : null}
                <div><button type="button" className="btn btn-secondary" autoFocus disabled={deletingBusy} onClick={() => { setAudioDeletingId(null); focusThread(thread.id); }}>Cancel</button><button type="button" className="btn btn-danger-outline" disabled={deletingBusy || runningAudioThreadId === thread.id} onClick={async () => { setDeletingBusy(true); setAudioDeleteError(null); try { await onDeleteAudioThread(thread.id); setAudioDeletingId(null); focusThread(); } catch (cause) { setAudioDeleteError(cause instanceof Error ? cause.message : "Could not delete this thread."); } finally { setDeletingBusy(false); } }}>{deletingBusy ? "Deleting…" : "Delete thread"}</button></div>
              </div> : null}
            </>}
          </div>
        ))}
        {visibleAudioThreads.length > audioLimit ? <button type="button" className="text-action" onClick={() => setAudioLimit((value) => value + 60)}>Show more audio threads</button> : null}
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
