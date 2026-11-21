import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/useModalFocus";
import { canMoveChatFolder, chatFolderPath, type ChatFolder, type ChatOrganizationAction } from "../lib/chatFolders";
import { Button, Input, Select } from "./ui/controls";

export type ChatFolderDialogRequest =
  | { type: "create"; parentId?: string }
  | { type: "rename"; id: string; name: string }
  | { type: "delete"; id: string; name: string }
  | { type: "move-chat" | "move-folder"; id: string; name: string; parentId?: string };

export function ChatFolderDialog({ request, folders, onSubmit, onClose }: {
  request: ChatFolderDialogRequest;
  folders: readonly ChatFolder[];
  onSubmit: (action: ChatOrganizationAction) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const fieldId = useId();
  const form = useRef<HTMLFormElement>(null);
  useModalFocus(true, form, onClose);
  const [name, setName] = useState(request.type === "rename" ? request.name : "");
  const [target, setTarget] = useState("parentId" in request ? request.parentId ?? "" : "");
  const moving = request.type === "move-chat" || request.type === "move-folder";
  const naming = request.type === "create" || request.type === "rename";
  const index = new Map(folders.map((folder) => [folder.id, folder]));
  const destinations = moving ? folders
    .filter((folder) => request.type === "move-chat" || canMoveChatFolder(index, request.id, folder.id))
    .map((folder) => ({ id: folder.id, path: chatFolderPath(index, folder.id) }))
    .sort((a, b) => a.path.localeCompare(b.path)) : [];
  const title = request.type === "create" ? (request.parentId ? "New subfolder" : "New chat folder")
    : request.type === "rename" ? "Rename folder" : request.type === "delete" ? "Delete folder"
    : request.type === "move-chat" ? "Move chat" : "Move folder";
  const confirm = request.type === "create" ? "Create folder" : request.type === "rename" ? "Save name"
    : request.type === "delete" ? "Delete folder" : "Move";
  const blocked = (naming && !name.trim()) || (moving && (target || undefined) === request.parentId);
  return createPortal(<div className="command-palette-backdrop" onMouseDown={onClose}>
    <form className="chat-folder-dialog command-palette" ref={form} role="dialog" aria-modal="true"
      aria-labelledby={titleId} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        if (request.type === "create") onSubmit({ ...request, id: `chat-folder-${crypto.randomUUID()}`, name });
        else if (request.type === "rename") onSubmit({ ...request, name });
        else if (request.type === "delete") onSubmit({ type: "delete", id: request.id });
        else onSubmit({ type: request.type, id: request.id, parentId: target || undefined });
        onClose();
      }}>
      <h2 id={titleId}>{title}</h2>
      {naming && <div className="field">
        <label htmlFor={fieldId}>Folder name</label>
        <Input id={fieldId} data-autofocus autoComplete="off" maxLength={80} value={name}
          onChange={(event) => setName(event.target.value)} onFocus={(event) => {
            if (request.type === "rename") event.currentTarget.select();
          }} />
      </div>}
      {moving && <div className="field">
        <label htmlFor={fieldId}>Destination for {request.name}</label>
        <Select id={fieldId} data-autofocus value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">Chats (top level)</option>
          {destinations.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
        </Select>
      </div>}
      {request.type === "delete" && <p>Chats and subfolders in “{request.name}” will move up one level.</p>}
      <div className="chat-folder-dialog-actions">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={request.type === "delete" ? "danger" : "primary"} type="submit" disabled={blocked}>{confirm}</Button>
      </div>
    </form>
  </div>, document.body);
}
