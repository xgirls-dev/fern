import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  addTextModel,
  fetchTextJob,
  subscribeToTextJob,
  fetchTextStatus,
  inspectChatImage,
  installTextModel,
  pauseTextModelDownload,
  recoverChatImage,
  removeTextModel,
  startTextGeneration,
  stopTextGeneration,
  uploadChatImage,
  uploadChatDocument,
  type TextJobAcceptance,
} from "../lib/api";
import { readReference } from "../lib/reference";
import { chatImageErrors, chatImageSettings } from "../lib/chatImageSettings";
import { clearChatReadingPositions, saveChatReadingPosition } from "../lib/chatReadingPositions";
import { EMPTY_CHAT_FOLDERS, organizeChats, revealChatFolder, type ChatOrganizationAction } from "../lib/chatFolders";
import { isChatDocument, MAX_CHAT_DOCUMENTS, validateChatDocument } from "../lib/chatDocuments";

import { notify } from "../lib/notifications";
import { reuseUnchangedStatus } from "../lib/statusSnapshot";
import { createTextThreadStorage } from "../lib/textThreadStorage";
import { formatTextTranscript, type TranscriptDestination } from "../lib/textTranscript";
import { captureTextFailure } from "../lib/textFailure";
import {
  chatTokenLimits, closeChatPane, compareChatThread, ggufLoadOptions, modelDefaultsFromThread, normalizeChatSplit,
  chatPresetSettings, showChatThread, snapshotTextVersion, textSamplingOverrides, visibleChatPane, type ChatPane,
  TEXT_MESSAGE_CHARACTER_LIMIT,
  canContinueTextReply,
  createTextThread,
  createTextWorkspace,
  checkpointTextReply,
  copyTextHistory,
  draftContextImageOwner,
  findChatImage,
  finishTextReply,
  hasTextThreadWork,
  isChatImage,
  isTextModelInstalling,
  keepStreamedText,
  latestTextPrompt,
  pendingTextReply,
  removeTextMessage,
  replaceLatestPromptVersion,
  resolveTextModel,
  restoreTextMessages,
  showReplyVersion,
  textRuntimeIssue,
  textPromptHistory,
  textPromptExceedsLimit,
  textResponseMetrics,
  type TextDevice,
  type TextJob,
  type TextMessage,
  type TextMessageDeletion,
  type TextPromptVersion,
  type TextRuntimeStatus,
  type TextThread,
  type TextThreadWorkspace,
} from "../lib/textThreads";

const idleStatus: TextRuntimeStatus = {
  models: [], runtimeAvailable: false, runtimeError: null,
  devices: ["AUTO", "GPU", "CPU"],
  job: { id: null, threadId: null, modelId: null, status: "idle", phase: null, partialText: "", startedAt: null, finishedAt: null, result: null, error: null },
};

interface TextSubmission {
  id: string;
  threadId: string;
}

type DraftAttachment =
  | { status: "saving"; filename: string }
  | { status: "failed"; message: string; retryFile?: File };

export type TextSidebarRow = Pick<TextThread, "id" | "title" | "folderId"> & {
  archived: boolean;
  hasWork: boolean;
  hasTranscript: boolean;
};

const EMPTY_SIDEBAR_ROWS: readonly TextSidebarRow[] = [];

function confirmsSubmission(job: TextJob | null | undefined, submission: TextSubmission) {
  return job?.id === submission.id && job.threadId === submission.threadId && job.status !== "idle";
}

function sameTextJob(current: TextJob, next: TextJob) {
  return current.id === next.id && current.status === next.status && current.phase === next.phase
    && current.partialText === next.partialText && current.partialReasoning === next.partialReasoning
    && current.image?.name === next.image?.name && current.images?.length === next.images?.length && current.finishedAt === next.finishedAt;
}

function isTerminalTextJob(job: TextJob) {
  return job.status === "complete" || job.status === "failed" || job.status === "stopped";
}

function reconcileRunningTextJob(current: TextJob, next: TextJob): TextJob {
  if (next.status !== "running" || next.id !== current.id || next.threadId !== current.threadId) return next;
  // Status polling may have captured the job before the stream delivered its final update.
  if (isTerminalTextJob(current)) return current;
  if (current.status !== "running") return next;
  return {
    ...next,
    partialText: keepStreamedText(current.partialText, next.partialText) ?? "",
    partialReasoning: keepStreamedText(current.partialReasoning, next.partialReasoning),
    image: next.image ?? current.image,
    images: next.images ?? current.images,
  };
}

function settleTextJob(workspace: TextThreadWorkspace, job: TextJob, lastRunningJob: TextJob,
  models: TextRuntimeStatus["models"], observedAt: number): TextThreadWorkspace {
  const { id: jobId, threadId, status: outcome } = job;
  if (!jobId || !threadId || (outcome !== "complete" && outcome !== "failed" && outcome !== "stopped")) return workspace;
  const thread = workspace.threads.find((item) => item.id === threadId && item.pendingJobId === jobId);
  if (!thread) return workspace;

  const preview = pendingTextReply(thread, lastRunningJob);
  const image = job.image ?? job.images?.[0] ?? preview?.generatedImage;
  const finalText = job.partialText?.trim() ? job.partialText : "";
  const empty = outcome === "complete" && !finalText && !image;
  const content = outcome === "complete" && finalText ? finalText : keepStreamedText(preview?.content, finalText) ?? "";
  const emptyError = job.result?.finishReason === "length"
    ? "The model reached the output limit before finishing an answer. Increase Maximum output in Chat settings or try a shorter prompt."
    : content ? "The model finished without a final answer. The partial response was kept."
    : "The model returned no answer. Retry, edit your message, or send a new one.";
  const model = models.find((item) => item.id === job.modelId);
  const failureDiagnostics = empty ? captureTextFailure({
    stage: "checking-reply", runtime: model && (model.format === "gguf" ? "gguf" : "openvino"),
    device: job.result?.device === "CPU" || job.result?.device === "GPU" ? job.result.device : undefined,
  })
    : outcome === "failed" ? captureTextFailure(job.failureDiagnostics ?? undefined) : undefined;
  const assistant: TextMessage = {
    id: `response-${jobId}`, jobId, role: "assistant", content,
    status: empty ? "failed" : outcome,
    error: empty ? emptyError : job.error, errorCode: empty ? "empty-response" : job.errorCode, failureDiagnostics,
    reasoning: outcome === "complete" && job.partialReasoning?.trim() ? job.partialReasoning
      : keepStreamedText(preview?.reasoning, job.partialReasoning),
    generatedImage: image,
    generatedImages: job.images ?? preview?.generatedImages,
    modelName: job.result?.modelName ?? model?.name ?? "Unavailable model",
    createdAt: job.finishedAt ? job.finishedAt * 1000 : observedAt,
    metrics: textResponseMetrics(job.result),
    requestContext: thread.pendingContext,
  };
  const inspectionTarget = thread.messages.find((message) => message.inspectionJobId === jobId);
  const messages = inspectionTarget
    ? thread.messages.map((message) => message === inspectionTarget ? {
      ...message, inspectionJobId: undefined,
      content: job.result?.visionChecked ? assistant.content : message.content,
      metrics: job.result?.visionChecked ? assistant.metrics : message.metrics,
      status: assistant.status, error: assistant.error, errorCode: assistant.errorCode, failureDiagnostics,
    } : message)
    : thread.messages.some((message) => message.jobId === jobId) ? thread.messages : finishTextReply(thread, assistant);
  return { ...workspace, threads: workspace.threads.map((item) => item === thread
    ? { ...thread, pendingJobId: null, pendingPreview: undefined, pendingContext: undefined, messages, updatedAt: observedAt }
    : item) };
}

