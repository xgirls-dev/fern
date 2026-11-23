import { useId, useRef, useState } from "react";
import { canMoveChatFolder, chatFolderPath, type ChatFolder, type ChatOrganizationAction } from "../lib/chatFolders";
import { Button, Input, Select } from "./ui/controls";
import { Dialog, DialogClose, DialogDescription, DialogTitle } from "./ui/Dialog";

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
  const fieldId = useId();
  const form = useRef<HTMLFormElement>(null);
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
  return <Dialog className="chat-folder-dialog" onClose={onClose}>
    <form ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        if (request.type === "create") onSubmit({ ...request, id: `chat-folder-${crypto.randomUUID()}`, name });
        else if (request.type === "rename") onSubmit({ ...request, name });
        else if (request.type === "delete") onSubmit({ type: "delete", id: request.id });
        else onSubmit({ type: request.type, id: request.id, parentId: target || undefined });
        onClose();
      }}>
      <DialogTitle>{title}</DialogTitle>
      {naming && <div className="field">
        <label htmlFor={fieldId}>Folder name</label>
        <Input id={fieldId} autoComplete="off" maxLength={80} value={name}
          onChange={(event) => setName(event.target.value)} onFocus={(event) => {
            if (request.type === "rename") event.currentTarget.select();
          }} />
      </div>}
      {moving && <div className="field">
        <label htmlFor={fieldId}>Destination for {request.name}</label>
        <Select id={fieldId} popupContainer={form} value={target} onChange={setTarget}
          options={[{ value: "", label: "Chats (top level)" }, ...destinations.map(({ id, path }) => ({ value: id, label: path }))]} />
      </div>}
      {request.type === "delete" && <DialogDescription>Chats and subfolders in “{request.name}” will move up one level.</DialogDescription>}
      <div className="chat-folder-dialog-actions">
        <DialogClose render={<Button variant="secondary">Cancel</Button>} />
        <Button variant={request.type === "delete" ? "danger" : "primary"} type="submit" disabled={blocked}>{confirm}</Button>
      </div>
    </form>
  </Dialog>;
}
