import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addTextModel,
  fetchTextStatus,
  installTextModel,
  removeTextModel,
  startTextGeneration,
  stopTextGeneration,
} from "../lib/api";
import {
  createTextThread,
  loadTextThreads,
  saveTextThreads,
  type TextDevice,
  type TextMessage,
  type TextRuntimeStatus,
  type TextThread,
} from "../lib/textThreads";

const idleStatus: TextRuntimeStatus = {
  models: [], runtimeAvailable: false, runtimeError: null,
  devices: ["AUTO", "GPU", "CPU"],
  job: { id: null, threadId: null, modelId: null, status: "idle", phase: null, partialText: "", startedAt: null, finishedAt: null, result: null, error: null },
};

export function useTextChat(ready: boolean, computeDevice: "GPU" | "CPU" = "GPU") {
  const [workspace, setWorkspace] = useState(loadTextThreads);
  const workspaceRef = useRef(workspace);
  const persistPendingRef = useRef(false);
  workspaceRef.current = workspace;
  const [status, setStatus] = useState(idleStatus);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [modelAction, setModelAction] = useState<string | null>(null);
  const modelActionRef = useRef(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const sending = useRef(false);
  const pollVersion = useRef(0);
  const polling = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const activeThread = useMemo(
    () => workspace.threads.find((thread) => thread.id === workspace.activeId) ?? workspace.threads[0]!,
    [workspace],
  );
  const threads = workspace.threads;
  const busy = !!modelAction || submitting || status.job.status === "running" || ["downloading", "preparing"].includes(status.modelInstall?.status ?? "") || threads.some((thread) => !!thread.pendingJobId);

  useEffect(() => {
    persistPendingRef.current = true;
    const persist = () => {
      try { saveTextThreads(workspace); }
      catch { setActionError("Conversation storage is full or unavailable. Copy important responses and free space in Local data."); }
      finally { persistPendingRef.current = false; }
    };
    const timer = window.setTimeout(persist, 180);
    const flush = () => {
      try { saveTextThreads(workspaceRef.current); }
      catch { /* The next app launch can still recover the last saved conversation. */ }
    };
    window.addEventListener("pagehide", flush);
    return () => { window.clearTimeout(timer); window.removeEventListener("pagehide", flush); };
  }, [workspace]);

  const refresh = useCallback(async () => {
    if (!ready || polling.current || sending.current) return;
    polling.current = true;
    const version = ++pollVersion.current;
    try {
      const next = await fetchTextStatus();
      if (version !== pollVersion.current || sending.current) return;
      setStatus(next);
      setStatusLoaded(true);
      setStatusError(null);
    } catch (error) {
      if (version === pollVersion.current) setStatusError(error instanceof Error ? error.message : "Could not check text models.");
    } finally {
      polling.current = false;
    }
  }, [ready]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => { void refresh(); }, busy ? 600 : 4000);
    return () => window.clearInterval(timer);
  }, [ready, busy, refresh]);

  useEffect(() => {
    const job = status.job;
    if (!["complete", "failed", "stopped"].includes(job.status) || !job.id || !job.threadId) return;
    const assistant: TextMessage = {
      id: `response-${job.id}`, jobId: job.id, role: "assistant", content: job.partialText,
      status: job.status as "complete" | "failed" | "stopped", error: job.error,
      modelName: job.result?.modelName ?? status.models.find((model) => model.id === job.modelId)?.name ?? "Unavailable model",
      createdAt: job.finishedAt ? job.finishedAt * 1000 : Date.now(),
      metrics: job.result ?? undefined,
    };
    setWorkspace((current) => {
      if (!current.threads.some((thread) => thread.id === job.threadId && thread.pendingJobId === job.id)) return current;
      return { ...current,
      threads: current.threads.map((thread) => thread.id === job.threadId && thread.pendingJobId === job.id
        ? { ...thread, pendingJobId: null, messages: thread.messages.some((message) => message.jobId === job.id) ? thread.messages : [...thread.messages, assistant], updatedAt: Date.now() }
        : thread),
    }; });
  }, [status.job, status.models]);

  // A backend restart cannot resume a killed process. Preserve the user turn for retry.
  useEffect(() => {
    if (!ready || submitting || status === idleStatus || statusError) return;
    setWorkspace((current) => {
      if (!current.threads.some((thread) => thread.pendingJobId && thread.pendingJobId !== status.job.id)) return current;
      return { ...current, threads: current.threads.map((thread) => thread.pendingJobId && thread.pendingJobId !== status.job.id
        ? { ...thread, pendingJobId: null, messages: [...thread.messages, { id: `response-${thread.pendingJobId}`, jobId: thread.pendingJobId, role: "assistant" as const, content: "", createdAt: Date.now(), status: "failed" as const, error: "The backend restarted before this response was saved. Retry the response." }] }
        : thread) };
    });
  }, [ready, submitting, status, statusError]);

  const updateThread = useCallback((id: string, patch: Partial<TextThread>) => {
    setWorkspace((current) => ({
      ...current,
      threads: current.threads.map((thread) => thread.id === id
        ? { ...thread, ...patch, updatedAt: Date.now() }
        : thread),
    }));
  }, []);

  const newThread = useCallback(() => {
    if (activeThread && !activeThread.archived && !activeThread.messages.length && !activeThread.draft && !activeThread.pendingJobId && activeThread.title === "New text thread") {
      setActionError(null);
      return activeThread.id;
    }
    const thread = createTextThread();
    setWorkspace((current) => ({ activeId: thread.id, threads: [thread, ...current.threads] }));
    setActionError(null);
    return thread.id;
  }, [activeThread]);

  const selectThread = useCallback((id: string) => {
    setWorkspace((current) => current.threads.some((thread) => thread.id === id) ? { ...current, activeId: id } : current);
    setActionError(null);
  }, []);

  const resetWorkspace = useCallback(() => {
    const thread = createTextThread();
    ++pollVersion.current;
    setStatus(idleStatus);
    setStatusLoaded(false);
    setRefreshKey((value) => value + 1);
    setWorkspace({ activeId: thread.id, threads: [thread] });
    setActionError(null);
  }, []);

  const renameThread = useCallback((id: string, title: string) => {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 80);
    if (clean) updateThread(id, { title: clean });
  }, [updateThread]);

  const archiveThread = useCallback((id: string) => updateThread(id, { archived: !threads.find((thread) => thread.id === id)?.archived }), [threads, updateThread]);

  const deleteThread = useCallback((id: string) => {
    if (workspace.threads.some((thread) => thread.id === id && thread.pendingJobId) || (busy && status.job.threadId === id)) {
      setActionError("Stop the response before deleting this text thread.");
      return;
    }
    setWorkspace((current) => {
      const remaining = current.threads.filter((thread) => thread.id !== id);
      if (!remaining.length) {
        const fresh = createTextThread();
        return { activeId: fresh.id, threads: [fresh] };
      }
      return { activeId: current.activeId === id ? remaining[0].id : current.activeId, threads: remaining };
    });
  }, [busy, status.job.threadId, workspace.threads]);

  const importModel = useCallback(async () => {
    if (modelActionRef.current) return;
    modelActionRef.current = true;
    setModelAction("Adding model…");
    setActionError(null);
    try {
      const path = await window.studio.pickTextModelFolder();
      if (!path) return;
      const result = await addTextModel(path);
      setStatus((current) => ({ ...current, models: result.models }));
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not add this model.");
    } finally {
      modelActionRef.current = false;
      setModelAction(null);
    }
  }, []);

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
  }, []);

  const installRecommendedModel = useCallback(async (id: string) => {
    if (modelActionRef.current) return;
    modelActionRef.current = true;
    setModelAction("Starting download…");
    setActionError(null);
    try {
      const result = await installTextModel(id);
      setStatus(result);
      setStatusError(null);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not install the recommended model.");
    } finally {
      modelActionRef.current = false;
      setModelAction(null);
    }
  }, []);

  const send = useCallback(async (input: string, retry = false) => {
    const text = input.trim();
    if ((!text && !retry) || !activeThread || busy || sending.current) return;
    setActionError(null);
    const modelId = activeThread.modelId ?? status.models.find((model) => model.id === status.defaultModelId && model.installed)?.id ?? status.models.find((model) => model.installed)?.id;
    if (!status.runtimeAvailable) {
      setActionError(status.runtimeError ?? "OpenVINO GenAI is not available in this Fern runtime.");
      return;
    }
    if (!modelId || !status.models.some((model) => model.id === modelId && model.installed)) {
      setActionError("Add a local OpenVINO text model before starting a conversation.");
      return;
    }
    const user: TextMessage = { id: `message-${crypto.randomUUID()}`, role: "user", content: text, createdAt: Date.now() };
    const lastUser = activeThread.messages.map((message) => message.role).lastIndexOf("user");
    const messages = retry ? activeThread.messages.slice(0, lastUser + 1) : [...activeThread.messages, user];
    if (!messages.length) return;
    const title = activeThread.messages.length === 0 && activeThread.title === "New text thread"
      ? text.replace(/\s+/g, " ").slice(0, 56)
      : activeThread.title;
    const requestId = crypto.randomUUID();
    sending.current = true;
    setSubmitting(true);
    ++pollVersion.current;
    updateThread(activeThread.id, { messages, title, draft: retry ? activeThread.draft : "", modelId, pendingJobId: requestId });
    try {
      const accepted = await startTextGeneration({
        requestId,
        threadId: activeThread.id,
        modelId,
        device: computeDevice === "CPU" ? "CPU" : "AUTO",
        messages: messages.map(({ role, content }) => ({ role, content })),
        systemPrompt: activeThread.systemPrompt,
        temperature: activeThread.temperature,
        topP: activeThread.topP,
        maxNewTokens: activeThread.maxNewTokens,
        seed: Math.floor(Math.random() * 2_147_483_647),
      });
      ++pollVersion.current;
      setStatus(accepted.job);
      setStatusError(null);
    } catch (error) {
      // A lost HTTP response does not mean the request was rejected.
      try {
        const latest = await fetchTextStatus();
        ++pollVersion.current;
        setStatus(latest);
        setStatusError(null);
        if (latest.job.id !== requestId) {
          updateThread(activeThread.id, { pendingJobId: null, messages: [...messages, {
            id: `response-${requestId}`, jobId: requestId, role: "assistant", content: "", createdAt: Date.now(), status: "failed",
            error: error instanceof Error ? error.message : "Could not start text generation.",
          }] });
        }
      } catch {
        setStatusError("Connection lost while checking the pending response.");
        setActionError("Connection lost. Fern will check the pending response when the backend reconnects.");
      }
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }, [activeThread, busy, computeDevice, refresh, status.models, status.runtimeAvailable, status.runtimeError, updateThread]);

  const retry = useCallback(() => send("", true), [send]);

  const stop = useCallback(async () => {
    try { await stopTextGeneration(); await refresh(); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Could not stop text generation."); }
  }, [refresh]);

  const selectModel = useCallback((modelId: string) => {
    if (activeThread) updateThread(activeThread.id, { modelId: modelId || null });
  }, [activeThread, updateThread]);

  const setDevice = useCallback((device: TextDevice) => {
    if (activeThread) updateThread(activeThread.id, { device });
  }, [activeThread, updateThread]);

  return {
    threads, activeThread, status, statusLoaded, modelAction, submitting, statusError, actionError, busy,
    newThread, selectThread, resetWorkspace, renameThread, archiveThread, deleteThread,
    updateThread, importModel, deleteModel, installRecommendedModel, send, retry, stop, refresh, selectModel, setDevice,
  };
}