function useTextReplyPause(job: TextJob | null) {
  const id = job?.status === "running" ? job.id : null;
  const phase = job?.phase;
  const text = job?.partialText?.trimEnd();
  const reasoning = job?.partialReasoning?.trimEnd();
  const delay = text || reasoning ? 8_000 : phase?.startsWith("Waiting for") ? 12_000 : 25_000;
  // Each change in generation output or phase starts a fresh wait. Repeated status polls share it.
  const progress = useMemo(() => id ? { delay } : null, [id, phase, text, reasoning, delay]);
  const [pausedProgress, setPausedProgress] = useState<typeof progress>(null);
  useEffect(() => {
    if (!progress) return;
    const timer = window.setTimeout(() => setPausedProgress(progress), progress.delay);
    return () => window.clearTimeout(timer);
  }, [progress]);
  return progress !== null && progress === pausedProgress;
}

function openNewChat(workspace: TextThreadWorkspace, attachmentChats?: ReadonlySet<string>): TextThreadWorkspace {
  const untouched = workspace.threads.find((thread) => !thread.archived && !thread.renamed &&
    !attachmentChats?.has(thread.id) &&
    !thread.messages.length && !thread.draft && !thread.draftImage && !thread.draftContextImage && !thread.pendingJobId && !thread.systemPrompt &&
    thread.title === "New text thread");
  if (untouched) return showChatThread(workspace, untouched.id);
  const thread = createTextThread();
  return { ...showChatThread(workspace, thread.id), threads: [thread, ...workspace.threads] };
}

function copyChat(source: TextThread, messageId?: string, revision?: string, fork = false): TextThread | undefined {
  const index = messageId === undefined ? undefined : source.messages.findIndex((message) =>
    message.id === messageId || message.alternatives?.some((version) => version.id === messageId));
  if (index === -1) return;
  const message = index === undefined ? undefined : source.messages[index];
  const editing = revision !== undefined;
  if (editing && message?.role !== "user") return;
  const prefix = index === undefined ? source.messages : source.messages.slice(0, index + (editing ? 0 : 1));
  if (!editing && index !== undefined && message) prefix[index] = showReplyVersion(message, messageId);
  const suffix = messageId === undefined ? " (copy)" : fork ? " (fork)" : " (branch)";
  const draftContextImage = editing ? message?.includedImage : messageId === undefined ? source.draftContextImage : undefined;
  const imageOwner = editing ? message?.includedImageThreadId ?? findChatImage(source, draftContextImage)?.originThreadId : draftContextImageOwner(source);
  return {
    ...source, id: createTextThread().id, title: source.title.slice(0, 80 - suffix.length) + suffix,
    archived: false, renamed: true, updatedAt: Date.now(), pendingJobId: null, pendingPreview: undefined, pendingContext: undefined,
    messages: copyTextHistory(source, prefix),
    versions: messageId === undefined ? source.versions?.map((version) => ({
      ...version, messages: copyTextHistory({ id: source.id, messages: version.messages }),
    })) : undefined,
    sourceThreadId: messageId === undefined ? undefined : source.id,
    promptEdit: undefined,
    draft: revision ?? (messageId === undefined ? source.draft : ""),
    draftImage: editing ? message?.image : messageId === undefined ? source.draftImage : undefined,
    draftContextImage,
    draftContextImageThreadId: draftContextImage ? imageOwner ?? source.id : undefined,
  };
}

function addEditedChat(workspace: TextThreadWorkspace, sourceId: string, branch: TextThread): TextThreadWorkspace {
  return {
    ...showChatThread(workspace, branch.id, workspace.secondaryId === sourceId ? "secondary" : "primary"),
    threads: [branch, ...workspace.threads.map((thread) => thread.id === sourceId ? { ...thread, promptEdit: undefined } : thread)],
  };
}

