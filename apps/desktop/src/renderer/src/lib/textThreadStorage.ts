import { normalizeChatDocuments } from "./chatDocuments";
import { commitChatDatabase, completedChatTransaction, HEADER, openChatDatabase, TRANSCRIPTS, WORKSPACE,
  type ChatDatabaseWrite, type ThreadRecord, type Transcript, type WorkspaceHeader } from "./textThreadDatabase";
import {
  createTextWorkspace,
  finishTextReply,
  mergeTextReplyPreview,
  restoreFinishedTextReply,
  restoreTextReplyPreview,
  restoreTextThreads,
  showReplyVersion,
  type TextMessage,
  type TextReplyPreview,
  type TextThread,
  type TextThreadWorkspace,
} from "./textThreads";

const LEGACY = "fern-text-threads:v1";
const DRAFT_CHECKPOINT = "fern-text-draft-checkpoint:v1";
const TURN_CHECKPOINT = "fern-text-turn-checkpoint:v1";
const TRANSCRIPT_EDIT_CHECKPOINT = "fern-text-transcript-edit-checkpoint:v1";
const BACKGROUND_TRANSCRIPT_SIZE = 512;

type DraftRecord = Pick<TextThread, "id" | "draft" | "draftImage" | "draftContextImage" | "draftContextImageThreadId" | "documents" | "promptEdit" | "updatedAt">;
type ReplyCheckpoint = { id: string; jobId: string } & (
  { preview: TextReplyPreview } | { message: TextMessage; selectedId?: string }
);
type ExitCheckpoint = { activeId: string; drafts: DraftRecord[]; newThreads: ThreadRecord[]; replies?: ReplyCheckpoint[] };
type TurnBase = Pick<TextThread, "updatedAt" | "pendingJobId"> & { count: number; lastId?: string };
type TurnCheckpoint = { thread: TextThread; base?: TurnBase };
type TranscriptEdit = {
  id: string;
  base: TurnBase;
  updatedAt: number;
  start: number;
  removed: string[];
  before?: string;
  after?: string;
  added: TextMessage[];
};
type TurnExitCheckpoint = { activeId: string; membershipRevision?: string; turns: TurnCheckpoint[] };

async function readDatabase() {
  const db = await openChatDatabase();
  try {
    const transaction = db.transaction([WORKSPACE, TRANSCRIPTS], "readonly");
    const done = completedChatTransaction(transaction);
    const workspaceHeader = transaction.objectStore(WORKSPACE).get(HEADER);
    const records = transaction.objectStore(WORKSPACE).getAll();
    const transcripts = transaction.objectStore(TRANSCRIPTS).getAll();
    await done;
    const header = workspaceHeader.result as WorkspaceHeader | undefined;
    if (!header) return;
    if (!Array.isArray(header.order)) throw new Error("Saved chats could not be opened.");
    const byId = new Map(records.result.filter((record): record is ThreadRecord => typeof record?.id === "string").map((record) => [record.id, record]));
    const history = new Map((transcripts.result as Transcript[]).map((record) => [record.id, record]));
    const workspace = restoreTextThreads({
      ...header,
      threads: header.order.flatMap((id) => {
        const record = byId.get(id);
        return record ? [{ ...record, messages: history.get(id)?.messages ?? [] }] : [];
      }),
    });
    if (!workspace) throw new Error("Saved chats could not be opened.");
    const revisions = new Map<string, string | undefined>();
    for (const { id, messages } of workspace.threads) {
      const record = history.get(id);
      // A repaired transcript must be written in full before using its row indices.
      if (Array.isArray(record?.messages) && record.messages.length === messages.length &&
        messages.every(({ id, createdAt }, index) => {
          const stored = record.messages[index];
          return id === stored?.id && createdAt === stored.createdAt;
        })) {
        revisions.set(id, record.revision);
      }
    }
    return { workspace, revisions, membershipRevision: typeof header.membershipRevision === "string" ? header.membershipRevision : undefined };
  } finally { db.close(); }
}

