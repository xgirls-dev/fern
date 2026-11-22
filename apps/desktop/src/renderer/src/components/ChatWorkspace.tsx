import { useRef, useState, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { CHAT_NAV_DRAG, chatFolderPath } from "../lib/chatFolders";
import { normalizeChatSplit, type ChatPane } from "../lib/textThreads";
import { TextWorkspace, type TextWorkspaceProps } from "./TextWorkspace";
import { ThreadBrowser } from "./ThreadBrowser";
import { SegmentedControl } from "./ui/controls";

type WorkspaceProps = Omit<TextWorkspaceProps, "thread" | "pane" | "focused" | "split" | "onChooseChat" | "onClosePane">;

export function ChatWorkspace(props: WorkspaceProps) {
  const { studio } = props;
  const { primaryThread, secondaryThread, activePane } = studio;
  const split = Boolean(secondaryThread);
  const layout = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const resizePointer = useRef<number | null>(null);
  const [picker, setPicker] = useState<ChatPane | null>(null);
  const [dragSize, setDragSize] = useState<number | null>(null);
  const [dropPane, setDropPane] = useState<ChatPane | null>(null);
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
  const percentAt = (clientX: number) => {
    const bounds = layout.current?.getBoundingClientRect();
    return bounds?.width ? (clientX - bounds.left) / bounds.width * 100 : studio.splitPercent;
  };
  const destination = (event: DragEvent): ChatPane => {
    if (split && !divider.current?.getClientRects().length) return activePane;
    return percentAt(event.clientX) < (split ? ratio : 50) ? "primary" : "secondary";
  };
  const handlesChat = (event: DragEvent) => event.dataTransfer.types.includes(CHAT_NAV_DRAG);

  return <div className="chat-split-shell">
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
      <div className="chat-pane" data-chat-pane="primary" data-focused={activePane === "primary"}
        onPointerDownCapture={() => studio.focusPane("primary")} onFocusCapture={() => studio.focusPane("primary")}>
        <TextWorkspace {...props} thread={primaryThread} pane="primary" focused={activePane === "primary"} split={split}
          onChooseChat={() => setPicker(split ? "primary" : "secondary")}
          onClosePane={() => { studio.closePane("primary"); focusComposer("primary"); }} />
      </div>
      {secondaryThread && <>
        <div className="chat-split-divider" ref={divider} role="separator" aria-label="Resize chat panes"
          aria-orientation="vertical" aria-valuemin={35} aria-valuemax={65} aria-valuenow={ratio} tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            resizePointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragSize(normalizeChatSplit(percentAt(event.clientX)));
          }}
          onPointerMove={(event) => {
            if (resizePointer.current === event.pointerId) setDragSize(normalizeChatSplit(percentAt(event.clientX)));
          }}
          onPointerUp={(event) => {
            if (resizePointer.current !== event.pointerId) return;
            resizePointer.current = null;
            studio.resizePanes(percentAt(event.clientX));
            setDragSize(null);
          }}
          onLostPointerCapture={() => { resizePointer.current = null; setDragSize(null); }}
          onDoubleClick={() => studio.resizePanes(50)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 35 : event.key === "End" ? 65 : ratio + (event.key === "ArrowLeft" ? -5 : 5);
            studio.resizePanes(next);
          }} />
        <div className="chat-pane" data-chat-pane="secondary" data-focused={activePane === "secondary"}
          onPointerDownCapture={() => studio.focusPane("secondary")} onFocusCapture={() => studio.focusPane("secondary")}>
          <TextWorkspace {...props} thread={secondaryThread} pane="secondary" focused={activePane === "secondary"} split
            onChooseChat={() => setPicker("secondary")}
            onClosePane={() => { studio.closePane("secondary"); focusComposer("primary"); }} />
        </div>
      </>}
      {dropPane && <div className="chat-drop-preview" data-pane={dropPane} aria-hidden="true" />}
    </div>
    {picker && createPortal(<ThreadBrowser threads={pickerThreads} initialQuery="" onClose={() => setPicker(null)}
      onOpen={(id) => select(id, picker)} onNewChat={() => {
        studio.newThread(undefined, picker);
        focusComposer(picker);
      }} />, document.body)}
  </div>;
}