export function useTextChat(ready: boolean, computeDevice: "GPU" | "CPU" = "GPU", imageGpuAvailable?: boolean) {
  const [{ workspace, messageDeletions, status, lastRunningJob }, setChatState] = useState(() => ({
    workspace: createTextWorkspace(),
    messageDeletions: new Map<string, TextMessageDeletion[]>(),
    status: idleStatus,
    lastRunningJob: idleStatus.job,
  }));
  const setWorkspace = useCallback((update: SetStateAction<TextThreadWorkspace>) => {
    setChatState((current) => {
      const workspace = typeof update === "function" ? update(current.workspace) : update;
      return workspace === current.workspace ? current : { ...current, workspace };
    });
  }, []);
  const setStatus = useCallback((update: SetStateAction<TextRuntimeStatus>) => {
    const observedAt = Date.now();
    setChatState((current) => {
      const status = typeof update === "function" ? update(current.status) : update;
      if (status === current.status) return current;
      const job = status.job;
      // Commit the terminal status and transcript together so a completed reply
      // never renders once more as a pending response.
      const workspace = job === current.status.job ? current.workspace
        : settleTextJob(current.workspace, job, current.lastRunningJob, status.models, observedAt);
      return { ...current, status, workspace, lastRunningJob: job.status === "running" ? job : current.lastRunningJob };
    });
  }, []);
  const [conversationStore] = useState(createTextThreadStorage);
  const [storageReady, setStorageReady] = useState(false);
  const [storageAttempt, setStorageAttempt] = useState(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const statusRef = useRef(status);
  useLayoutEffect(() => { statusRef.current = status; }, [status]);
  const savingTranscript = useRef(false);
  const scheduledWorkspace = useRef<TextThreadWorkspace>(workspace);
  const queuedNewChat = useRef(false);
  const resettingStorage = useRef(false);
  const liveJobRef = useRef(lastRunningJob);
  liveJobRef.current = lastRunningJob;
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [modelAction, setModelAction] = useState<string | null>(null);
  const [attachmentStates, setAttachmentStates] = useState(() => new Map<string, DraftAttachment>());
  const attachmentRequests = useRef(new Map<string, AbortController>());
  const [attachingDocument, setAttachingDocument] = useState(false);
  const documentUpload = useRef(false);
  const modelActionRef = useRef(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const replyPaused = useTextReplyPause(status.job);
  const [actionError, setError] = useState<{ message: string; threadId?: string; recovery?: "image-settings" } | null>(null);
  const setActionError = useCallback((message: string | null, threadId?: string, recovery?: "image-settings") => {
    setError(message ? { message, threadId, recovery } : null);
  }, []);
  const dismissActionError = useCallback((shown: NonNullable<typeof actionError>) => {
    setError((current) => current === shown ? null : current);
  }, []);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [stopFailure, setStopFailure] = useState<{ id: string; message: string } | null>(null);
  const dismissStopFailure = useCallback((id: string) => {
    setStopFailure((current) => current?.id === id ? null : current);
  }, []);
  const stopDispatched = useRef<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const submission = useRef<TextSubmission | null>(null);
  const activePoll = useRef<symbol | null>(null);
  const receivingJobEvents = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const invalidatePoll = useCallback(() => {
    activePoll.current = null;
  }, []);
  const beginSubmission = useCallback((id: string, threadId: string) => {
    const pending = { id, threadId };
    submission.current = pending;
    invalidatePoll();
    setSubmitting(true);
    return pending;
  }, [invalidatePoll]);
  const finishSubmission = useCallback((pending: TextSubmission) => {
    if (submission.current !== pending) return;
    submission.current = null;
    setSubmitting(false);
  }, []);
  const acceptJob = useCallback((accepted: TextJobAcceptance, pending: TextSubmission) => {
    if (submission.current !== pending) return;
    const job = "textJob" in accepted ? accepted.textJob : accepted.job?.job;
    if (!confirmsSubmission(job, pending)) throw new Error("Fern did not receive confirmation for this response.");
    invalidatePoll();
    setStatus((current) => "textJob" in accepted ? { ...current, job: accepted.textJob } : accepted.job);
    setStatusError(null);
  }, [invalidatePoll, setStatus]);
  const submissionIsMissing = useCallback(async (pending: TextSubmission) => {
    if (submission.current !== pending) return false;
    try {
      const latest = await fetchTextStatus();
      if (submission.current !== pending) return false;
      if (!latest.job || typeof latest.job.status !== "string") throw new Error("Invalid text job status.");
      invalidatePoll();
      setStatus(latest);
      setStatusError(null);
      return !confirmsSubmission(latest.job, pending);
    } catch {
      if (submission.current === pending) setStatusError("Lost the connection to the text runtime.");
      return false;
    }
  }, [invalidatePoll, setStatus]);
  const primaryThread = useMemo(
    () => workspace.threads.find((thread) => thread.id === workspace.activeId) ?? workspace.threads[0]!,
    [workspace],
  );
  const secondaryThread = workspace.threads.find((thread) => thread.id === workspace.secondaryId);
  const activePane = visibleChatPane(workspace);
  const activeThread = activePane === "secondary" && secondaryThread ? secondaryThread : primaryThread;
  const getThread = useCallback((id: string) => workspaceRef.current.threads.find((thread) => thread.id === id), []);
  const threads = workspace.threads;
  // Draft edits and reply checkpoints do not change a navigation row.
  const sidebarCache = useRef(EMPTY_SIDEBAR_ROWS);
  const sidebarThreads = useMemo(() => {
    if (!storageReady) return EMPTY_SIDEBAR_ROWS;
    const previous = sidebarCache.current;
    const rows = threads.map((thread, index) => {
      const { id, title, folderId } = thread;
      const archived = thread.archived === true;
      const hasTranscript = thread.messages.length > 0;
      const hasWork = hasTextThreadWork(thread);
      const row = previous[index];
      if (row?.id === id && row.title === title && row.folderId === folderId && row.archived === archived
        && row.hasWork === hasWork && row.hasTranscript === hasTranscript) return row;
      return { id, title, folderId, archived, hasWork, hasTranscript };
    });
    if (rows.length === previous.length && rows.every((row, index) => row === previous[index])) return previous;
    sidebarCache.current = rows;
    return rows;
  }, [storageReady, threads]);
  const hasPendingReply = threads.some((thread) => !!thread.pendingJobId);
  const runtimeJobId = status.job.id;
  const responding = status.job.status === "running" || hasPendingReply;
  const supportsJobPolling = status.supportsJobPolling === true;
  const useJobPoll = responding && supportsJobPolling;
  const watchedJobId = status.supportsJobEvents && status.job.status === "running" ? status.job.id : null;
  const watchedThreadId = watchedJobId ? status.job.threadId : null;
  const attachmentReady = ready && storageReady;
  const savingAttachment = [...attachmentStates.values()].some((attachment) => attachment.status === "saving");
  const busy = !!modelAction || attachingDocument || submitting || responding || isTextModelInstalling(status.modelInstall);

  useEffect(() => {
    let mounted = true;
    void conversationStore.load().then((saved) => {
      if (!mounted || resettingStorage.current) return;
      scheduledWorkspace.current = saved;
      const next = queuedNewChat.current ? openNewChat(saved) : saved;
      queuedNewChat.current = false;
      const observedAt = Date.now();
      setChatState((current) => ({ ...current, workspace:
        settleTextJob(next, current.status.job, current.lastRunningJob, current.status.models, observedAt) }));
      setStorageReady(true);
      setStorageError(null);
    }).catch(() => {
      if (mounted) setStorageError("Chat history could not be opened.");
    });
    return () => { mounted = false; };
  }, [conversationStore, storageAttempt]);

  const persist = useCallback((checkpoint?: TextThreadWorkspace) => {
    if (!storageReady || resettingStorage.current) return;
    const snapshot = checkpoint ?? checkpointTextReply(workspaceRef.current, liveJobRef.current);
    void conversationStore.save(snapshot).then(() => setStorageError(null)).catch(() => {
      setStorageError("Chat changes could not be saved. Keep Fern open and retry to save your changes.");
    });
  }, [conversationStore, storageReady]);

  const retryStorage = useCallback(() => {
    if (storageReady) persist();
    else { setStorageError(null); setStorageAttempt((value) => value + 1); }
  }, [persist, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    const previous = scheduledWorkspace.current;
    scheduledWorkspace.current = workspace;
    const historyChanged = previous.activeId !== workspace.activeId || previous.threads.length !== workspace.threads.length ||
      workspace.threads.some((thread, index) => {
        const before = previous.threads[index];
        return !before || before.id !== thread.id || before.messages !== thread.messages ||
          before.versions !== thread.versions || before.pendingJobId !== thread.pendingJobId;
      });
    if (historyChanged) { persist(); return; }
    const timer = window.setTimeout(persist, 180);
    return () => window.clearTimeout(timer);
  }, [persist, storageReady, workspace]);

  useEffect(() => {
    if (!storageReady) return;
    const flush = () => {
      if (resettingStorage.current) return;
      const snapshot = checkpointTextReply(workspaceRef.current, liveJobRef.current);
      conversationStore.checkpointOnExit(snapshot);
      persist(snapshot);
    };
    window.addEventListener("pagehide", flush);
    const flushWhenHidden = () => { if (document.hidden) flush(); };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [conversationStore, persist, storageReady]);

  useEffect(() => {
    if (!hasPendingReply || status.job.status !== "running") return;
    const timer = window.setInterval(() => {
      setWorkspace((current) => checkpointTextReply(current, liveJobRef.current));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [hasPendingReply, status.job.status]);

  const pollStatus = useCallback(async (jobOnly: boolean) => {
    if (!ready || activePoll.current) return;
    const poll = Symbol();
    activePoll.current = poll;
    try {
      const snapshot = jobOnly ? undefined : await fetchTextStatus();
      const job = snapshot ? snapshot.job : await fetchTextJob();
      if (activePoll.current !== poll) return;
      if (!job || typeof job.status !== "string") throw new Error("The text runtime returned an invalid status.");
      const pending = submission.current;
      const confirmed = !pending || confirmsSubmission(job, pending);
      // A matching live job can confirm a send before its HTTP receipt arrives.
      if (pending && confirmed) finishSubmission(pending);
      if (snapshot) {
        setStatus((current) => reuseUnchangedStatus(current, {
          ...snapshot, job: confirmed ? reconcileRunningTextJob(current.job, job) : current.job,
        }));
        setStatusLoaded(true);
      } else if (confirmed) {
        setStatus((current) => {
          const next = reconcileRunningTextJob(current.job, job);
          return sameTextJob(current.job, next) ? current : { ...current, job: next };
        });
      }
      setStatusError(null);
    } catch (error) {
      if (activePoll.current === poll) setStatusError(jobOnly ? "Lost the connection to the text runtime."
        : error instanceof Error ? error.message : "Could not check text models.");
    } finally {
      if (activePoll.current === poll) activePoll.current = null;
    }
  }, [finishSubmission, ready, setStatus]);

  const refresh = useCallback(() => pollStatus(useJobPoll), [pollStatus, useJobPoll]);
  useEffect(() => { void pollStatus(false); }, [pollStatus, refreshKey]);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      if (!useJobPoll || !receivingJobEvents.current) void refresh();
    }, useJobPoll ? 150 : busy ? 500 : 4000);
    return () => window.clearInterval(timer);
  }, [ready, busy, refresh, useJobPoll]);

  useEffect(() => {
    if (!ready || !watchedThreadId || !watchedJobId) return;
    const retryInterval = 500;
    let retryDelay = retryInterval;
    let retryTimer: number | undefined;
    let close: (() => void) | undefined;
    const onJob = (job: TextJob) => {
      const pending = submission.current;
      if (pending && !confirmsSubmission(job, pending)) return;
      if (pending) finishSubmission(pending);
      retryDelay = retryInterval;
      if (!receivingJobEvents.current || isTerminalTextJob(job)) invalidatePoll();
      receivingJobEvents.current = true;
      setStatus((current) => {
        if (current.job.id !== watchedJobId || current.job.threadId !== watchedThreadId || current.job.status !== "running") return current;
        const next = reconcileRunningTextJob(current.job, job);
        return sameTextJob(current.job, next) ? current : { ...current, job: next };
      });
      setStatusError(null);
    };
    const onLost = () => {
      receivingJobEvents.current = false;
      void pollStatus(supportsJobPolling);
      retryTimer = window.setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 4000);
    };
    const connect = () => {
      close = subscribeToTextJob(watchedThreadId, watchedJobId, onJob, onLost);
    };
    connect();
    return () => {
      window.clearTimeout(retryTimer);
      close?.();
      receivingJobEvents.current = false;
    };
  }, [finishSubmission, invalidatePoll, pollStatus, ready, setStatus, supportsJobPolling, watchedJobId, watchedThreadId]);

  useEffect(() => {
    if (!stoppingId) return;
    const running = status.job.status === "running" && status.job.id === stoppingId;
    const thread = threads.find((item) => item.pendingJobId === stoppingId);
    if (!running && !thread) {
      stopDispatched.current = null;
      setStoppingId(null);
      return;
    }
    const awaitingStart = !running && status.supportsPendingStop ? thread : undefined;
    if ((!running && !awaitingStart) || statusError || stopDispatched.current === stoppingId ||
        (running && status.job.phase === "Stopping generation…")) return;
    stopDispatched.current = stoppingId;
    void stopTextGeneration(stoppingId, awaitingStart?.id).then((receipt) => {
      if (!receipt?.cancelledBeforeStart || !awaitingStart || stopDispatched.current !== stoppingId) return;
      const sending = submission.current;
      if (sending?.id === stoppingId) finishSubmission(sending);
      const observedAt = Date.now();
      const job: TextJob = { ...idleStatus.job, id: stoppingId, threadId: awaitingStart.id, modelId: awaitingStart.modelId,
        status: "stopped", finishedAt: observedAt / 1000 };
      setChatState((current) => {
        const workspace = settleTextJob(current.workspace, job, current.lastRunningJob, current.status.models, observedAt);
        return workspace === current.workspace ? current : { ...current, workspace };
      });
    }).catch((error: unknown) => {
      if (stopDispatched.current !== stoppingId) return;
      stopDispatched.current = null;
      setStoppingId((current) => current === stoppingId ? null : current);
      setStopFailure({ id: stoppingId, message: error instanceof Error ? error.message : "Could not stop text generation." });
    });
  }, [finishSubmission, status.job, status.supportsPendingStop, statusError, stoppingId, threads]);

  // The model process may be gone while its last render is already on disk.
  useEffect(() => {
    if (!ready || !storageReady || !statusLoaded || submitting || statusError || !hasPendingReply) return;
    const controller = new AbortController();
    const timers = new Set<number>();
    const recover = async (threadId: string, jobId: string, attempt = 1) => {
      if (!workspaceRef.current.threads.some((thread) => thread.id === threadId && thread.pendingJobId === jobId)) return;
      let recovered: Awaited<ReturnType<typeof recoverChatImage>> | undefined;
      try {
        recovered = await recoverChatImage(threadId, jobId, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        if (attempt < 3) {
          // Unchanged idle snapshots do not re-render the hook, so retry on a timer.
          const timer = window.setTimeout(() => {
            timers.delete(timer);
            void recover(threadId, jobId, attempt + 1);
          }, 500 * attempt);
          timers.add(timer);
          return;
        }
      }
      if (controller.signal.aborted) return;
      const observedAt = Date.now();
      const { image, images } = recovered ?? {};
      setChatState((current) => {
        // A status poll may have found the response while the disk lookup was in flight.
        if (current.status.job.id === jobId) return current;
        const { workspace, lastRunningJob, status } = current;
        const thread = workspace.threads.find((item) => item.id === threadId && item.pendingJobId === jobId);
        if (!thread) return current;
        const preview = pendingTextReply(thread, lastRunningJob);
        const checkingImage = thread.messages.some((message) => message.inspectionJobId === jobId);
        let error = "The backend restarted before this response was saved. Retry the response.";
        if (checkingImage) error = "The backend restarted during the image check.";
        else if (!recovered) error = "The response stopped, and Fern couldn’t check for saved images. You can retry the response.";
        else if (image || images?.length || preview?.generatedImage) error = "The image was saved before the backend restarted.";
        else if (preview?.content || preview?.reasoning) error = "The backend restarted. The partial response was recovered.";
        const failed: TextJob = { ...idleStatus.job, id: jobId, threadId, modelId: thread.modelId,
          status: "failed", error, errorCode: "backend-restarted", failureDiagnostics: { stage: "connection-lost" },
          image, images: images?.length ? images : undefined };
        return { ...current, workspace: settleTextJob(workspace, failed, lastRunningJob, status.models, observedAt) };
      });
    };
    for (const { id, pendingJobId } of workspaceRef.current.threads) {
      if (pendingJobId && pendingJobId !== runtimeJobId) void recover(id, pendingJobId);
    }
    return () => {
      controller.abort();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [hasPendingReply, ready, runtimeJobId, statusError, statusLoaded, storageReady, submitting]);

  const updateThread = useCallback((id: string, patch: Partial<TextThread>, versionChange?: {
    savedId: string; restoredId?: string;
  }) => {
    const updatedAt = Date.now();
    setChatState((current) => {
      const workspace = {
        ...current.workspace,
        threads: current.workspace.threads.map((thread) => thread.id === id ? { ...thread, ...patch, updatedAt } : thread),
      };
      const deletions = versionChange && current.messageDeletions.get(id);
      if (!versionChange || !deletions?.length) return { ...current, workspace };
      // An Undo belongs to the transcript it changed, even while another version is open.
      const scoped = deletions.map((deletion) => !deletion.snapshotId ? { ...deletion, snapshotId: versionChange.savedId }
        : deletion.snapshotId === versionChange.restoredId ? { ...deletion, snapshotId: undefined } : deletion);
      return { ...current, workspace, messageDeletions: new Map(current.messageDeletions).set(id, scoped) };
    });
  }, []);

  const organize = useCallback((action: ChatOrganizationAction) => {
    setWorkspace((current) => organizeChats(current, action));
  }, []);

  const newThread = useCallback((requestedFolder?: string, comparisonPane?: ChatPane) => {
    if (!storageReady) { queuedNewChat.current = true; return; }
    const current = workspaceRef.current;
    const folders = current.folders ?? EMPTY_CHAT_FOLDERS;
    const folderId = folders.some((folder) => folder.id === requestedFolder) ? requestedFolder : undefined;
    const model = status.models.find((item) => item.installed && item.id === status.defaultModelId)
      ?? status.models.find((item) => item.installed);
    const untouched = current.threads.find((thread) =>
      (!(comparisonPane || current.secondaryId) || (thread.id !== current.activeId && thread.id !== current.secondaryId)) &&
      thread.folderId === folderId && !thread.archived && !thread.renamed &&
      !thread.messages.length && !thread.draft && !thread.draftImage && !thread.draftContextImage && !thread.pendingJobId && !thread.systemPrompt &&
      !thread.documents?.length && !attachmentStates.has(thread.id) && !thread.promptEdit &&
      !thread.modelId && !thread.sampling && !thread.loadOptions && !thread.imageRenderSettings && thread.title === "New text thread"
      && thread.contextSize === 8192 && thread.temperature === 0.7 && thread.topP === 0.9 && thread.maxNewTokens === 512);
    const defaults = model ? current.modelDefaults?.[model.id] : undefined;
    const place = (state: typeof current, id: string) =>
      comparisonPane ? compareChatThread(state, id, comparisonPane) : showChatThread(state, id);
    if (untouched) {
      setWorkspace((current) => ({
        ...place(current, untouched.id), folders: revealChatFolder(current.folders ?? EMPTY_CHAT_FOLDERS, folderId),
        threads: defaults && model
          ? current.threads.map((item) => item.id === untouched.id ? { ...item, ...defaults, modelId: model.id } : item)
          : current.threads,
      }));
      setActionError(null);
      return untouched.id;
    }
    const thread = { ...createTextThread(), ...defaults, folderId, ...(defaults && model ? { modelId: model.id } : {}) };
    setWorkspace((current) => ({
      ...place(current, thread.id), threads: [thread, ...current.threads],
      folders: revealChatFolder(current.folders ?? EMPTY_CHAT_FOLDERS, folderId),
    }));
    setActionError(null);
    return thread.id;
  }, [attachmentStates, setWorkspace, status.defaultModelId, status.models, setActionError, storageReady]);

  const selectThread = useCallback((id: string) => {
    setWorkspace((current) => {
      const thread = current.threads.find((item) => item.id === id);
      return thread ? { ...showChatThread(current, id),
        folders: revealChatFolder(current.folders ?? EMPTY_CHAT_FOLDERS, thread.folderId) } : current;
    });
    setActionError(null);
  }, [setActionError]);

  const compareThread = useCallback((id: string, pane: ChatPane) => {
    setWorkspace((current) => {
      const thread = current.threads.find((item) => item.id === id);
      return thread ? { ...compareChatThread(current, id, pane),
        folders: revealChatFolder(current.folders ?? EMPTY_CHAT_FOLDERS, thread.folderId) } : current;
    });
  }, []);

  const focusPane = useCallback((pane: ChatPane) => {
    setWorkspace((current) => visibleChatPane(current) === pane || (pane === "secondary" && !current.secondaryId)
      ? current : { ...current, activePane: pane });
  }, []);

  const closePane = useCallback((pane: ChatPane) => setWorkspace((current) => closeChatPane(current, pane)), []);
  const resizePanes = useCallback((percent: number) => setWorkspace((current) => ({
    ...current, splitPercent: normalizeChatSplit(percent),
  })), []);

  const copyThread = useCallback((id: string, messageId?: string, fork = false) => {
    const source = workspaceRef.current.threads.find((thread) => thread.id === id);
    if (!source) return;
    const thread = copyChat(source, messageId, undefined, fork);
    if (!thread) return;
    setWorkspace((current) => ({ ...showChatThread(current, thread.id, current.secondaryId === id ? "secondary" : "primary"), threads: [thread, ...current.threads] }));
    setActionError(null);
    return thread.id;
  }, []);

  const selectReply = useCallback((threadId: string, messageId: string, versionId: string) => {
    if (submission.current) return;
    const thread = getThread(threadId);
    if (!thread || thread.pendingJobId) return;
    const current = thread.messages.at(-1);
    if (current?.id !== messageId || current.role !== "assistant") return;
    const selected = showReplyVersion(current, versionId);
    if (selected !== current) updateThread(thread.id, {
      messages: [...thread.messages.slice(0, -1), selected],
    });
  }, [getThread, updateThread]);

  const deleteMessage = useCallback((threadId: string, messageId: string, versionId?: string) => {
    const updatedAt = Date.now();
    setChatState((current) => {
      const threads = current.workspace.threads;
      const thread = threads.find((item) => item.id === threadId);
      const removed = thread && removeTextMessage(thread, messageId, updatedAt, versionId);
      if (!removed) return current;
      const deletions = current.messageDeletions.get(threadId) ?? [];
      return {
        ...current,
        workspace: { ...current.workspace, threads: threads.map((item) => item === thread ? removed.thread : item) },
        messageDeletions: new Map(current.messageDeletions).set(threadId, [...deletions, removed.deletion]),
      };
    });
  }, []);

  const undoMessageDeletion = useCallback((threadId: string) => {
    const updatedAt = Date.now();
    setChatState((current) => {
      const deletions = current.messageDeletions.get(threadId);
      const deletion = deletions?.at(-1);
      const threads = current.workspace.threads;
      const thread = threads.find((item) => item.id === threadId);
      if (!deletions || !deletion || !thread || thread.pendingJobId) return current;
      const restored = restoreTextMessages(thread, deletion, updatedAt);
      const messageDeletions = new Map(current.messageDeletions);
      if (deletions.length > 1) messageDeletions.set(threadId, deletions.slice(0, -1));
      else messageDeletions.delete(threadId);
      return {
        ...current,
        workspace: { ...current.workspace, threads: threads.map((item) => item === thread ? restored : item) },
        messageDeletions,
      };
    });
  }, []);

  const dismissMessageDeletion = useCallback((threadId: string) => {
    setChatState((current) => {
      if (!current.messageDeletions.has(threadId)) return current;
      const messageDeletions = new Map(current.messageDeletions);
      messageDeletions.delete(threadId);
      return { ...current, messageDeletions };
    });
  }, []);

  const updateAttachment = useCallback((threadId: string, attachment?: DraftAttachment) => {
    setAttachmentStates((current) => {
      if (!attachment && !current.has(threadId)) return current;
      const next = new Map(current);
      if (attachment) next.set(threadId, attachment);
      else next.delete(threadId);
      return next;
    });
  }, []);

  const clearAttachment = useCallback((threadId: string) => {
    attachmentRequests.current.get(threadId)?.abort();
    attachmentRequests.current.delete(threadId);
    updateAttachment(threadId);
  }, [updateAttachment]);

  const resetWorkspace = useCallback(async () => {
    const fresh = createTextWorkspace();
    resettingStorage.current = true;
    for (const upload of attachmentRequests.current.values()) upload.abort();
    attachmentRequests.current.clear();
    setAttachmentStates(new Map());
    try {
      await conversationStore.load();
      await conversationStore.save(fresh);
      conversationStore.clearLegacy();
      clearChatReadingPositions();
      workspaceRef.current = fresh;
      scheduledWorkspace.current = fresh;
      setChatState({ workspace: fresh, messageDeletions: new Map(), status: idleStatus, lastRunningJob: idleStatus.job });
      setStorageReady(true);
      setStorageError(null);
    } finally { resettingStorage.current = false; }
    if (submission.current) finishSubmission(submission.current);
    invalidatePoll();
    setStatusLoaded(false);
    setRefreshKey((value) => value + 1);
    setActionError(null);
    setStoppingId(null);
    stopDispatched.current = null;
  }, [conversationStore, finishSubmission, invalidatePoll]);

  const renameThread = useCallback((id: string, title: string) => {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 80);
    if (clean) updateThread(id, { title: clean, renamed: true });
  }, [updateThread]);

  const archiveThread = useCallback((id: string) => {
    const updatedAt = Date.now();
    setWorkspace((current) => {
      const index = current.threads.findIndex((thread) => thread.id === id);
      if (index < 0) return current;
      const thread = current.threads[index];
      const threads = [...current.threads];
      threads[index] = { ...thread, archived: !thread.archived, updatedAt };
      return { ...current, threads };
    });
  }, [setWorkspace]);

  const deleteThread = useCallback((id: string) => {
    if (getThread(id)?.pendingJobId || (busy && status.job.threadId === id)) {
      setActionError("Stop the response before deleting this text thread.", id);
      return;
    }
    setWorkspace((current) => {
      const remaining = current.threads.filter((thread) => thread.id !== id);
      if (!remaining.length) {
        const fresh = createTextThread();
        return { ...current, activeId: fresh.id, secondaryId: undefined, activePane: "primary", threads: [fresh] };
      }
      if (current.secondaryId && (current.activeId === id || current.secondaryId === id))
        return { ...closeChatPane(current, current.activeId === id ? "primary" : "secondary"), threads: remaining };
      return { ...current, activeId: current.activeId === id ? remaining[0].id : current.activeId, threads: remaining };
    });
    saveChatReadingPosition(id);
    dismissMessageDeletion(id);
    clearAttachment(id);
  }, [busy, clearAttachment, dismissMessageDeletion, getThread, setActionError, setWorkspace, status.job.threadId]);

  const importModel = useCallback(async (format: "openvino" | "gguf" = "openvino") => {
    if (modelActionRef.current) return;
    modelActionRef.current = true;
    setModelAction("Adding model…");
    setActionError(null);
    try {
      const source = format === "gguf" ? await window.studio.pickGgufFiles() : await window.studio.pickTextModelFolder();
      if (!source?.length) return;
      const result = await addTextModel(source);
      setStatus((current) => ({ ...current, models: result.models }));
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not add this model.");
    } finally {
      modelActionRef.current = false;
      setModelAction(null);
    }
  }, [setStatus]);

  const attachImages = useCallback(async (threadId: string, files: File[]) => {
    const activeThread = getThread(threadId);
    if (!activeThread) return;
    if (!attachmentReady || resettingStorage.current || !files.length || attachmentRequests.current.has(threadId)) return;
    if (activeThread.draftContextImage || files.length > 1) {
      updateAttachment(threadId, { status: "failed", message: activeThread.draftContextImage
        ? "Remove the selected conversation image before attaching a new file."
        : "Attach one image per message." });
      return;
    }
    const [file] = files;
    const upload = new AbortController();
    attachmentRequests.current.set(threadId, upload);
    updateAttachment(threadId, { status: "saving", filename: file.name });
    let readable = false;
    try {
      const data = await readReference(file);
      if (upload.signal.aborted) return;
      readable = true;
      const { image } = await uploadChatImage(data, upload.signal);
      if (upload.signal.aborted) return;
      if (!isChatImage(image)) throw new Error("Fern could not save this chat image.");
      setWorkspace((current) => {
        const target = current.threads.find((thread) => thread.id === threadId);
        if (!target || target.draftContextImage) return current;
        return { ...current, threads: current.threads.map((thread) => thread === target
          ? { ...thread, draftImage: image, updatedAt: Date.now() } : thread) };
      });
      updateAttachment(threadId);
    } catch (error) {
      if (!upload.signal.aborted) updateAttachment(threadId, {
        status: "failed", message: error instanceof Error && error.name !== "TimeoutError" && !(error instanceof TypeError)
          ? error.message : "Could not attach this image. Try again.",
        retryFile: readable ? file : undefined,
      });
    } finally {
      if (attachmentRequests.current.get(threadId) === upload) attachmentRequests.current.delete(threadId);
    }
  }, [attachmentReady, getThread, setWorkspace, updateAttachment]);

  const attachDocuments = useCallback(async (threadId: string, files: File[]) => {
    const activeThread = getThread(threadId);
    if (!activeThread || !files.length || busy || documentUpload.current) return;
    setActionError(null);
    if (files.length + (activeThread.documents?.length ?? 0) > MAX_CHAT_DOCUMENTS) {
      setActionError(`Attach up to ${MAX_CHAT_DOCUMENTS} documents per chat.`, threadId);
      return;
    }
    documentUpload.current = true;
    setAttachingDocument(true);
    try {
      files.forEach(validateChatDocument);
      for (const file of files) {
        const { document } = await uploadChatDocument(file);
        if (!isChatDocument(document)) throw new Error("Fern could not save this document.");
        setWorkspace((current) => ({ ...current, threads: current.threads.map((thread) => {
          if (thread.id !== threadId || thread.documents?.some((item) => item.id === document.id)) return thread;
          return { ...thread, documents: [...(thread.documents ?? []), document], updatedAt: Date.now() };
        }) }));
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not attach this document.", threadId);
    } finally {
      documentUpload.current = false;
      setAttachingDocument(false);
    }
  }, [busy, getThread, setActionError, setWorkspace]);

  const removeDocument = (threadId: string, id: string) => {
    const activeThread = getThread(threadId);
    if (!busy && activeThread) {
      updateThread(activeThread.id, { documents: activeThread.documents?.filter((item) => item.id !== id) });
      setActionError(null);
    }
  };

  const deleteModel = useCallback(async (id: string) => {
    if (modelActionRef.current) return false;
    modelActionRef.current = true;
    setModelAction("Removing model…");
    setActionError(null);
    try {
      const result = await removeTextModel(id);
      setStatus((current) => ({ ...current, models: result.models }));
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not remove this model from Fern.");
      return false;
    } finally {
      modelActionRef.current = false;
      setModelAction(null);
    }
  }, [setStatus]);

  const installRecommendedModel = useCallback(async (id: string) => {
    if (modelActionRef.current) return;
    modelActionRef.current = true;
    setModelAction("Starting download…");
    setActionError(null);
    try {
      const result = await installTextModel(id);
      invalidatePoll();
      setStatus(result);
      setStatusError(null);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not install the recommended model.");
    } finally {
      modelActionRef.current = false;
      setModelAction(null);
    }
  }, [invalidatePoll, setStatus]);

  const pauseRecommendedModel = useCallback(async (jobId: string) => {
    if (modelActionRef.current) return;
    modelActionRef.current = true;
    setModelAction("Pausing download…");
    setActionError(null);
    try {
      const { modelInstall } = await pauseTextModelDownload(jobId);
      invalidatePoll();
      setStatus((current) => modelInstall.id === jobId && current.modelInstall?.id === jobId &&
        isTextModelInstalling(current.modelInstall) ? { ...current, modelInstall } : current);
      setStatusError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not pause the text model download.");
    } finally {
      setRefreshKey((value) => value + 1);
      modelActionRef.current = false;
      setModelAction(null);
    }
  }, [invalidatePoll, setStatus]);

  const generateReply = useCallback(async (thread: TextThread, input: string, { retry = false, sourceId, revision, continueFrom, rewriteId }: {
    retry?: boolean; sourceId?: string; revision?: { messageId: string; version: TextPromptVersion }; continueFrom?: string; rewriteId?: string;
  } = {}) => {
    if (busy || submission.current || (!retry && !revision && !continueFrom && attachmentRequests.current.has(thread.id))) return;
    const status = statusRef.current;
    if (continueFrom) {
      const last = thread.messages.at(-1);
      if (last?.id !== continueFrom || !canContinueTextReply(last)) return;
    }
    const rewriteIndex = rewriteId ? thread.messages.findIndex((message) => message.id === rewriteId && message.role === "user") : -1;
    if (rewriteId && rewriteIndex < 0) return;
    const original = revision ? latestTextPrompt(thread.messages) : thread.messages[rewriteIndex];
    const attached = original ? !!(original?.image || original?.includedImage) : !!(thread.draftImage || thread.draftContextImage);
    const text = input.trim() || (attached && !retry ? "Describe this image." : "");
    if (!text && !retry) return;
    setActionError(null);
    const modelId = resolveTextModel(status, thread);
    const model = status.models.find((item) => item.id === modelId && item.installed);
    if (!modelId || !model) {
      setActionError("Add a local text model before starting a conversation.", thread.id);
      return;
    }
    const runtimeIssue = textRuntimeIssue(status, model);
    if (runtimeIssue) {
      setActionError(runtimeIssue, thread.id);
      return;
    }
    const messages = revision ? replaceLatestPromptVersion(thread, revision.messageId, { ...revision.version, content: text })
      : rewriteId && original ? [...thread.messages.slice(0, rewriteIndex), { ...original, content: text, createdAt: Date.now() }]
      : retry ? thread.messages.slice(0, thread.messages.map((message) => message.role).lastIndexOf("user") + 1)
      : [...thread.messages, {
        id: `message-${crypto.randomUUID()}`, role: "user" as const, content: text,
        ...(continueFrom ? { continuationOf: continueFrom } : {
          image: thread.draftImage, includedImage: thread.draftContextImage,
          includedImageThreadId: draftContextImageOwner(thread),
        }),
        createdAt: Date.now(),
      }];
    if (!messages) return;
    const prompt = messages.at(-1);
    if (!prompt) return;
    if (model.format !== "gguf" && textPromptExceedsLimit(prompt.content)) {
      setActionError(`The current prompt exceeds ${TEXT_MESSAGE_CHARACTER_LIMIT.toLocaleString()} characters. Edit it before sending.`, thread.id);
      return;
    }
    if (!model.supportsVision && (prompt.image || prompt.includedImage)) {
      setActionError("Choose a vision model to send this image.");
      return;
    }
    const history = textPromptHistory(messages, model);
    if (!history.messages.length) return;
    const title = !thread.renamed && thread.messages.length === 0 && thread.title === "New text thread"
      ? text.replace(/\s+/g, " ").slice(0, 56)
      : thread.title;
    const requestId = crypto.randomUUID();
    const imageOptions = status.imageToolModels ?? [];
    const imageModel = !prompt.continuationOf && model.supportsTools && model.supportsVision && computeDevice === "GPU" && imageGpuAvailable !== false
      ? (thread.imageModel === "auto" ? imageOptions[0] : imageOptions.find((item) => item.id === thread.imageModel))
      : undefined;
    const imageSettings = imageModel ? chatImageSettings(imageModel, thread.imageRenderSettings?.[imageModel.id]) : undefined;
    if (imageModel && imageSettings && Object.keys(chatImageErrors(imageModel, imageSettings)).length) {
      setActionError("Correct the image settings or turn image generation off before sending.", thread.id, "image-settings");
      return;
    }
    const { contextSize, maxNewTokens } = chatTokenLimits(thread, model);
    const receipt = beginSubmission(requestId, thread.id);
    const snapshot = rewriteId ? snapshotTextVersion(thread.messages) : undefined;
    const pending: Partial<TextThread> = {
      title, modelId, pendingJobId: requestId, pendingPreview: undefined, pendingContext: history.context,
      ...(snapshot ? { versions: [snapshot, ...(thread.versions ?? [])] } : {}),
      ...(revision || rewriteId ? { messages, promptEdit: undefined } : retry ? {} : continueFrom ? { messages }
        : { messages, draft: "", draftImage: undefined, draftContextImage: undefined, draftContextImageThreadId: undefined }),
    };
    if (sourceId) setWorkspace((current) => addEditedChat(current, sourceId, { ...thread, ...pending }));
    else updateThread(thread.id, pending, snapshot && { savedId: snapshot.id });
    try {
      const accepted = await startTextGeneration({
        requestId,
        threadId: thread.id,
        modelId,
        device: computeDevice === "CPU" ? "CPU" : "AUTO",
        messages: history.messages,
        ...(thread.documents?.length ? { documentIds: thread.documents.map(({ id }) => id) } : {}),
        ...(model.supportsReasoning ? { mode: thread.mode } : {}),
        ...(imageModel && imageSettings ? { imageModel: imageModel.id, imageSettings: {
          width: imageSettings.width, height: imageSettings.height, steps: imageSettings.steps, guidance: imageSettings.guidance,
          ...(imageSettings.promptSuffix.trim() ? { promptSuffix: imageSettings.promptSuffix.trim() } : {}),
          ...(imageSettings.seedLocked ? { seed: imageSettings.seed } : {}),
          ...(imageSettings.batchSize > 1 ? { batchSize: imageSettings.batchSize } : {}),
          ...(imageSettings.loras?.length ? { loras: imageSettings.loras } : {}),
          ...(imageSettings.references?.length ? { referenceImages: imageSettings.references.map((image) => image.name) } : {}),
          ...(imageSettings.useMessageImage ? { useMessageImage: true } : {}),
        } } : {}),
        ...(model.format === "gguf" ? { contextSize, loadOptions: ggufLoadOptions(thread.loadOptions, contextSize) } : {}),
        systemPrompt: thread.systemPrompt,
        temperature: thread.temperature,
        topP: thread.topP,
        ...(thread.sampling ? { sampling: textSamplingOverrides(thread.sampling) } : {}),
        maxNewTokens,
        seed: thread.sampling?.fixedSeed ?? Math.floor(Math.random() * 2_147_483_647),
      });
      acceptJob(accepted, receipt);
    } catch (error) {
      // A lost HTTP response does not mean the request was rejected.
      if (await submissionIsMissing(receipt)) setWorkspace((current) => ({ ...current, threads: current.threads.map((item) =>
        item.id === thread.id && item.pendingJobId === requestId ? {
          ...item, pendingJobId: null, pendingPreview: undefined, pendingContext: undefined, messages: finishTextReply(item, {
            id: `response-${requestId}`, jobId: requestId, role: "assistant", content: "", createdAt: Date.now(), status: "failed",
            error: error instanceof Error ? error.message : "Could not start text generation.",
            failureDiagnostics: captureTextFailure({
              stage: "request-admission", requestedDevice: computeDevice === "CPU" ? "CPU" : "AUTO",
              runtime: model.format === "gguf" ? "gguf" : "openvino",
            }),
            requestContext: item.pendingContext,
          }),
        } : item),
      }));
    } finally {
      finishSubmission(receipt);
    }
  }, [acceptJob, beginSubmission, busy, computeDevice, finishSubmission, imageGpuAvailable, setWorkspace, submissionIsMissing, updateThread]);

  const send = useCallback((threadId: string, input: string, rewriteId?: string) => {
    const thread = getThread(threadId);
    if (thread) return generateReply(thread, input, { rewriteId });
  }, [generateReply, getThread]);
  const retry = useCallback((threadId: string) => {
    const thread = getThread(threadId);
    if (thread) return generateReply(thread, "", { retry: true });
  }, [generateReply, getThread]);
  const continueReply = useCallback((threadId: string, messageId: string) => {
    const thread = getThread(threadId);
    if (thread) return generateReply(thread,
      "Continue from where you stopped. Avoid repeating what you already wrote.", { continueFrom: messageId });
  }, [generateReply, getThread]);

  const revisePrompt = useCallback((sourceId: string, messageId: string, content: string, action: "replace" | "branch" | "draft") => {
    if (action !== "draft" && (busy || submission.current)) return;
    const source = workspaceRef.current.threads.find((thread) => thread.id === sourceId);
    if (!source || source.promptEdit?.messageId !== messageId) return;
    if (action === "replace") {
      const prompt = latestTextPrompt(source.messages);
      if (prompt?.id !== messageId || content.trim() === prompt.content.trim()) return;
      const version = { id: crypto.randomUUID(), content, createdAt: Date.now() };
      void generateReply(source, content, { revision: { messageId, version } });
      return sourceId;
    }
    const branch = copyChat(source, messageId, content);
    if (!branch || (!branch.draft.trim() && !branch.draftImage && !branch.draftContextImage)) return;
    if (action === "branch") void generateReply(branch, branch.draft, { sourceId });
    else {
      setWorkspace((current) => addEditedChat(current, sourceId, branch));
      setActionError(null);
    }
    return branch.id;
  }, [busy, generateReply]);

  const restorePromptVersion = useCallback((threadId: string, promptId: string, versionId: string) => {
    if (busy || submission.current) return;
    const thread = workspaceRef.current.threads.find((item) => item.id === threadId);
    const version = thread && latestTextPrompt(thread.messages)?.promptAlternatives?.find((item) => item.id === versionId);
    const messages = thread && version && replaceLatestPromptVersion(thread, promptId, version);
    if (!messages) return;
    updateThread(threadId, { messages, promptEdit: thread.promptEdit?.messageId === promptId ? undefined : thread.promptEdit });
    setActionError(null);
  }, [busy, updateThread]);

  const restoreVersion = useCallback((threadId: string, id: string) => {
    const activeThread = getThread(threadId);
    if (busy || submission.current || activeThread?.pendingJobId || !activeThread?.versions) return;
    const previous = activeThread.versions.find((version) => version.id === id);
    if (!previous) return;
    const snapshot = snapshotTextVersion(activeThread.messages);
    updateThread(activeThread.id, {
      messages: previous.messages,
      versions: [snapshot, ...activeThread.versions.filter((version) => version.id !== id)],
    }, { savedId: snapshot.id, restoredId: previous.id });
    setActionError(null);
  }, [getThread, busy, updateThread, setActionError]);

  const retryInspection = useCallback(async (threadId: string, messageId: string) => {
    if (busy || submission.current) return;
    const status = statusRef.current;
    const thread = getThread(threadId);
    const message = thread?.messages.find((item) => item.id === messageId);
    const model = status.models.find((item) => item.id === thread?.modelId && item.installed);
    if (!thread || !message?.generatedImage || !model?.supportsVision || textRuntimeIssue(status, model)) return;

    const requestId = crypto.randomUUID();
    const receipt = beginSubmission(requestId, thread.id);
    updateThread(thread.id, {
      pendingJobId: requestId, pendingPreview: undefined, pendingContext: undefined,
      messages: thread.messages.map((item) => item.id === messageId ? { ...item, inspectionJobId: requestId } : item),
    });
    try {
      const accepted = await inspectChatImage({
        requestId, threadId: thread.id, modelId: model.id,
        image: message.generatedImage.name, imageThreadId: message.generatedImage.originThreadId ?? message.imageThreadId,
        device: computeDevice === "CPU" ? "CPU" : "AUTO",
      });
      acceptJob(accepted, receipt);
    } catch (error) {
      if (await submissionIsMissing(receipt)) setWorkspace((current) => ({ ...current, threads: current.threads.map((item) =>
        item.id === thread.id && item.pendingJobId === requestId ? {
          ...item,
          pendingJobId: null,
          messages: item.messages.map((message) => message.id === messageId ? {
            ...message, inspectionJobId: undefined, status: "failed",
            error: error instanceof Error ? error.message : "Could not start the image check.",
            errorCode: undefined, failureDiagnostics: captureTextFailure({
              stage: "request-admission", requestedDevice: computeDevice === "CPU" ? "CPU" : "AUTO",
              runtime: model.format === "gguf" ? "gguf" : "openvino",
            }),
          } : message),
        } : item),
      }));
    } finally {
      finishSubmission(receipt);
    }
  }, [acceptJob, beginSubmission, busy, computeDevice, finishSubmission, getThread, setWorkspace, submissionIsMissing, updateThread]);

  const runningJobId = status.job.status === "running" ? status.job.id : null;
  const runningThreadId = status.job.threadId;
  const stop = useCallback((threadId: string) => {
    const requestId = getThread(threadId)?.pendingJobId ??
      (runningThreadId === threadId ? runningJobId : null);
    if (requestId && requestId !== stoppingId) {
      setActionError(null);
      setStopFailure(null);
      setStoppingId(requestId);
    }
  }, [getThread, runningJobId, runningThreadId, stoppingId, setActionError]);

  const selectModel = useCallback((threadId: string, modelId: string) => {
    const activeThread = getThread(threadId);
    if (activeThread && activeThread.modelId !== modelId) {
      const defaults = workspaceRef.current.modelDefaults?.[modelId];
      updateThread(activeThread.id, { ...defaults, modelId: modelId || null });
    }
  }, [getThread, updateThread]);

  const saveModelDefaults = useCallback((threadId: string, modelId: string) => {
    const activeThread = getThread(threadId);
    if (!activeThread) return;
    const defaults = modelDefaultsFromThread(activeThread);
    setWorkspace((current) => ({ ...current, modelDefaults: { ...current.modelDefaults, [modelId]: defaults } }));
  }, [getThread]);

  const clearModelDefaults = useCallback((modelId: string) => {
    setWorkspace((current) => {
      const remaining = { ...current.modelDefaults };
      delete remaining[modelId];
      return { ...current, modelDefaults: remaining };
    });
  }, []);

  const saveChatPreset = (threadId: string, name: string, id?: string) => {
    const activeThread = getThread(threadId);
    if (busy || !activeThread) return;
    const preset = { id: id ?? crypto.randomUUID(), name, settings: chatPresetSettings(activeThread) };
    setWorkspace((current) => ({
      ...current, presets: [...(current.presets ?? []).filter((entry) => entry.id !== preset.id), preset]
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
    return preset.id;
  };

  const applyChatPreset = (threadId: string, id: string) => {
    const activeThread = getThread(threadId);
    const preset = workspace.presets?.find((entry) => entry.id === id);
    if (!busy && activeThread && preset) updateThread(activeThread.id, preset.settings);
  };

  const deleteChatPreset = (id: string) => {
    if (!busy) setWorkspace((current) => ({
      ...current, presets: current.presets?.filter((entry) => entry.id !== id),
    }));
  };

  const setDevice = useCallback((threadId: string, device: TextDevice) => updateThread(threadId, { device }), [updateThread]);

  const exportTranscript = useCallback(async (id: string, destination: TranscriptDestination) => {
    const thread = workspaceRef.current.threads.find((item) => item.id === id);
    if (!thread?.messages.length || (destination === "file" && savingTranscript.current)) return;
    if (destination === "file") savingTranscript.current = true;
    try {
      const live = liveJobRef.current;
      const modelId = live.id === thread.pendingJobId ? live.modelId : thread.modelId;
      const modelName = status.models.find((model) => model.id === modelId)?.name;
      const markdown = formatTextTranscript(thread, pendingTextReply(thread, live), modelName);
      if (destination === "file") {
        if (await window.studio.saveChatTranscript(thread.title, markdown)) notify("Chat transcript saved.");
      } else {
        await window.studio.copyText(markdown);
        notify("Chat transcript copied.");
      }
    } catch {
      notify(destination === "file" ? "Could not save the chat transcript." : "Could not copy the chat transcript.", "error");
    } finally {
      if (destination === "file") savingTranscript.current = false;
    }
  }, [status.models]);

  return {
    sidebarThreads,
    threads: storageReady ? threads : [], activeThread, status, statusLoaded, modelAction, submitting, draftAttachments: attachmentStates, attachingDocument, attachmentReady, savingAttachment, statusError, actionError, dismissActionError, storageReady, storageError, retryStorage, busy, computeDevice,
    pendingReplyOutput: (thread: TextThread) => pendingTextReply(thread, liveJobRef.current),
    primaryThread, secondaryThread, activePane, splitPercent: workspace.splitPercent ?? 50, compareThread, closePane, resizePanes, focusPane,
    folders: workspace.folders ?? EMPTY_CHAT_FOLDERS, organize,
    modelDefaults: workspace.modelDefaults, saveModelDefaults, clearModelDefaults,
    chatPresets: workspace.presets, saveChatPreset, applyChatPreset, deleteChatPreset,
    attachDocuments, removeDocument, restoreVersion,
    replyPaused,
    stopFailure, dismissStopFailure,
    isStopping: (thread: TextThread) => !!stoppingId && thread.pendingJobId === stoppingId
      || status.job.status === "running" && status.job.threadId === thread.id
        && (status.job.id === stoppingId || status.job.phase === "Stopping generation…"),
    newThread, selectThread, copyThread, exportTranscript, resetWorkspace, renameThread, archiveThread, deleteThread, deleteMessage,
    messageDeletions, undoMessageDeletion, dismissMessageDeletion,
    updateThread, importModel, deleteModel, installRecommendedModel, pauseRecommendedModel, attachImages, clearAttachment, send, retry, continueReply, retryInspection, selectReply, revisePrompt, restorePromptVersion, stop, refresh, selectModel, setDevice,
  };
}
