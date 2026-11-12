import HardDrive from "lucide-react/dist/esm/icons/hard-drive.mjs";
import Images from "lucide-react/dist/esm/icons/images.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import Box from "lucide-react/dist/esm/icons/box.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal.mjs";
import { memo, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, Input, MenuItem, NavigationButton } from "./ui/controls";
import type { ImageThread } from "../lib/threads";
import type { AudioThread } from "../lib/ttsThreads";
import type { TextThread } from "../lib/textThreads";

function ThreadActions({
  title,
  kind,
  archived,
  archiveDisabled = false,
  deleteDisabled = false,
  onRename,
  onArchive,
  onDelete,
}: {
  title: string;
  kind: "image" | "text" | "audio";
  archived: boolean;
  archiveDisabled?: boolean;
  deleteDisabled?: boolean;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [position, setPosition] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        setPosition({
          top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 124)),
          right: Math.max(12, window.innerWidth - rect.right),
        });
      }
    };
    updatePosition();
    firstItemRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && rootRef.current && event.target.contains(rootRef.current)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="sidebar-thread-actions" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        className="sidebar-thread-actions-trigger"
        aria-label={`Actions for ${kind} thread ${title}`}
        aria-expanded={open}
        aria-controls={menuId}
        title="Thread actions"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </IconButton>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="sidebar-thread-actions-menu"
              id={menuId}
              role="group"
              aria-label={`Actions for ${title}`}
              style={{ top: position.top, right: position.right }}
            >
              <MenuItem ref={firstItemRef} onClick={() => run(onRename)}>
                Rename
              </MenuItem>
              <MenuItem
                disabled={archiveDisabled}
                onClick={() => run(onArchive)}
              >
                {archived ? "Restore" : "Archive"}
              </MenuItem>
              <MenuItem
                destructive
                disabled={deleteDisabled}
                onClick={() => run(onDelete)}
              >
                Delete
              </MenuItem>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

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
  activeSection: "create" | "tts" | "text" | "library" | "models" | "preferences" | "storage";
  onOpenLibrary: () => void;
  onOpenModels: () => void;
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
  onOpenModels,
  onOpenData,
  onOpenPreferences,
}: StudioSidebarProps) {
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newMenuOpen) return;
    newMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!newMenuRef.current?.contains(event.target as Node)) setNewMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [newMenuOpen]);
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
        <IconButton
          className="sidebar-search-button"
          aria-label="Search threads"
          title="Search threads"
          onClick={onOpenSearch}
        >
          <Search size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="sidebar-new-menu" ref={newMenuRef} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setNewMenuOpen(false);
      }} onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); setNewMenuOpen(false);
          newMenuRef.current?.querySelector<HTMLButtonElement>(".sidebar-new-button")?.focus();
        }
        if (newMenuOpen && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = Array.from(newMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>
        <Button variant="ghost" className="sidebar-new-button" aria-label="New thread" title="New thread" aria-haspopup="menu" aria-expanded={newMenuOpen} aria-controls={newMenuOpen ? "new-thread-menu" : undefined} onClick={() => setNewMenuOpen((value) => !value)} onKeyDown={(event) => {
          if (!newMenuOpen && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setNewMenuOpen(true); }
        }}>
          <Plus size={16} aria-hidden="true" /><span>New thread</span><ChevronDown size={13} className="sidebar-new-chevron" aria-hidden="true" />
        </Button>
        {newMenuOpen ? <div id="new-thread-menu" className="sidebar-new-options" role="menu" aria-label="New thread type">
          {[{ label: "Image", Icon: Images, create: onNewThread }, { label: "Text", Icon: MessageSquare, create: onNewTextThread }, { label: "Audio", Icon: AudioLines, create: onNewAudioThread }].map(({ label, Icon, create }) => <MenuItem className="sidebar-new-option" role="menuitem" key={label} aria-label={`New ${label.toLowerCase()} thread`} title={`New ${label.toLowerCase()} thread`} onClick={() => { setNewMenuOpen(false); create(); }}><Icon size={16} aria-hidden="true" /><span>{label}</span></MenuItem>)}
        </div> : null}
      </div>

      <div className="sidebar-new-divider" />
      <nav className="sidebar-nav" aria-label="Studio">
        <NavigationButton
          className="sidebar-nav-button"
          selected={activeSection === "models"}
          onClick={onOpenModels}
          aria-label="Models"
          title="Install and manage models"
        ><Box size={15} aria-hidden="true" /><span>Models</span></NavigationButton>
        <NavigationButton
          className="sidebar-nav-button"
          selected={activeSection === "library"}
          onClick={onOpenLibrary}
          aria-label="Library"
          aria-controls="recent-renders"
          title="Library · Ctrl L"
        >
          <Images size={15} aria-hidden="true" />
          <span>Library</span>
        </NavigationButton>
      </nav>

      <div className="sidebar-scroll-area" aria-label="Threads">
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
                    event.stopPropagation();
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
                <ThreadActions
                  kind="image"
                  title={thread.title}
                  archived={thread.archived === true}
                  archiveDisabled={
                    deletingBusy || submitting || runningThreadId === thread.id
                  }
                  deleteDisabled={
                    deletingBusy || submitting || runningThreadId === thread.id
                  }
                  onRename={() => {
                    cancelRename.current = false;
                    setDeletingId(null);
                    setThreadName(thread.title);
                    setRenamingId(thread.id);
                  }}
                  onArchive={() => onArchiveThread(thread.id)}
                  onDelete={() =>
                    setDeletingId(deletingId === thread.id ? null : thread.id)
                  }
                />
                {deletingId === thread.id ? (
                  <div
                    className="thread-delete-confirm"
                    role="group"
                    aria-label={`Confirm deletion of ${thread.title}`}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
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
                      <Button
                        variant="secondary"
                        autoFocus
                        onClick={() => {
                          setDeletingId(null);
                          focusThread(thread.id);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
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
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ))}
        {filtered.length > limit ? (
          <Button
            variant="ghost"
            className="text-action"
            onClick={() => setLimit((value) => value + 60)}
          >
            Show more threads
          </Button>
        ) : null}
      </section>

      <section className="sidebar-threads sidebar-text-threads" aria-label="Text threads">
        <div className="sidebar-threads-heading">Text threads</div>
        {!textThreads.filter((thread) => !thread.archived || thread.id === activeTextThreadId).length
          ? <p className="thread-empty">No active text threads.</p> : null}
        {textThreads.filter((thread) => !thread.archived || thread.id === activeTextThreadId).slice(0, textLimit).map((thread) => (
          <div className={`sidebar-thread-row${activeSection === "text" && thread.id === activeTextThreadId ? " is-active" : ""}`} key={thread.id}>
            {renamingId === thread.id ? <Input className="thread-name-input" aria-label="Text thread name" autoFocus maxLength={80} value={threadName} onChange={(event) => setThreadName(event.target.value)} onFocus={(event) => event.target.select()} onBlur={() => { if (!cancelRename.current) onRenameTextThread(thread.id, threadName); setRenamingId(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); cancelRename.current = true; onRenameTextThread(thread.id, threadName); setRenamingId(null); focusThread(thread.id); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename.current = true; setRenamingId(null); focusThread(thread.id); } }} /> : <>
              <button type="button" className="sidebar-thread-button" data-thread-id={thread.id} title={thread.title} aria-label={`Text thread: ${thread.title}${thread.archived ? " (archived)" : ""}`} aria-current={activeSection === "text" && thread.id === activeTextThreadId ? "page" : undefined} aria-description={runningTextThreadId === thread.id ? "Text response running" : undefined} onClick={() => onSelectTextThread(thread.id)}>
                <MessageSquare size={14} aria-hidden="true" /><span>{thread.title}</span>{runningTextThreadId === thread.id ? <span className="thread-running-dot" aria-label="Text response running" /> : null}
              </button>
              <ThreadActions
                kind="text"
                title={thread.title}
                archived={thread.archived === true}
                deleteDisabled={
                  textDeletingBusy || runningTextThreadId === thread.id
                }
                onRename={() => {
                  cancelRename.current = false;
                  setThreadName(thread.title);
                  setRenamingId(thread.id);
                }}
                onArchive={() => onArchiveTextThread(thread.id)}
                onDelete={() => {
                  setTextDeleteError(null);
                  setTextDeleteId(textDeleteId === thread.id ? null : thread.id);
                }}
              />
              {textDeleteId === thread.id ? <div className="thread-delete-confirm" role="group" aria-label={`Confirm deletion of text thread ${thread.title}`} onKeyDown={(event) => { if (event.key === "Escape" && !textDeletingBusy) { event.preventDefault(); event.stopPropagation(); setTextDeleteId(null); setTextDeleteError(null); focusThread(thread.id); } }}><p>Delete this text thread?</p><small>The conversation and its settings will be removed.</small>{textDeleteError && <small role="alert">{textDeleteError}</small>}<div><Button variant="secondary" autoFocus disabled={textDeletingBusy} onClick={() => { setTextDeleteId(null); setTextDeleteError(null); focusThread(thread.id); }}>Cancel</Button><Button variant="danger" disabled={textDeletingBusy || runningTextThreadId === thread.id} onClick={async () => { setTextDeletingBusy(true); setTextDeleteError(null); try { await onDeleteTextThread(thread.id); setTextDeleteId(null); focusThread(); } catch (cause) { setTextDeleteError(cause instanceof Error ? cause.message : "Could not delete this text thread."); } finally { setTextDeletingBusy(false); } }}>{textDeletingBusy ? "Deleting…" : "Delete thread"}</Button></div></div> : null}
            </>}
          </div>
        ))}
        {textThreads.filter((thread) => !thread.archived || thread.id === activeTextThreadId).length > textLimit ? <Button variant="ghost" className="text-action" onClick={() => setTextLimit((value) => value + 60)}>Show more text threads</Button> : null}
      </section>

      <section className="sidebar-threads sidebar-audio-threads" aria-label="Audio threads">
        <div className="sidebar-threads-heading">Audio threads</div>
        {!visibleAudioThreads.length ? <p className="thread-empty">No active audio threads.</p> : null}
        {visibleAudioThreads.slice(0, audioLimit).map((thread) => (
          <div className={`sidebar-thread-row${activeSection === "tts" && thread.id === activeAudioThreadId ? " is-active" : ""}`} key={thread.id}>
            {renamingId === thread.id ? <Input className="thread-name-input" aria-label="Audio thread name" autoFocus maxLength={80} value={threadName} onChange={(event) => setThreadName(event.target.value)} onFocus={(event) => event.target.select()} onBlur={() => { if (!cancelRename.current) onRenameAudioThread(thread.id, threadName); setRenamingId(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); cancelRename.current = true; onRenameAudioThread(thread.id, threadName); setRenamingId(null); focusThread(thread.id); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename.current = true; setRenamingId(null); focusThread(thread.id); } }} /> : <>
              <button type="button" className="sidebar-thread-button" data-thread-id={thread.id} title={thread.title} aria-label={`Audio thread: ${thread.title}${thread.archived ? " (archived)" : ""}`} aria-description={runningAudioThreadId === thread.id ? "Qwen3-TTS job running" : undefined} aria-current={activeSection === "tts" && thread.id === activeAudioThreadId ? "page" : undefined} onClick={() => onSelectAudioThread(thread.id)}>
                <AudioLines size={14} aria-hidden="true" /><span>{thread.title}</span>{runningAudioThreadId === thread.id ? <span className="thread-running-dot" aria-label="Qwen3-TTS job running" /> : null}
              </button>
              <ThreadActions
                kind="audio"
                title={thread.title}
                archived={thread.archived === true}
                deleteDisabled={deletingBusy || runningAudioThreadId === thread.id}
                onRename={() => {
                  cancelRename.current = false;
                  setThreadName(thread.title);
                  setRenamingId(thread.id);
                }}
                onArchive={() => onArchiveAudioThread(thread.id)}
                onDelete={() => {
                  setAudioDeleteError(null);
                  setAudioDeletingId(audioDeletingId === thread.id ? null : thread.id);
                }}
              />
              {audioDeletingId === thread.id ? <div className="thread-delete-confirm" role="group" aria-label={`Confirm deletion of audio thread ${thread.title}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setAudioDeletingId(null); focusThread(thread.id); } }}>
                <p>Delete this audio thread?</p><small>{thread.outputs.length ? `Up to ${thread.outputs.length} WAV ${thread.outputs.length === 1 ? "take" : "takes"} will move to the Recycle Bin. ` : "No WAV files are attached. "}The thread and its settings will be removed.{thread.outputs.length ? " Restoring WAV files later will not restore their cards." : ""}</small>
                {audioDeleteError ? <small role="alert">{audioDeleteError}</small> : null}
                <div><Button variant="secondary" autoFocus disabled={deletingBusy} onClick={() => { setAudioDeletingId(null); focusThread(thread.id); }}>Cancel</Button><Button variant="danger" disabled={deletingBusy || runningAudioThreadId === thread.id} onClick={async () => { setDeletingBusy(true); setAudioDeleteError(null); try { await onDeleteAudioThread(thread.id); setAudioDeletingId(null); focusThread(); } catch (cause) { setAudioDeleteError(cause instanceof Error ? cause.message : "Could not delete this thread."); } finally { setDeletingBusy(false); } }}>{deletingBusy ? "Deleting…" : "Delete thread"}</Button></div>
              </div> : null}
            </>}
          </div>
        ))}
        {visibleAudioThreads.length > audioLimit ? <Button variant="ghost" className="text-action" onClick={() => setAudioLimit((value) => value + 60)}>Show more audio threads</Button> : null}
      </section>

      </div>
      <div className="sidebar-spacer" />

      <nav
        className="sidebar-nav sidebar-nav--secondary"
        aria-label="Application"
      >
        <NavigationButton
          className="sidebar-nav-button"
          selected={activeSection === "storage"}
          onClick={onOpenData}
          aria-label="Local data"
          title="Manage local data"
        >
          <HardDrive size={15} aria-hidden="true" />
          <span>Local data</span>
        </NavigationButton>
        <NavigationButton
          className="sidebar-nav-button"
          selected={activeSection === "preferences"}
          onClick={onOpenPreferences}
          aria-label="Preferences"
          title="Open preferences"
        >
          <Settings2 size={15} aria-hidden="true" />
          <span>Preferences</span>
        </NavigationButton>
      </nav>

    </aside>
  );
});
