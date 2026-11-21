import type { TextThreadWorkspace } from "./textThreads";

export interface ChatFolder {
  id: string;
  name: string;
  parentId?: string;
  collapsed?: boolean;
}

export const EMPTY_CHAT_FOLDERS: readonly ChatFolder[] = [];
export const CHAT_NAV_DRAG = "application/x-fern-chat-navigation";

export type ChatOrganizationAction =
  | { type: "create"; id: string; name: string; parentId?: string }
  | { type: "rename"; id: string; name: string }
  | { type: "toggle" | "delete"; id: string }
  | { type: "move-chat" | "move-folder"; id: string; parentId?: string };

type FolderIndex = ReadonlyMap<string, ChatFolder>;

export function folderAncestors(index: FolderIndex, id?: string): ChatFolder[] {
  const folders = [];
  const seen = new Set<string>();
  let folder = id ? index.get(id) : undefined;
  while (folder && !seen.has(folder.id)) {
    folders.push(folder);
    seen.add(folder.id);
    folder = folder.parentId ? index.get(folder.parentId) : undefined;
  }
  return folders;
}

export function chatFolderPath(index: FolderIndex, id?: string): string {
  return folderAncestors(index, id).reverse().map(({ name }) => name).join(" / ");
}

type FolderEntry<Chat> = { kind: "folder"; item: ChatFolder } | { kind: "chat"; item: Chat };
type FolderRow<Chat> = FolderEntry<Chat> & { depth: number };

export function chatFolderRows<Chat extends { folderId?: string }>(folders: readonly ChatFolder[], chats: readonly Chat[]): FolderRow<Chat>[] {
  const contents = new Map<string | undefined, FolderEntry<Chat>[]>();
  const add = (parentId: string | undefined, row: FolderEntry<Chat>) => {
    const siblings = contents.get(parentId);
    if (siblings) siblings.push(row);
    else contents.set(parentId, [row]);
  };
  for (const item of [...folders].sort((a, b) => a.name.localeCompare(b.name))) add(item.parentId, { kind: "folder", item });
  for (const item of chats) add(item.folderId, { kind: "chat", item });
  const children = (parentId: string | undefined, depth: number) =>
    (contents.get(parentId) ?? []).map((row) => ({ ...row, depth })).reverse();
  const pending = children(undefined, 0);
  const rows: FolderRow<Chat>[] = [];
  while (pending.length) {
    const row = pending.pop()!;
    rows.push(row);
    if (row.kind === "folder" && !row.item.collapsed) pending.push(...children(row.item.id, row.depth + 1));
  }
  return rows;
}

export function canMoveChatFolder(index: FolderIndex, id: string, parentId?: string): boolean {
  return !parentId || (index.has(parentId) && !folderAncestors(index, parentId).some((folder) => folder.id === id));
}

export function revealChatFolder(folders: readonly ChatFolder[], id?: string): readonly ChatFolder[] {
  if (!id) return folders;
  const index = new Map(folders.map((folder) => [folder.id, folder]));
  const collapsed = new Set(folderAncestors(index, id).filter((folder) => folder.collapsed).map((folder) => folder.id));
  return collapsed.size ? folders.map((folder) => collapsed.has(folder.id) ? { ...folder, collapsed: false } : folder) : folders;
}

export function normalizeChatFolders(value: unknown): ChatFolder[] {
  if (!Array.isArray(value)) return [];
  const index = new Map<string, ChatFolder>();
  for (const item of value) {
    if (typeof item?.id !== "string" || !item.id.startsWith("chat-folder-") || index.has(item.id)) continue;
    const name = cleanFolderName(item.name);
    if (!name) continue;
    index.set(item.id, {
      id: item.id, name, parentId: typeof item.parentId === "string" ? item.parentId : undefined, collapsed: item.collapsed === true,
    });
  }
  for (const folder of index.values()) {
    if (!canMoveChatFolder(index, folder.id, folder.parentId)) folder.parentId = undefined;
  }
  return [...index.values()];
}

function cleanFolderName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "";
}

export function organizeChats(workspace: TextThreadWorkspace, action: ChatOrganizationAction): TextThreadWorkspace {
  const folders = workspace.folders ?? EMPTY_CHAT_FOLDERS;
  const index = new Map(folders.map((folder) => [folder.id, folder]));
  const folder = index.get(action.id);
  switch (action.type) {
    case "create": {
      const name = cleanFolderName(action.name);
      if (!name || folder || (action.parentId && !index.has(action.parentId))) return workspace;
      return { ...workspace, folders: [
        ...revealChatFolder(folders, action.parentId), { id: action.id, name, parentId: action.parentId },
      ] };
    }
    case "rename": {
      const name = cleanFolderName(action.name);
      if (!name || !folder || name === folder.name) return workspace;
      return { ...workspace, folders: folders.map((item) => item.id === folder.id ? { ...item, name } : item) };
    }
    case "toggle":
      return folder ? { ...workspace, folders: folders.map((item) =>
        item.id === folder.id ? { ...item, collapsed: !item.collapsed } : item) } : workspace;
    case "delete":
      return folder ? {
        ...workspace,
        folders: folders.filter((item) => item.id !== folder.id).map((item) =>
          item.parentId === folder.id ? { ...item, parentId: folder.parentId } : item),
        threads: workspace.threads.map((thread) =>
          thread.folderId === folder.id ? { ...thread, folderId: folder.parentId } : thread),
      } : workspace;
    case "move-chat": {
      const thread = workspace.threads.find((thread) => thread.id === action.id);
      if (!thread || thread.folderId === action.parentId || (action.parentId && !index.has(action.parentId))) return workspace;
      return {
        ...workspace, folders: revealChatFolder(folders, action.parentId),
        threads: workspace.threads.map((item) => item.id === thread.id ? { ...item, folderId: action.parentId } : item),
      };
    }
    case "move-folder":
      if (!folder || folder.parentId === action.parentId || !canMoveChatFolder(index, folder.id, action.parentId)) return workspace;
      return { ...workspace, folders: revealChatFolder(folders, action.parentId).map((item) =>
        item.id === folder.id ? { ...item, parentId: action.parentId } : item) };
  }
}