async function writeDatabase(workspace: TextThreadWorkspace, previous: TextThreadWorkspace | undefined,
  membershipRevision: string | undefined, revisions?: Map<string, string | undefined>, commit = commitChatDatabase) {
  const old = new Map(previous?.threads.map((thread) => [thread.id, thread]));
  const changed = workspace.threads.filter((thread) => old.get(thread.id) !== thread);
  const order = workspace.threads.map((thread) => thread.id);
  const orderChanged = !previous || order.length !== previous.threads.length || order.some((id, index) => id !== previous.threads[index].id);
  const { threads: _, ...header } = workspace;
  const headerChanged = orderChanged || !previous || Object.entries(header).some(([key, value]) =>
    previous[key as keyof typeof header] !== value
  ) || Object.keys(previous).some((key) => key !== "threads" && !(key in header));
  if (!headerChanged && !changed.length) return membershipRevision;
  // A create/delete sequence can return to the same order. Its revision must still change.
  const nextRevision = orderChanged ? crypto.randomUUID() : membershipRevision;
  const ids = new Set(order);
  const write: ChatDatabaseWrite = {
    removed: [...old.keys()].filter((id) => !ids.has(id)), threads: [], transcripts: [],
    header: headerChanged ? { ...header, order, membershipRevision: nextRevision } : undefined,
  };
  for (const { messages, ...thread } of changed) {
    const { id } = thread;
    write.threads.push(thread);
    const existing = old.get(id)?.messages;
    if (messages === existing) continue;
    const revision = crypto.randomUUID();
    if (existing && revisions?.has(id) && existing.length >= BACKGROUND_TRANSCRIPT_SIZE) {
      const { start, beforeEnd, afterEnd } = transcriptReplacement(existing, messages);
      if (start || beforeEnd < existing.length) {
        write.transcripts.push({ id, revision, previousRevision: revisions.get(id), previousCount: existing.length,
          start, remove: beforeEnd - start, added: messages.slice(start, afterEnd) });
        continue;
      }
    }
    write.transcripts.push({ id, revision, messages });
  }
  await commit(write);
  for (const id of write.removed) revisions?.delete(id);
  for (const { id, revision } of write.transcripts) revisions?.set(id, revision);
  return nextRevision;
}

function commitInWorker(worker: Worker, write: ChatDatabaseWrite): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const clear = () => { worker.onmessage = worker.onerror = worker.onmessageerror = null; };
    worker.onmessage = ({ data }: MessageEvent<{ error?: string }>) => {
      clear();
      if (data.error) reject(new Error(data.error));
      else resolve(true);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      clear();
      resolve(false);
    };
    worker.onmessageerror = () => { clear(); resolve(false); };
    try { worker.postMessage(write); }
    catch (error) { clear(); reject(error); }
  });
}

function createDatabaseWriter() {
  let worker: Worker | undefined;
  let unavailable = false;
  return async (write: ChatDatabaseWrite) => {
    if (!unavailable && write.transcripts.some((change) => "previousCount" in change)) {
      try { worker ??= new Worker(new URL("./textThreadDatabase.worker.ts", import.meta.url), { type: "module" }); }
      catch { unavailable = true; }
      if (worker) {
        if (await commitInWorker(worker, write)) return;
        worker.terminate();
        worker = undefined;
        unavailable = true;
      }
    }
    await commitChatDatabase(write);
  };
}

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function parseLocal(raw: string | null): unknown {
  try { return JSON.parse(raw ?? "null"); }
  catch { return null; }
}

function clearLocal(key: string, raw: string | null) {
  try { if (raw !== null && localStorage.getItem(key) === raw) localStorage.removeItem(key); }
  catch { /* The IndexedDB transaction has already committed. */ }
}

function sameDraft(left: DraftRecord, right: DraftRecord) {
  return left.draft === right.draft && left.draftImage === right.draftImage && left.draftContextImage === right.draftContextImage &&
    left.draftContextImageThreadId === right.draftContextImageThreadId &&
    left.promptEdit?.messageId === right.promptEdit?.messageId && left.promptEdit?.content === right.promptEdit?.content;
}

function recoverDraft(thread: TextThread, draft: DraftRecord | undefined): TextThread {
  if (!draft || !Number.isFinite(draft.updatedAt) || draft.updatedAt < thread.updatedAt) return thread;
  const documents = normalizeChatDocuments(draft.documents);
  if (sameDraft(thread, draft) && documents === undefined) return thread;
  const { draft: text, draftImage, draftContextImage, draftContextImageThreadId, promptEdit, updatedAt } = draft;
  const editing = promptEdit && thread.messages.some((message) => message.role === "user" && message.id === promptEdit.messageId);
  return { ...thread, draft: text, draftImage, draftContextImage, draftContextImageThreadId,
    documents: documents ?? thread.documents, promptEdit: editing ? promptEdit : undefined, updatedAt };
}

