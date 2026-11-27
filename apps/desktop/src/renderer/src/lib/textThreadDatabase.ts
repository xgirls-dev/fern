import type { TextMessage, TextThread, TextThreadWorkspace } from "./textThreads";

const DATABASE = "fern-text-workspace";
export const WORKSPACE = "workspace";
export const TRANSCRIPTS = "transcripts";
export const HEADER = "header";

export type ThreadRecord = Omit<TextThread, "messages">;
type ThreadPatch = { id: string; fields: Partial<ThreadRecord> };
export type WorkspaceHeader = Omit<TextThreadWorkspace, "threads"> & { order: string[]; membershipRevision?: string };
export type Transcript = { id: string; messages: TextMessage[]; revision?: string };
export type TranscriptWrite = { id: string; revision: string } & (
  { messages: TextMessage[] } | {
    previousRevision?: string;
    previousCount: number;
    start: number;
    remove: number;
    added: TextMessage[];
  }
);
export type ChatDatabaseWrite = {
  removed: string[];
  threads: (ThreadRecord | ThreadPatch)[];
  transcripts: TranscriptWrite[];
  header?: WorkspaceHeader;
};

export function openChatDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(WORKSPACE);
      request.result.createObjectStore(TRANSCRIPTS, { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Chat storage is open in another window."));
    request.onsuccess = () => resolve(request.result);
  });
}

export function completedChatTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Chat storage was interrupted."));
  });
}

export async function commitChatDatabase(write: ChatDatabaseWrite): Promise<void> {
  const db = await openChatDatabase();
  try {
    const transaction = db.transaction([WORKSPACE, TRANSCRIPTS], "readwrite", { durability: "strict" });
    const done = completedChatTransaction(transaction);
    const metadata = transaction.objectStore(WORKSPACE);
    const transcripts = transaction.objectStore(TRANSCRIPTS);
    let failure: unknown;
    const abort = (error: unknown) => {
      failure = error;
      transaction.abort();
    };
    try {
      for (const id of write.removed) {
        metadata.delete(id);
        transcripts.delete(id);
      }
      for (const thread of write.threads) {
        if (!("fields" in thread)) {
          metadata.put(thread, thread.id);
          continue;
        }
        const read = metadata.get(thread.id);
        read.onsuccess = () => {
          try {
            const existing = read.result as ThreadRecord | undefined;
            if (existing?.id !== thread.id) throw new Error("The saved chat changed before this edit could be applied.");
            metadata.put({ ...existing, ...thread.fields }, thread.id);
          } catch (error) { abort(error); }
        };
      }
      for (const change of write.transcripts) {
        if ("messages" in change) {
          transcripts.put(change);
          continue;
        }
        const read = transcripts.get(change.id);
        read.onsuccess = () => {
          try {
            const previous = read.result as Transcript | undefined;
            // An interrupted worker can finish committing before the fallback starts.
            if (previous?.revision === change.revision) return;
            if (!previous || previous.revision !== change.previousRevision || previous.messages.length !== change.previousCount) {
              throw new Error("The saved chat changed before this edit could be applied.");
            }
            const messages = [...previous.messages.slice(0, change.start), ...change.added,
              ...previous.messages.slice(change.start + change.remove)];
            transcripts.put({ id: change.id, revision: change.revision, messages } satisfies Transcript);
          } catch (error) { abort(error); }
        };
      }
      if (write.header) metadata.put(write.header, HEADER);
    } catch (error) { abort(error); }
    await done.catch((error: unknown) => { throw failure ?? error; });
  } finally { db.close(); }
}
