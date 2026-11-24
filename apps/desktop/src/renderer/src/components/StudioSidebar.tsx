import Clapperboard from "lucide-react/dist/esm/icons/clapperboard.mjs";
import { trashName } from "../lib/trash";
import { shortcutLabel, shortcuts } from "../lib/workspaceNavigation";
import HardDrive from "lucide-react/dist/esm/icons/hard-drive.mjs";
import Images from "lucide-react/dist/esm/icons/images.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import Box from "lucide-react/dist/esm/icons/box.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus.mjs";
import { memo, useRef, useState, type DragEvent, type RefObject } from "react";
import { Button, IconButton, Input, NavigationButton } from "./ui/controls";
import { Dropdown, DropdownItem, DropdownSeparator, useDropdownActions } from "./ui/Dropdown";
import { Tooltip, TooltipIconButton, TooltipScope } from "./ui/Tooltip";
import type { ImageThread } from "../lib/threads";
import { hasAudioThreadWork, type AudioThread } from "../lib/ttsThreads";
import type { TextSidebarRow } from "../hooks/useTextChat";
import type { TranscriptDestination } from "../lib/textTranscript";
import { canMoveChatFolder, CHAT_NAV_DRAG, chatFolderPath, chatFolderRows, type ChatFolder, type ChatOrganizationAction } from "../lib/chatFolders";
import { ChatFolderDialog, type ChatFolderDialogRequest } from "./ChatFolderDialog";

type DraggedChatRow = { type: "move-chat" | "move-folder"; id: string; parentId?: string };

function ThreadActions({
  title,
  kind,
  archived,
  archiveDisabled = false,
  deleteDisabled = false,
  onRename,
  onDuplicate,
  onExport,
  onArchive,
  onDelete,
  onMove,
  onNewChat,
  onNewFolder,
}: {
  title: string;
  kind: "image" | "text" | "audio" | "folder";
  archived?: boolean;
  archiveDisabled?: boolean;
  deleteDisabled?: boolean;
  onRename: () => void;
  onDuplicate?: () => void;
  onExport?: (destination: TranscriptDestination) => void;
  onArchive?: () => void;
  onDelete: () => void;
  onMove?: () => void;
  onNewChat?: () => void;
  onNewFolder?: () => void;
}) {
  const { trigger, choose, menuProps } = useDropdownActions();
  return <div className="sidebar-thread-actions">
    <Dropdown label={`Actions for ${title}`} align="end" className="sidebar-thread-actions-menu"
      triggerTooltip={kind === "folder" ? "Folder actions" : "Thread actions"}
      {...menuProps}
      trigger={<IconButton ref={trigger} className="sidebar-thread-actions-trigger"
        aria-label={kind === "folder" ? `Actions for folder ${title}` : `Actions for ${kind} thread ${title}`}>
        <MoreHorizontal size={16} aria-hidden="true" />
      </IconButton>}>
      <DropdownItem onClick={() => choose(onRename)}>Rename</DropdownItem>
      {onDuplicate && <DropdownItem onClick={() => choose(onDuplicate)}>Duplicate</DropdownItem>}
      {onExport && <>
        <DropdownItem onClick={() => choose(() => onExport("clipboard"))}>Copy transcript</DropdownItem>
        <DropdownItem onClick={() => choose(() => onExport("file"))}>Save Markdown…</DropdownItem>
      </>}
      {onNewChat && <DropdownItem onClick={() => choose(onNewChat)}>New chat here</DropdownItem>}
      {onNewFolder && <DropdownItem onClick={() => choose(onNewFolder)}>New subfolder</DropdownItem>}
      {onMove && <DropdownItem onClick={() => choose(onMove)}>Move to folder…</DropdownItem>}
      <DropdownSeparator />
      {onArchive && <DropdownItem disabled={archiveDisabled} onClick={() => choose(onArchive)}>
        {archived ? "Restore" : "Archive"}
      </DropdownItem>}
      <DropdownItem destructive disabled={deleteDisabled} onClick={() => choose(onDelete)}>
        {kind === "folder" ? "Delete folder" : "Delete"}
      </DropdownItem>
    </Dropdown>
  </div>;
}