function recoverReplyCheckpoint(thread: TextThread, checkpoint: ReplyCheckpoint | undefined): TextThread {
  if (!checkpoint || checkpoint.jobId !== thread.pendingJobId) return thread;
  if ("preview" in checkpoint) {
    const preview = restoreTextReplyPreview(checkpoint.preview);
    if (!preview) return thread;
    // A later disk write can contain a newer snapshot of the same generation.
    return { ...thread, pendingPreview: mergeTextReplyPreview(preview, thread.pendingPreview) };
  }
  const reply = restoreFinishedTextReply(checkpoint.message);
  if (!reply || reply.inspectionJobId) return thread;
  const inspectionTarget = thread.messages.find((message) => message.inspectionJobId === checkpoint.jobId);
  let messages: TextMessage[];
  if (inspectionTarget) {
    if (reply.id !== inspectionTarget.id || reply.jobId !== inspectionTarget.jobId) return thread;
    const updatedReply = showReplyVersion({ ...reply, alternatives: inspectionTarget.alternatives }, checkpoint.selectedId);
    messages = thread.messages.map((message) => message === inspectionTarget ? updatedReply : message);
  } else {
    if (reply.jobId !== checkpoint.jobId || reply.id !== `response-${checkpoint.jobId}`) return thread;
    messages = finishTextReply(thread, reply);
    messages[messages.length - 1] = showReplyVersion(messages[messages.length - 1], checkpoint.selectedId);
  }
  return { ...thread, messages, pendingJobId: null, pendingPreview: undefined, pendingContext: undefined,
    updatedAt: Math.max(thread.updatedAt, reply.createdAt) };
}

function finishedReplyCheckpoint(thread: TextThread, saved: TextThread | undefined): ReplyCheckpoint | undefined {
  const jobId = saved?.pendingJobId;
  if (!jobId || jobId === thread.pendingJobId) return;
  const inspection = saved?.messages.find((message) => message.inspectionJobId === jobId);
  const expectedId = inspection?.id ?? `response-${jobId}`;
  const row = thread.messages.find((message) => message.id === expectedId || message.alternatives?.some((reply) => reply.id === expectedId));
  const answer = row?.id === expectedId ? row : row?.alternatives?.find((message) => message.id === expectedId);
  if (!answer?.status || answer.inspectionJobId) return;
  // Past versions are already in IndexedDB and can be much larger than this reply.
  const { alternatives, ...message } = answer;
  return { id: thread.id, jobId, message, selectedId: row?.id };
}

function addedTurnsCheckpoint(thread: TextThread, saved: TextThread | undefined): TurnCheckpoint | undefined {
  if (!thread.messages.length || thread.messages === saved?.messages) return;
  if (!saved) return { thread };
  const count = saved.messages.length;
  const messages = thread.messages.slice(count);
  // Keep question submission and answer recovery on their job-aware path.
  if (!messages.some((message) => message.role === "user") || saved.messages.some((message, index) => message !== thread.messages[index])) return;
  return {
    thread: { ...thread, messages },
    base: transcriptBase(saved),
  };
}

function transcriptBase(thread: TextThread): TurnBase {
  return { count: thread.messages.length, lastId: thread.messages.at(-1)?.id, updatedAt: thread.updatedAt, pendingJobId: thread.pendingJobId };
}

function matchesTranscriptBase(thread: TextThread, base: TurnBase) {
  return thread.messages.length === base.count && thread.messages.at(-1)?.id === base.lastId &&
    thread.updatedAt === base.updatedAt && (thread.pendingJobId ?? null) === (base.pendingJobId ?? null);
}

function matchTurnBase(current: TextThread, base: TurnBase | undefined, captured: TextThread): boolean {
  if (base) return matchesTranscriptBase(current, base);
  // A transaction for the empty chat can commit just before the window closes.
  // A newer empty transcript may be the result of deleting its messages.
  const first = captured.messages[0];
  return !current.messages.length && !current.pendingJobId && first?.role === "user" && current.updatedAt < first.createdAt;
}

