import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addTextModel,
  fetchTextStatus,
  inspectChatImage,
  installTextModel,
  recoverChatImage,
  removeTextModel,
  startTextGeneration,
  stopTextGeneration,
  uploadChatImage,
} from "../lib/api";
import { readReference } from "../lib/reference";
import {
  createTextThread,
  isChatImage,
  loadTextThreads,
  saveTextThreads,
  textRuntimeIssue,
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

export function useTextChat(ready: boolean, computeDevice: "GPU" | "CPU" = "GPU", imageGpuAvailable?: boolean) {
  const [workspace, setWorkspace] = useState(loadTextThreads);
  const workspaceRef = useRef(workspace);
  const persistPendingRef = useRef(false);
  workspaceRef.current = workspace;
  const [status, setStatus] = useState(idleStatus);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [modelAction, setModelAction] = useState<string | null>(null);
  const [attachingImage, setAttachingImage] = useState(false);
  const modelActionRef = useRef(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const sending = useRef(false);
  const pollVersion = useRef(0);
  const polling = useRef(false);
  const recovering = useRef(new Set<string>());
  const [submitting, setSubmitting] = useState(false);
  const activeThread = useMemo(
    () => workspace.threads.find((thread) => thread.id === workspace.activeId) ?? workspace.threads[0]!,
    [workspace],
  );
  const threads = workspace.threads;
  const busy = !!modelAction || attachingImage || submitting || status.job.status === "running" || ["downloading", "preparing"].includes(status.modelInstall?.status ?? "") || threads.some((thread) => !!thread.pendingJobId);

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
      status: job.status as "complete" | "failed" | "stopped", error: job.error, errorCode: job.errorCode,
      reasoning: job.partialReasoning || undefined,
      generatedImage: job.image ?? undefined,
      modelName: job.result?.modelName ?? status.models.find((model) => model.id === job.modelId)?.name ?? "Unavailable model",
      createdAt: job.finishedAt ? job.finishedAt * 1000 : Date.now(),
      metrics: job.result ?? undefined,
    };
    setWorkspace((current) => {
      if (!current.threads.some((thread) => thread.id === job.threadId && thread.pendingJobId === job.id)) return current;
      return { ...current,
      threads: current.threads.map((thread) => {
        if (thread.id !== job.threadId || thread.pendingJobId !== job.id) return thread;
        const inspectionTarget = thread.messages.find((message) => message.inspectionJobId === job.id);
        const messages = inspectionTarget
          ? thread.messages.map((message) => message === inspectionTarget ? {
            ...message, inspectionJobId: undefined,
            content: job.result?.visionChecked ? assistant.content : message.content,
            metrics: job.result?.visionChecked ? assistant.metrics : message.metrics,
            status: assistant.status, error: assistant.error, errorCode: assistant.errorCode,
          } : message)
          : thread.messages.some((message) => message.jobId === job.id) ? thread.messages : [...thread.messages, assistant];
        return { ...thread, pendingJobId: null, messages, updatedAt: Date.now() };
      }),
    }; });
  }, [status.job, status.models]);

  // The model process may be gone while its last render is already on disk.
  useEffect(() => {
    if (!ready || submitting || status === idleStatus || statusError) return;
    for (const { id, pendingJobId: jobId } of workspaceRef.current.threads) {
      if (!jobId || jobId === status.job.id || recovering.current.has(jobId)) continue;
      recovering.current.add(jobId);
      void recoverChatImage(id, jobId).then(({ image }) => {
        const response: TextMessage = {
          id: `response-${jobId}`, jobId, role: "assistant", content: "",
          createdAt: Date.now(), status: "failed", generatedImage: image ?? undefined,
          error: image ? "The image was saved before the backend restarted." : "The backend restarted before this response was saved. Retry the response.",
        };
        setWorkspace((current) => ({
          ...current,
          threads: current.threads.map((thread) => {
            if (thread.id !== id || thread.pendingJobId !== jobId) return thread;
            const inspectionTarget = thread.messages.find((message) => message.inspectionJobId === jobId);
            const messages = inspectionTarget
              ? thread.messages.map((message) => message === inspectionTarget ? {
                ...message, inspectionJobId: undefined, status: "failed" as const,
                error: "The backend restarted during the image check.",
              } : message)
              : [...thread.messages, response];
            return { ...thread, pendingJobId: null, messages };
          }),
        }));
      }).catch(() => {
        // Keep the request pending and try recovery on the next successful poll.
      }).finally(() => recovering.current.delete(jobId));
    }
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
    const untouched = workspaceRef.current.threads.find((thread) => !thread.archived && !thread.renamed &&
      !thread.messages.length && !thread.draft && !thread.draftImage && !thread.draftContextImage && !thread.pendingJobId && !thread.systemPrompt &&
      thread.title === "New text thread");
    if (untouched) {
      setWorkspace((current) => current.activeId === untouched.id ? current : { ...current, activeId: untouched.id });
      setActionError(null);
      return untouched.id;
    }
    const thread = createTextThread();
    setWorkspace((current) => ({ activeId: thread.id, threads: [thread, ...current.threads] }));
    setActionError(null);
    return thread.id;
  }, []);

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
    if (clean) updateThread(id, { title: clean, renamed: true });
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
  }, []);

  const attachImage = useCallback(async (file: File) => {
    if (!activeThread || busy) return;
    if (activeThread.draftContextImage) {
      setActionError("Remove the selected conversation image before attaching a new file.");
      return;
    }
    setActionError(null);
    setAttachingImage(true);
    try {
      const { image } = await uploadChatImage(await readReference(file));
      if (!isChatImage(image)) throw new Error("Fern could not save this chat image.");
      updateThread(activeThread.id, { draftImage: image });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not attach this image.");
    } finally {
      setAttachingImage(false);
    }
  }, [activeThread, busy, updateThread]);

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
    const model = status.models.find((item) => item.id === modelId && item.installed);
    if (!modelId || !model) {
      setActionError("Add a local text model before starting a conversation.");
      return;
    }
    const runtimeIssue = textRuntimeIssue(status, model);
    if (runtimeIssue) {
      setActionError(runtimeIssue);
      return;
    }
    const user: TextMessage = {
      id: `message-${crypto.randomUUID()}`, role: "user", content: text,
      image: activeThread.draftImage, includedImage: activeThread.draftContextImage, createdAt: Date.now(),
    };
    const lastUser = activeThread.messages.map((message) => message.role).lastIndexOf("user");
    const messages = retry ? activeThread.messages.slice(0, lastUser + 1) : [...activeThread.messages, user];
    if (!messages.length) return;
    if (!model.supportsVision && messages.some((message) => message.image || message.includedImage)) {
      setActionError("Choose a vision model for this conversation's images.");
      return;
    }
    const title = !activeThread.renamed && activeThread.messages.length === 0 && activeThread.title === "New text thread"
      ? text.replace(/\s+/g, " ").slice(0, 56)
      : activeThread.title;
    const requestId = crypto.randomUUID();
    const imageOptions = status.imageToolModels ?? [];
    const imageModel = model.supportsTools && model.supportsVision && computeDevice === "GPU" && imageGpuAvailable !== false
      ? (activeThread.imageModel === "auto" ? imageOptions[0] : imageOptions.find((item) => item.id === activeThread.imageModel))
      : undefined;
    sending.current = true;
    setSubmitting(true);
    ++pollVersion.current;
    updateThread(activeThread.id, {
      messages, title, modelId, pendingJobId: requestId,
      ...(retry ? {} : { draft: "", draftImage: undefined, draftContextImage: undefined }),
    });
    try {
      const accepted = await startTextGeneration({
        requestId,
        threadId: activeThread.id,
        modelId,
        device: computeDevice === "CPU" ? "CPU" : "AUTO",
        messages: messages.map(({ role, content, image, generatedImage, includedImage }) => ({
          role, content: content || (generatedImage ? "I generated an image." : ""), image, generatedImage: generatedImage?.name, includedImage,
        })),
        ...(model.supportsReasoning ? { mode: activeThread.mode } : {}),
        ...(imageModel ? { imageModel: imageModel.id } : {}),
        ...(model.format === "gguf" ? { contextSize: activeThread.contextSize } : {}),
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
  }, [activeThread, busy, computeDevice, imageGpuAvailable, status, updateThread]);

  const retry = useCallback(() => send("", true), [send]);

  const retryInspection = async (messageId: string) => {
    if (busy || sending.current) return;
    const thread = workspaceRef.current.threads.find((item) => item.id === workspaceRef.current.activeId);
    const message = thread?.messages.find((item) => item.id === messageId);
    const model = status.models.find((item) => item.id === thread?.modelId && item.installed);
    if (!thread || !message?.generatedImage || !model?.supportsVision || textRuntimeIssue(status, model)) return;

    const requestId = crypto.randomUUID();
    sending.current = true;
    setSubmitting(true);
    ++pollVersion.current;
    updateThread(thread.id, {
      pendingJobId: requestId,
      messages: thread.messages.map((item) => item.id === messageId ? { ...item, inspectionJobId: requestId } : item),
    });
    try {
      const accepted = await inspectChatImage({
        requestId, threadId: thread.id, modelId: model.id,
        image: message.generatedImage.name, device: computeDevice === "CPU" ? "CPU" : "AUTO",
      });
      setStatus(accepted.job);
      setStatusError(null);
    } catch (error) {
      try {
        const latest = await fetchTextStatus();
        setStatus(latest);
        setStatusError(null);
        if (latest.job.id !== requestId) updateThread(thread.id, {
          pendingJobId: null,
          messages: thread.messages.map((item) => item.id === messageId ? {
            ...item, inspectionJobId: undefined, status: "failed",
            error: error instanceof Error ? error.message : "Could not start the image check.",
          } : item),
        });
      } catch {
        setStatusError("Connection lost while checking the pending image inspection.");
      }
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  };

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
    threads, activeThread, status, statusLoaded, modelAction, submitting, attachingImage, statusError, actionError, busy, computeDevice,
    newThread, selectThread, resetWorkspace, renameThread, archiveThread, deleteThread,
    updateThread, importModel, deleteModel, installRecommendedModel, attachImage, send, retry, retryInspection, stop, refresh, selectModel, setDevice,
  };
}