interface StudioSidebarProps {
  sidebarRef: RefObject<HTMLElement | null>;
  onNavigate: () => void;
  onExpandForNew?: () => void;
  threads: Array<Pick<ImageThread, "id" | "title" | "archived"> & { hasWork: boolean }>;
  audioThreads: Array<Pick<AudioThread, "id" | "title" | "archived" | "outputs" | "text" | "renamed" | "designInstruction" | "instruction" | "referenceText">>;
  textThreads: readonly TextSidebarRow[];
  chatFolders: readonly ChatFolder[];
  onOrganizeChats: (action: ChatOrganizationAction) => void;
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
  onNewTextThread: (folderId?: string) => void;
  onRenameTextThread: (id: string, title: string) => void;
  onDuplicateTextThread: (id: string) => void;
  onExportTextThread: (id: string, destination: TranscriptDestination) => void;
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
  onOpenVideo: () => void;
  activeSection: "create" | "tts" | "text" | "video" | "library" | "models" | "preferences" | "storage";
  onOpenLibrary: () => void;
  openingImages: boolean;
  onOpenModels: () => void;
  onOpenData: () => void;
  onOpenPreferences: () => void;
}

export const StudioSidebar = memo(function StudioSidebar({
  sidebarRef,
  onNavigate,
  onExpandForNew,
  threads,
  audioThreads,
  textThreads,
  chatFolders,
  onOrganizeChats,
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
  onDuplicateTextThread,
  onExportTextThread,
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
  openingImages,
  onOpenModels,
  onOpenVideo,
  onOpenData,
  onOpenPreferences,
}: StudioSidebarProps) {
  const newThreadButton = useRef<HTMLButtonElement>(null);
  const pendingCreation = useRef<(() => void) | null>(null);
  const [limit, setLimit] = useState(60);
  const [audioLimit, setAudioLimit] = useState(30);
  const [textLimit, setTextLimit] = useState(30);
  const [textDeleteId, setTextDeleteId] = useState<string | null>(null);
  const [textDeletingBusy, setTextDeletingBusy] = useState(false);
  const [textDeleteError, setTextDeleteError] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<ChatFolderDialogRequest | null>(null);
  const [draggedChat, setDraggedChat] = useState<DraggedChatRow | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const folderIndex = new Map(chatFolders.map((folder) => [folder.id, folder]));
  const filtered = threads.filter((thread) => !thread.archived && (
    (activeSection === "create" && thread.id === activeThreadId) || thread.id === runningThreadId || thread.hasWork
  ));
  const visibleAudioThreads = audioThreads.filter((thread) =>
    (activeSection === "tts" && thread.id === activeAudioThreadId) || (!thread.archived && (
      thread.id === runningAudioThreadId || hasAudioThreadWork(thread)
    ))
  );
  const visibleTextThreads = textThreads.filter((thread) =>
    (activeSection === "text" && thread.id === activeTextThreadId)
    || (!thread.archived && (thread.id === runningTextThreadId || thread.hasWork))
  );
  const chatRows = chatFolderRows(chatFolders, visibleTextThreads);
  const showMoreChats = chatRows.filter((row) => row.kind === "chat").length > textLimit;
  let chatCount = 0;
  const displayedChatRows = chatRows.filter((row) => row.kind === "folder" || ++chatCount <= textLimit || row.item.id === activeTextThreadId);
  const stopDrag = () => { setDraggedChat(null); setDropTarget(null); };
  const startDrag = (event: DragEvent, row: DraggedChatRow) => {
    event.dataTransfer.setData(CHAT_NAV_DRAG, row.id);
    event.dataTransfer.effectAllowed = "move";
    setDraggedChat(row);
  };
  const dropHandlers = (folderId?: string) => {
    const target = folderId ?? "root";
    const validDrop = (event: DragEvent) => draggedChat && draggedChat.parentId !== folderId
      && event.dataTransfer.types.includes(CHAT_NAV_DRAG)
      && (draggedChat.type === "move-chat" || canMoveChatFolder(folderIndex, draggedChat.id, folderId));
    return {
      "data-chat-drop": dropTarget === target ? "active" : undefined,
      onDragOver: (event: DragEvent) => {
        if (!validDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(target);
      },
      onDragLeave: (event: DragEvent) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropTarget((current) => current === target ? null : current);
      },
      onDrop: (event: DragEvent) => {
        if (!draggedChat || !validDrop(event)) return;
        event.preventDefault();
        onOrganizeChats({ ...draggedChat, parentId: folderId });
        stopDrag();
      },
    };
  };
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [threadName, setThreadName] = useState("");
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [audioDeletingId, setAudioDeletingId] = useState<string | null>(null);
  const [audioDeleteError, setAudioDeleteError] = useState<string | null>(null);
  const cancelRename = useRef(false);
  const navigate = (action: () => void) => {
    onNavigate();
    action();
  };
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
    <TooltipScope><aside
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
        <TooltipIconButton
          className="sidebar-search-button"
          aria-label="Search threads"
          tooltip="Search threads"
          onClick={onOpenSearch}
        >
          <Search size={16} aria-hidden="true" />
        </TooltipIconButton>
      </div>

      <div className="sidebar-new-menu">
        <Dropdown label="New thread type" className="sidebar-new-options" triggerTooltip="New thread"
          onOpenChange={(open) => { if (open) onExpandForNew?.(); }}
          onOpenChangeComplete={(open) => {
            if (open || !pendingCreation.current) return;
            const create = pendingCreation.current;
            pendingCreation.current = null;
            // Let the menu return focus before the new workspace focuses its composer.
            requestAnimationFrame(() => navigate(create));
          }}
          trigger={<Button ref={newThreadButton} variant="ghost" className="sidebar-new-button" aria-label="New thread">
            <Plus size={16} aria-hidden="true" /><span>New thread</span>
            <ChevronDown size={13} className="sidebar-new-chevron" aria-hidden="true" />
          </Button>}
        >
          {[
            { label: shortcuts.image.label, Icon: Images, create: onNewThread },
            { label: shortcuts.chat.label, Icon: MessageSquare, create: onNewTextThread },
            { label: shortcuts.speech.label, Icon: AudioLines, create: onNewAudioThread },
          ].map(({ label, Icon, create }) => <DropdownItem key={label} onClick={() => { pendingCreation.current = create; }}>
            <Icon size={16} aria-hidden="true" /><span>{label}</span>
          </DropdownItem>)}
          <DropdownItem onClick={() => {
            newThreadButton.current?.focus();
            setFolderDialog({ type: "create" });
          }}><FolderPlus size={16} aria-hidden="true" /><span>Chat folder</span></DropdownItem>
        </Dropdown>
      </div>

      <div className="sidebar-new-divider" />
      <nav className="sidebar-nav" aria-label="Studio">
        <Tooltip content="Install and manage models" side="right"><NavigationButton
          className="sidebar-nav-button"
          selected={activeSection === "models"}
          onClick={() => navigate(onOpenModels)}
          aria-label="Models"
        ><Box size={15} aria-hidden="true" /><span>Models</span></NavigationButton></Tooltip>
        <Tooltip content={`Images · ${shortcutLabel(shortcuts.images)}`} side="right"><NavigationButton
          className="sidebar-nav-button"
          selected={activeSection === "library"}
          onClick={() => navigate(onOpenLibrary)}
          aria-label="Images"
          aria-busy={openingImages || undefined}
        >
          {openingImages ? <LoaderCircle className="spinner" size={15} aria-hidden="true" /> : <Images size={15} aria-hidden="true" />}
          <span>{openingImages ? "Opening Images…" : "Images"}</span>
        </NavigationButton></Tooltip>
        <Tooltip content="Create and play videos" side="right"><NavigationButton className="sidebar-nav-button" selected={activeSection === "video"}
          onClick={() => navigate(onOpenVideo)} aria-label="Video">
          <Clapperboard size={15} aria-hidden="true" /><span>Video</span>
        </NavigationButton></Tooltip>
      </nav>

      {!collapsed && <div className="sidebar-scroll-area" role="group" aria-label="Threads">
      {filtered.length > 0 && <section className="sidebar-threads" aria-label="Image threads">
        <div className="sidebar-threads-heading">Image threads</div>
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
                    navigate(() => onSelectThread(thread.id));
                  }}
                  aria-current={
                    activeSection === "create" && thread.id === activeThreadId
                      ? "page"
                      : undefined
                  }
                  title={thread.title}
                >
                  <Images size={14} aria-hidden="true" />
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
      </section>}

      {(visibleTextThreads.length > 0 || chatFolders.length > 0) && <section className="sidebar-threads sidebar-text-threads" aria-label="Text threads">
        <div className="sidebar-threads-heading sidebar-chat-heading" {...dropHandlers()}>
          <span>Chats</span>
          <TooltipIconButton className="sidebar-chat-add-folder" aria-label="New chat folder" tooltip="New chat folder"
            onClick={() => setFolderDialog({ type: "create" })}><FolderPlus size={14} aria-hidden="true" /></TooltipIconButton>
        </div>
        {displayedChatRows.map((row) => {
          const style = row.depth > 0 ? { marginInlineStart: Math.min(row.depth, 7) * 12 } : undefined;
          if (row.kind === "folder") {
            const folder = row.item;
            const Chevron = folder.collapsed ? ChevronRight : ChevronDown;
            const FolderIcon = folder.collapsed ? Folder : FolderOpen;
            const movable = folder.parentId || chatFolders.some((target) =>
              target.id !== folder.id && canMoveChatFolder(folderIndex, folder.id, target.id));
            return <div className="sidebar-thread-row sidebar-chat-folder" key={folder.id} style={style} {...dropHandlers(folder.id)}>
              <button type="button" className="sidebar-thread-button" title={chatFolderPath(folderIndex, folder.id)}
                aria-expanded={!folder.collapsed}
                draggable onDragStart={(event) => startDrag(event, { type: "move-folder", id: folder.id, parentId: folder.parentId })}
                onDragEnd={stopDrag} onClick={() => onOrganizeChats({ type: "toggle", id: folder.id })}>
                <Chevron size={12} aria-hidden="true" /><FolderIcon size={14} aria-hidden="true" /><span>{folder.name}</span>
              </button>
              <ThreadActions kind="folder" title={folder.name}
                onNewChat={() => navigate(() => onNewTextThread(folder.id))}
                onNewFolder={() => setFolderDialog({ type: "create", parentId: folder.id })}
                onRename={() => setFolderDialog({ type: "rename", id: folder.id, name: folder.name })}
                onMove={movable ? () => setFolderDialog({ type: "move-folder", id: folder.id, name: folder.name, parentId: folder.parentId }) : undefined}
                onDelete={() => setFolderDialog({ type: "delete", id: folder.id, name: folder.name })} />
            </div>;
          }
          const thread = row.item;
          return <div className={`sidebar-thread-row${row.depth ? " sidebar-chat-nested" : ""}${activeSection === "text" && thread.id === activeTextThreadId ? " is-active" : ""}`} key={thread.id} style={style}>
            {renamingId === thread.id ? <Input className="thread-name-input" aria-label="Text thread name" autoFocus maxLength={80} value={threadName} onChange={(event) => setThreadName(event.target.value)} onFocus={(event) => event.target.select()} onBlur={() => { if (!cancelRename.current) onRenameTextThread(thread.id, threadName); setRenamingId(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); cancelRename.current = true; onRenameTextThread(thread.id, threadName); setRenamingId(null); focusThread(thread.id); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename.current = true; setRenamingId(null); focusThread(thread.id); } }} /> : <>
              <button type="button" className="sidebar-thread-button" data-thread-id={thread.id} title={thread.title} aria-label={`Text thread: ${thread.title}${thread.archived ? " (archived)" : ""}`} aria-current={activeSection === "text" && thread.id === activeTextThreadId ? "page" : undefined} aria-description={runningTextThreadId === thread.id ? "Text response running" : undefined}
                draggable
                onDragStart={(event) => startDrag(event, { type: "move-chat", id: thread.id, parentId: thread.folderId })}
                onDragEnd={stopDrag} onClick={() => navigate(() => onSelectTextThread(thread.id))}>
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
                onMove={chatFolders.length ? () => setFolderDialog({ type: "move-chat", id: thread.id, name: thread.title, parentId: thread.folderId }) : undefined}
                onDuplicate={() => navigate(() => onDuplicateTextThread(thread.id))}
                onExport={thread.hasTranscript ? (destination) => onExportTextThread(thread.id, destination) : undefined}
                onDelete={() => {
                  setTextDeleteError(null);
                  setTextDeleteId(textDeleteId === thread.id ? null : thread.id);
                }}
              />
              {textDeleteId === thread.id ? <div className="thread-delete-confirm" role="group" aria-label={`Confirm deletion of text thread ${thread.title}`} onKeyDown={(event) => { if (event.key === "Escape" && !textDeletingBusy) { event.preventDefault(); event.stopPropagation(); setTextDeleteId(null); setTextDeleteError(null); focusThread(thread.id); } }}><p>Delete this text thread?</p><small>The conversation and its settings will be removed.</small>{textDeleteError && <small role="alert">{textDeleteError}</small>}<div><Button variant="secondary" autoFocus disabled={textDeletingBusy} onClick={() => { setTextDeleteId(null); setTextDeleteError(null); focusThread(thread.id); }}>Cancel</Button><Button variant="danger" disabled={textDeletingBusy || runningTextThreadId === thread.id} onClick={async () => { setTextDeletingBusy(true); setTextDeleteError(null); try { await onDeleteTextThread(thread.id); setTextDeleteId(null); focusThread(); } catch (cause) { setTextDeleteError(cause instanceof Error ? cause.message : "Could not delete this text thread."); } finally { setTextDeletingBusy(false); } }}>{textDeletingBusy ? "Deleting…" : "Delete thread"}</Button></div></div> : null}
            </>}
          </div>;
        })}
        {showMoreChats ? <Button variant="ghost" className="text-action" onClick={() => setTextLimit((value) => value + 60)}>Show more text threads</Button> : null}
      </section>}
      {folderDialog && <ChatFolderDialog request={folderDialog} folders={chatFolders}
        onSubmit={onOrganizeChats} onClose={() => setFolderDialog(null)} />}

      {visibleAudioThreads.length > 0 && <section className="sidebar-threads sidebar-audio-threads" aria-label="Audio threads">
        <div className="sidebar-threads-heading">Speech threads</div>
        {visibleAudioThreads.slice(0, audioLimit).map((thread) => (
          <div className={`sidebar-thread-row${activeSection === "tts" && thread.id === activeAudioThreadId ? " is-active" : ""}`} key={thread.id}>
            {renamingId === thread.id ? <Input className="thread-name-input" aria-label="Audio thread name" autoFocus maxLength={80} value={threadName} onChange={(event) => setThreadName(event.target.value)} onFocus={(event) => event.target.select()} onBlur={() => { if (!cancelRename.current) onRenameAudioThread(thread.id, threadName); setRenamingId(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); cancelRename.current = true; onRenameAudioThread(thread.id, threadName); setRenamingId(null); focusThread(thread.id); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename.current = true; setRenamingId(null); focusThread(thread.id); } }} /> : <>
              <button type="button" className="sidebar-thread-button" data-thread-id={thread.id} title={thread.title} aria-label={`Audio thread: ${thread.title}${thread.archived ? " (archived)" : ""}`} aria-description={runningAudioThreadId === thread.id ? "Qwen3-TTS job running" : undefined} aria-current={activeSection === "tts" && thread.id === activeAudioThreadId ? "page" : undefined} onClick={() => navigate(() => onSelectAudioThread(thread.id))}>
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
                <p>Delete this audio thread?</p><small>{thread.outputs.length ? `Up to ${thread.outputs.length} WAV ${thread.outputs.length === 1 ? "take" : "takes"} will move to ${trashName}. ` : "No WAV files are attached. "}The thread and its settings will be removed.{thread.outputs.length ? " Restoring WAV files later will not restore their cards." : ""}</small>
                {audioDeleteError ? <small role="alert">{audioDeleteError}</small> : null}
                <div><Button variant="secondary" autoFocus disabled={deletingBusy} onClick={() => { setAudioDeletingId(null); focusThread(thread.id); }}>Cancel</Button><Button variant="danger" disabled={deletingBusy || runningAudioThreadId === thread.id} onClick={async () => { setDeletingBusy(true); setAudioDeleteError(null); try { await onDeleteAudioThread(thread.id); setAudioDeletingId(null); focusThread(); } catch (cause) { setAudioDeleteError(cause instanceof Error ? cause.message : "Could not delete this thread."); } finally { setDeletingBusy(false); } }}>{deletingBusy ? "Deleting…" : "Delete thread"}</Button></div>
              </div> : null}
            </>}
          </div>
        ))}
        {visibleAudioThreads.length > audioLimit ? <Button variant="ghost" className="text-action" onClick={() => setAudioLimit((value) => value + 60)}>Show more audio threads</Button> : null}
      </section>}

      </div>}
      <div className="sidebar-spacer" />

      <nav
        className="sidebar-nav sidebar-nav--secondary"
        aria-label="Application"
      >
        <Tooltip content="Manage local data" side="right"><NavigationButton
          className="sidebar-nav-button"
          selected={activeSection === "storage"}
          onClick={() => navigate(onOpenData)}
          aria-label="Local data"
        >
          <HardDrive size={15} aria-hidden="true" />
          <span>Local data</span>
        </NavigationButton></Tooltip>
        <Tooltip content="Open preferences" side="right"><NavigationButton
          className="sidebar-nav-button"
          selected={activeSection === "preferences"}
          onClick={() => navigate(onOpenPreferences)}
          aria-label="Preferences"
        >
          <Settings2 size={15} aria-hidden="true" />
          <span>Preferences</span>
        </NavigationButton></Tooltip>
      </nav>

    </aside></TooltipScope>
  );
});