function messageVersionKey(message?: TextMessage): string | undefined {
  if (!message) return;
  return JSON.stringify([message.id, message.promptVersionId, message.alternatives?.map(({ id }) => id),
    message.promptAlternatives?.map(({ id, response }) => [id, response?.id])]);
}

function transcriptReplacement(previous: TextMessage[], messages: TextMessage[]) {
  let start = 0;
  while (start < previous.length && start < messages.length && previous[start] === messages[start]) start++;
  let beforeEnd = previous.length;
  let afterEnd = messages.length;
  while (beforeEnd > start && afterEnd > start && previous[beforeEnd - 1] === messages[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  return { start, beforeEnd, afterEnd };
}

function transcriptEditCheckpoint(thread: TextThread, saved: TextThread): TranscriptEdit | undefined {
  const { messages } = thread;
  const previous = saved.messages;
  // A conversation version switch needs its snapshots and active transcript to commit together.
  if (messages === previous || thread.versions !== saved.versions || thread.pendingJobId || saved.pendingJobId) return;
  const { start, beforeEnd, afterEnd } = transcriptReplacement(previous, messages);
  if (start === previous.length && start === messages.length) return;
  return { id: thread.id, base: transcriptBase(saved), updatedAt: thread.updatedAt, start,
    before: messageVersionKey(previous[start - 1]), after: messageVersionKey(previous[beforeEnd]),
    removed: previous.slice(start, beforeEnd).map((message) => messageVersionKey(message)!), added: messages.slice(start, afterEnd) };
}

function matchesTranscriptEdit(thread: TextThread, edit: TranscriptEdit) {
  return edit?.id === thread.id && !!edit.base && matchesTranscriptBase(thread, edit.base) &&
    Number.isFinite(edit.updatedAt) && Number.isSafeInteger(edit.start) && edit.start >= 0 &&
    Array.isArray(edit.removed) && Array.isArray(edit.added) && edit.start + edit.removed.length <= thread.messages.length &&
    messageVersionKey(thread.messages[edit.start - 1]) === edit.before &&
    messageVersionKey(thread.messages[edit.start + edit.removed.length]) === edit.after &&
    edit.removed.every((key, index) => messageVersionKey(thread.messages[edit.start + index]) === key);
}

function recoverTranscriptEdits(workspace: TextThreadWorkspace, raw: string | null): TextThreadWorkspace {
  const edits = parseLocal(raw) as TranscriptEdit[] | null;
  if (!Array.isArray(edits) || !edits.length) return workspace;
  const threads = workspace.threads.map((thread) => {
    if (thread.pendingJobId) return thread;
    const edit = edits.find((item) => matchesTranscriptEdit(thread, item));
    if (!edit) return thread;
    const added = restoreTextThreads({ threads: [{ ...thread, messages: edit.added, versions: undefined }] })?.threads[0]?.messages;
    if (!added || added.length !== edit.added.length) return thread;
    const messages = [...thread.messages.slice(0, edit.start), ...added, ...thread.messages.slice(edit.start + edit.removed.length)];
    return { ...thread, messages, updatedAt: edit.updatedAt };
  });
  return { ...workspace, threads };
}

function recoverAddedTurns(workspace: TextThreadWorkspace, raw: string | null, membershipRevision: string | undefined): TextThreadWorkspace {
  const checkpoint = parseLocal(raw) as Partial<TurnExitCheckpoint> | null;
  if (!checkpoint || !Array.isArray(checkpoint.turns)) return workspace;

  const saved = new Map(workspace.threads.map((thread) => [thread.id, thread]));
  const added: TextThread[] = [];
  const replacements = new Map<string, TextThread>();
  for (const entry of checkpoint.turns) {
    const captured = entry?.thread;
    if (!captured || !Array.isArray(captured.messages) || !captured.messages.length) continue;
    const current = saved.get(captured.id);
    if (current ? !matchTurnBase(current, entry.base, captured) : entry.base || checkpoint.membershipRevision !== membershipRevision) {
      // The prompt write can commit on exit while a newer reply is only in the checkpoint.
      if (current?.pendingJobId) {
        const finished = finishedReplyCheckpoint(captured, current);
        const preview = captured.pendingJobId === current.pendingJobId && captured.pendingPreview;
        const recovered = recoverReplyCheckpoint(current, finished ?? (preview
          ? { id: current.id, jobId: current.pendingJobId, preview } : undefined));
        if (recovered !== current) replacements.set(current.id, recovered);
      }
      continue;
    }

    const restored = restoreTextThreads({ folders: workspace.folders, threads: [{
      ...captured, messages: [...(current?.messages ?? []), ...captured.messages],
    }] })?.threads[0];
    if (!restored || restored.id !== captured.id || restored.messages.length !== (current?.messages.length ?? 0) + captured.messages.length) continue;
    if (current) replacements.set(restored.id, restored);
    else if (!added.some((thread) => thread.id === restored.id)) added.push(restored);
  }
  if (!replacements.size && !added.length) return workspace;
  const threads = [...added, ...workspace.threads.map((thread) => replacements.get(thread.id) ?? thread)];
  const activeId = threads.some((thread) => thread.id === checkpoint.activeId) ? checkpoint.activeId! : workspace.activeId;
  return { ...workspace, activeId, threads };
}

function recoverExitCheckpoint(workspace: TextThreadWorkspace, raw: string | null): TextThreadWorkspace {
  const checkpoint = parseLocal(raw) as Partial<ExitCheckpoint> | null;
  if (!checkpoint || !Array.isArray(checkpoint.drafts) || !Array.isArray(checkpoint.newThreads)) return workspace;
  const drafts = new Map(checkpoint.drafts.filter((draft) => draft && typeof draft.draft === "string").map((draft) => [draft.id, draft]));
  const replies = new Map((Array.isArray(checkpoint.replies) ? checkpoint.replies : [])
    .filter((reply) => typeof reply?.id === "string" && typeof reply.jobId === "string").map((reply) => [reply.id, reply]));
  const threads = workspace.threads.map((thread) => recoverReplyCheckpoint(recoverDraft(thread, drafts.get(thread.id)), replies.get(thread.id)));
  const ids = new Set(threads.map((thread) => thread.id));
  const newThreads = restoreTextThreads({ folders: workspace.folders, threads: checkpoint.newThreads.filter((thread) => thread && !ids.has(thread.id)).map((thread) => ({ ...thread, messages: [] })) })?.threads ?? [];
  const activeId = newThreads.concat(threads).some((thread) => thread.id === checkpoint.activeId) ? checkpoint.activeId! : workspace.activeId;
  return { ...workspace, activeId, threads: [...newThreads, ...threads] };
}

export async function seedTextWorkspace(workspace: TextThreadWorkspace): Promise<void> {
  const previous = await readDatabase();
  await writeDatabase(workspace, previous?.workspace, previous?.membershipRevision);
}

export function createTextThreadStorage() {
  let saved: TextThreadWorkspace | undefined;
  let writing: TextThreadWorkspace | undefined;
  let membershipRevision: string | undefined;
  let transcriptRevisions = new Map<string, string | undefined>();
  let loading: Promise<TextThreadWorkspace> | undefined;
  let writes = Promise.resolve();
  const commit = createDatabaseWriter();

  const save = (workspace: TextThreadWorkspace) => {
    const next = writes.catch(() => undefined).then(async () => {
      if (saved === workspace) return;
      writing = workspace;
      try {
        membershipRevision = await writeDatabase(workspace, saved, membershipRevision, transcriptRevisions, commit);
        saved = workspace;
      } finally {
        writing = undefined;
      }
    });
    writes = next;
    return next;
  };

  return {
    load() {
      loading ??= (async () => {
        const database = await readDatabase();
        saved = database?.workspace;
        membershipRevision = database?.membershipRevision;
        transcriptRevisions = database?.revisions ?? new Map();
        const legacy = readLocal(LEGACY);
        const migrated = !saved ? restoreTextThreads(parseLocal(legacy)) : undefined;
        const checkpoint = readLocal(DRAFT_CHECKPOINT);
        const turns = readLocal(TURN_CHECKPOINT);
        const edits = readLocal(TRANSCRIPT_EDIT_CHECKPOINT);
        const resumed = recoverAddedTurns(saved ?? migrated ?? createTextWorkspace(), turns, membershipRevision);
        const restored = recoverExitCheckpoint(recoverTranscriptEdits(resumed, edits), checkpoint);
        await save(restored);
        if (migrated) clearLocal(LEGACY, legacy);
        clearLocal(DRAFT_CHECKPOINT, checkpoint);
        clearLocal(TURN_CHECKPOINT, turns);
        clearLocal(TRANSCRIPT_EDIT_CHECKPOINT, edits);
        return restored;
      })().catch((error: unknown) => { loading = undefined; throw error; });
      return loading;
    },
    save,
    checkpointOnExit(workspace: TextThreadWorkspace) {
      if (!saved) return;
      if (saved === workspace) {
        clearLocal(TURN_CHECKPOINT, readLocal(TURN_CHECKPOINT));
        clearLocal(TRANSCRIPT_EDIT_CHECKPOINT, readLocal(TRANSCRIPT_EDIT_CHECKPOINT));
        return;
      }
      const previous = new Map(saved.threads.map((thread) => [thread.id, thread]));
      const pending = new Map(writing?.threads.map((thread) => [thread.id, thread]));
      const drafts: DraftRecord[] = [];
      const newThreads: ThreadRecord[] = [];
      const replies: ReplyCheckpoint[] = [];
      const turns: TurnCheckpoint[] = [];
      const edits: TranscriptEdit[] = [];
      for (const thread of workspace.threads) {
        const old = previous.get(thread.id);
        const added = addedTurnsCheckpoint(thread, old);
        if (added) turns.push(added);
        else if (old) {
          const edit = transcriptEditCheckpoint(thread, old);
          if (edit) edits.push(edit);
        }
        // The current write can reach disk before its completion runs in the exiting renderer.
        const inFlight = pending.get(thread.id);
        if (old && inFlight && (inFlight.messages !== old.messages || inFlight.updatedAt !== old.updatedAt)) {
          const edit = transcriptEditCheckpoint(thread, inFlight);
          if (edit) edits.push(edit);
        }
        const finished = finishedReplyCheckpoint(thread, old);
        if (finished) {
          replies.push(finished);
        } else if (thread.pendingJobId && thread.pendingPreview && thread.pendingPreview !== old?.pendingPreview) {
          replies.push({ id: thread.id, jobId: thread.pendingJobId, preview: thread.pendingPreview });
        }
        if (!old && !thread.messages.length) {
          const { messages, ...record } = thread;
          newThreads.push(record);
        } else if (!old || !sameDraft(thread, old) || thread.documents !== old.documents) {
          const { id, draft, draftImage, draftContextImage, draftContextImageThreadId, promptEdit, updatedAt } = thread;
          const documents = thread.documents !== old?.documents ? thread.documents ?? [] : undefined;
          drafts.push({ id, draft, draftImage, draftContextImage, draftContextImageThreadId, documents, promptEdit, updatedAt });
        }
      }
      if (drafts.length || newThreads.length || replies.length || workspace.activeId !== saved.activeId) {
        try {
          localStorage.setItem(DRAFT_CHECKPOINT, JSON.stringify({ activeId: workspace.activeId, drafts, newThreads, replies } satisfies ExitCheckpoint));
        } catch { /* The normal IndexedDB save can still succeed. */ }
      }
      if (turns.length) {
        try {
          localStorage.setItem(TURN_CHECKPOINT, JSON.stringify({ activeId: workspace.activeId, membershipRevision, turns } satisfies TurnExitCheckpoint));
        } catch { /* Draft and reply recovery use a separate checkpoint. */ }
      } else clearLocal(TURN_CHECKPOINT, readLocal(TURN_CHECKPOINT));
      if (edits.length) {
        try { localStorage.setItem(TRANSCRIPT_EDIT_CHECKPOINT, JSON.stringify(edits)); }
        catch { /* The normal IndexedDB save can still succeed. */ }
      } else clearLocal(TRANSCRIPT_EDIT_CHECKPOINT, readLocal(TRANSCRIPT_EDIT_CHECKPOINT));
    },
    clearLegacy() {
      clearLocal(LEGACY, readLocal(LEGACY));
      clearLocal(DRAFT_CHECKPOINT, readLocal(DRAFT_CHECKPOINT));
      clearLocal(TURN_CHECKPOINT, readLocal(TURN_CHECKPOINT));
      clearLocal(TRANSCRIPT_EDIT_CHECKPOINT, readLocal(TRANSCRIPT_EDIT_CHECKPOINT));
    },
  };
}
