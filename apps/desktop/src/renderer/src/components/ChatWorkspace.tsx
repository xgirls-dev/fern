import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { CHAT_NAV_DRAG, chatFolderPath } from "../lib/chatFolders";
import type { ChatPane } from "../lib/textThreads";
import { TextWorkspace, type TextWorkspaceProps } from "./TextWorkspace";
import { ThreadBrowser } from "./ThreadBrowser";
import { SegmentedControl } from "./ui/controls";
import { ResizeHandle } from "./ui/ResizeHandle";
import { TooltipScope } from "./ui/Tooltip";

type WorkspaceProps = Omit<TextWorkspaceProps,
  "thread" | "pane" | "focused" | "split" | "replyAnnouncementRoot" | "onChooseChat" | "onClosePane" | "onOpenRunningChat"
> & {
  storagePlaceholder: ReactNode;
};

export function ChatWorkspace({ storagePlaceholder, ...props }: WorkspaceProps) {
  const { studio } = props;
  const { primaryThread, secondaryThread, activePane } = studio;
  const split = Boolean(secondaryThread);
  const layout = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const restoreRunningChatFocus = useRef<string | null>(null);
  const primaryPaneId = useId();
  const [replyAnnouncementRoot, setReplyAnnouncementRoot] = useState<HTMLDivElement | null>(null);
  const [picker, setPicker] = useState<ChatPane | null>(null);
  const [dragSize, setDragSize] = useState<number | null>(null);
  const [dropPane, setDropPane] = useState<ChatPane | null>(null);
  const visibleThreadId = activePane === "primary" ? primaryThread.id : secondaryThread?.id;
  useLayoutEffect(() => {
    if (restoreRunningChatFocus.current !== visibleThreadId) return;
    restoreRunningChatFocus.current = null;
    layout.current?.querySelector<HTMLTextAreaElement>(`[data-chat-pane="${activePane}"] textarea[name="message"]`)
      ?.focus({ preventScroll: true });
  }, [activePane, visibleThreadId]);
  // Keep the composer unmounted until the saved draft is ready.
  if (!studio.storageReady) return storagePlaceholder;

  const ratio = dragSize ?? studio.splitPercent;
  const folderIndex = new Map(studio.folders.map((folder) => [folder.id, folder]));
  const otherThread = picker === "primary" ? secondaryThread : primaryThread;
  const pickerThreads = picker ? studio.threads
    .filter((thread) => !thread.archived && thread.id !== otherThread?.id)
    .map((thread) => ({
      id: thread.id, title: thread.title, archived: false,
      excerpt: thread.messages.find(({ role }) => role === "user")?.content || thread.draft,
      folderPath: chatFolderPath(folderIndex, thread.folderId),
    })) : [];

  const focusComposer = (pane: ChatPane) => requestAnimationFrame(() => {
    layout.current?.querySelector<HTMLTextAreaElement>(`[data-chat-pane="${pane}"] textarea[name="message"]`)?.focus();
  });
  const select = (id: string, pane: ChatPane) => {
    studio.compareThread(id, pane);
    focusComposer(pane);
  };
  const openRunningChat = (id: string) => {
    restoreRunningChatFocus.current = id;
    studio.selectThread(id);
  };
  const percentAt = (clientX: number) => {
    const bounds = layout.current?.getBoundingClientRect();
    return bounds?.width ? (clientX - bounds.left) / bounds.width * 100 : studio.splitPercent;
  };
  const destination = (event: DragEvent): ChatPane => {
    if (split && !divider.current?.getClientRects().length) return activePane;
    return percentAt(event.clientX) < (split ? ratio : 50) ? "primary" : "secondary";
  };
  const handlesChat = (event: DragEvent) => event.dataTransfer.types.includes(CHAT_NAV_DRAG);

  return <TooltipScope><div className="chat-split-shell">
    <div className="sr-only" ref={setReplyAnnouncementRoot} />
    {split && <div className="chat-pane-switcher">
      <SegmentedControl label="Chat panes" value={activePane} options={[
        { value: "primary", label: "Left chat" },
        { value: "secondary", label: "Right chat" },
      ]} onChange={studio.focusPane} />
    </div>}
    <div className={`chat-split-layout${split ? " is-split" : ""}`} ref={layout}
      style={{ "--chat-split-width": `${ratio}%` } as CSSProperties}
      onDragOver={(event) => {
        if (!handlesChat(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropPane(destination(event));
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropPane(null);
      }}
      onDrop={(event) => {
        if (!handlesChat(event)) return;
        event.preventDefault();
        const id = event.dataTransfer.getData(CHAT_NAV_DRAG);
        setDropPane(null);
        if (studio.threads.some((thread) => thread.id === id)) select(id, destination(event));
      }}>
      <div id={primaryPaneId} className="chat-pane" data-chat-pane="primary" data-focused={activePane === "primary"}
        onPointerDownCapture={() => studio.focusPane("primary")} onFocusCapture={() => studio.focusPane("primary")}>
        <TextWorkspace {...props} thread={primaryThread} pane="primary" focused={activePane === "primary"} split={split}
          replyAnnouncementRoot={replyAnnouncementRoot} onOpenRunningChat={openRunningChat}
          onChooseChat={() => setPicker(split ? "primary" : "secondary")}
          onClosePane={() => { studio.closePane("primary"); focusComposer("primary"); }} />
      </div>
      {secondaryThread && <>
        <ResizeHandle className="chat-split-divider" ref={divider} label="Resize chat panes" controls={primaryPaneId}
          orientation="vertical" value={studio.splitPercent} min={35} max={65} step={5} resetValue={50}
          measurePixelsPerUnit={() => (layout.current?.getBoundingClientRect().width ?? 0) / 100}
          formatValue={(size) => `${size}%`} onPreview={setDragSize} onCancel={() => setDragSize(null)}
          onCommit={(size) => { studio.resizePanes(size); setDragSize(null); }} />
        <div className="chat-pane" data-chat-pane="secondary" data-focused={activePane === "secondary"}
          onPointerDownCapture={() => studio.focusPane("secondary")} onFocusCapture={() => studio.focusPane("secondary")}>
          <TextWorkspace {...props} thread={secondaryThread} pane="secondary" focused={activePane === "secondary"} split
            replyAnnouncementRoot={replyAnnouncementRoot} onOpenRunningChat={openRunningChat}
            onChooseChat={() => setPicker("secondary")}
            onClosePane={() => { studio.closePane("secondary"); focusComposer("primary"); }} />
        </div>
      </>}
      {dropPane && <div className="chat-drop-preview" data-pane={dropPane} aria-hidden="true" />}
    </div>
    {picker && <ThreadBrowser threads={pickerThreads} initialQuery="" onClose={() => setPicker(null)}
      onOpen={(id) => select(id, picker)} onNewChat={() => {
        studio.newThread(undefined, picker);
        focusComposer(picker);
      }} />}
  </div></TooltipScope>;
}
