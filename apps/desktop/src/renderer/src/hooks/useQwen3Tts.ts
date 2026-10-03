import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl, resolveAssetUrl } from "../lib/api";
import { createAudioThread, loadAudioThreads, saveAudioThreads, type AudioOutput, type AudioThread, type AudioThreadWorkspace, type QwenTtsModel } from "../lib/ttsThreads";

export interface TtsModelStatus { id: QwenTtsModel; label: string; kind: "custom_voice" | "base" | "voice_design"; installed: boolean }
interface TtsStatus { startedAt?: number | null; finishedAt?: number | null; diagnostics?: string[]; phase?: string | null }
interface TtsStatus { id: string | null; threadId: string | null; model: QwenTtsModel | null; status: "idle" | "setting_up" | "running" | "stopping" | "stopped" | "complete" | "failed"; operation: "setup" | "generate" | null; logs: string[]; output: Omit<AudioOutput, "prompt" | "createdAt"> | null; error: string | null; models: TtsModelStatus[]; environmentReady: boolean }

function validateStatus(value: TtsStatus): TtsStatus {
  if (!value || !Array.isArray(value.models) || !Array.isArray(value.logs) || typeof value.status !== "string")
    throw new Error("The audio service returned an invalid status. Restart Fern and try again.");
  return value;
}

const blankStatus: TtsStatus = { id: null, threadId: null, model: null, status: "idle", operation: null, logs: [], output: null, error: null, models: [], environmentReady: false };
const PENDING_JOB_KEY = "fern-qwen3-tts-pending:v1";
interface PendingAudioJob {
  id: string; threadId: string; text: string; model: QwenTtsModel; language: string;
  speaker: string; instruction: string; designInstruction: string; referenceText: string;
  referenceFileName?: string; device: "AUTO" | "CPU" | "GPU";
}
function loadPendingJob(): PendingAudioJob | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_JOB_KEY) ?? "null") as PendingAudioJob | null;
    return value && typeof value.id === "string" && typeof value.threadId === "string" && typeof value.text === "string" ? value : null;
  } catch { return null; }
}

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`${resolveAssetUrl("/api/tts/status").replace("/api/tts/status", path)}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({ error: "The TTS service returned an unreadable response." }));
  if (!response.ok) throw new Error(data.error || "Qwen3-TTS request failed.");
  return data as T;
}

export function useQwen3Tts(apiReady: boolean) {
  const [workspace, setWorkspace] = useState<AudioThreadWorkspace>(loadAudioThreads);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceDirty = useRef(false);
  const pendingJob = useRef<PendingAudioJob | null>(loadPendingJob());
  const [status, setStatus] = useState<TtsStatus>(blankStatus);
  const [busy, setBusy] = useState(false);
  const requestActive = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [referenceFiles, setReferenceFiles] = useState<Record<string, File>>({});
  const activeThread = workspace.threads.find((thread) => thread.id === workspace.activeId) ?? workspace.threads[0];

  const commit = useCallback((update: (current: AudioThreadWorkspace) => AudioThreadWorkspace) => {
    const next = update(workspaceRef.current);
    workspaceRef.current = next;
    setWorkspace(next);
    workspaceDirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      try { saveAudioThreads(workspaceRef.current); workspaceDirty.current = false; }
      catch { setError("Could not save audio threads. Free local storage before closing Fern."); }
    }, 250);
  }, []);

  const reconcileJob = useCallback((next: TtsStatus) => {
    const pending = pendingJob.current;
    if (!pending) return;
    if (next.id === pending.id && next.status === "complete" && next.output) {
      const output: AudioOutput = {
        ...next.output, prompt: pending.text, createdAt: Date.now(), model: pending.model,
        language: pending.language, speaker: pending.speaker, instruction: pending.instruction,
        designInstruction: pending.designInstruction, referenceText: pending.referenceText,
        referenceFileName: pending.referenceFileName, device: pending.device,
      };
      commit((current) => ({ ...current, threads: current.threads.map((thread) => thread.id === pending.threadId && !thread.outputs.some((item) => item.name === output.name) ? {
        ...thread,
        title: thread.title === "New audio thread" ? pending.text.trim().slice(0, 60) : thread.title,
        outputs: [output, ...thread.outputs],
        updatedAt: Date.now(),
      } : thread) }));
    }
    if ((next.id === pending.id && (next.status === "complete" || next.status === "failed" || next.status === "stopped")) || next.status === "idle") {
      pendingJob.current = null;
      try { localStorage.removeItem(PENDING_JOB_KEY); } catch { /* Thread data remains available in memory. */ }
    }
  }, [commit]);

  useEffect(() => {
    const flush = () => {
      if (!workspaceDirty.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      try { saveAudioThreads(workspaceRef.current); workspaceDirty.current = false; }
      catch { setError("Could not save audio threads. Free local storage before closing Fern."); }
    };
    window.addEventListener("pagehide", flush);
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!getApiBaseUrl()) return false;
    try {
      const next = validateStatus(await request<TtsStatus>("/api/tts/status"));
      setStatus(next);
      setStatusLoaded(true);
      setStatusError(null);
      reconcileJob(next);
      return true;
    } catch (caught) {
      setStatusError(caught instanceof Error ? caught.message : "Could not reach the audio service.");
      return false;
    }
  }, [reconcileJob]);

  useEffect(() => {
    if (!apiReady) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 90_000;
    const connect = async () => {
      const connected = await refresh();
      if (!disposed && !connected && Date.now() < deadline)
        timer = setTimeout(() => void connect(), 1000);
    };
    void connect();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [apiReady, refresh]);

  const jobRunning = status.status === "running" || status.status === "setting_up" || status.status === "stopping";
  useEffect(() => {
    if (!jobRunning || busy) return; // waitForJob already polls jobs started in this window.
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [busy, jobRunning, refresh]);

  const updateThread = useCallback((id: string, patch: Partial<AudioThread>) => {
    commit((current) => ({ ...current, threads: current.threads.map((thread) => thread.id === id ? { ...thread, ...patch, updatedAt: Date.now() } : thread) }));
  }, [commit]);

  const updateOutput = useCallback((threadId: string, name: string, patch: Partial<AudioOutput>) => {
    commit((current) => ({ ...current, threads: current.threads.map((thread) => thread.id === threadId
      ? { ...thread, outputs: thread.outputs.map((output) => output.name === name ? { ...output, ...patch } : output), updatedAt: Date.now() }
      : thread) }));
  }, [commit]);

  const deleteOutput = useCallback(async (threadId: string, name: string) => {
    if (!workspaceRef.current.threads.some((thread) => thread.id === threadId && thread.outputs.some((output) => output.name === name)))
      throw new Error("This take is no longer in the thread.");
    await window.studio.deleteOutputAudio(name);
    commit((current) => ({ ...current, threads: current.threads.map((thread) => thread.id === threadId
      ? { ...thread, outputs: thread.outputs.filter((output) => output.name !== name), updatedAt: Date.now() }
      : thread) }));
  }, [commit]);

  const newThread = useCallback(() => {
    const thread = createAudioThread();
    commit((current) => ({ activeId: thread.id, threads: [thread, ...current.threads] }));
  }, [commit]);

  const selectThread = useCallback((id: string) => commit((current) => current.threads.some((thread) => thread.id === id) ? { ...current, activeId: id } : current), [commit]);
  const renameThread = useCallback((id: string, title: string) => updateThread(id, { title: title.trim().slice(0, 80) || "New audio thread" }), [updateThread]);
  const archiveThread = useCallback((id: string) => commit((current) => {
    const thread = current.threads.find((item) => item.id === id);
    if (!thread) return current;
    const archived = !thread.archived;
    const nextThreads = current.threads.map((item) => item.id === id ? { ...item, archived, updatedAt: Date.now() } : item);
    const nextActive = current.activeId === id && archived ? nextThreads.find((item) => !item.archived)?.id ?? id : current.activeId;
    return { activeId: nextActive, threads: nextThreads };
  }), [commit]);
  const deleteThread = useCallback(async (id: string) => {
    const thread = workspaceRef.current.threads.find((item) => item.id === id);
    if (!thread) return;
    if (jobRunning && status.threadId === id) throw new Error("Stop the audio job before deleting this thread.");
    if (typeof window.studio === "undefined") throw new Error("Audio deletion is available in the desktop app.");
    for (const output of thread.outputs) {
      await window.studio.deleteOutputAudio(output.name);
      commit((current) => ({ ...current, threads: current.threads.map((item) => item.id === id
        ? { ...item, outputs: item.outputs.filter((take) => take.name !== output.name), updatedAt: Date.now() }
        : item) }));
    }
    setReferenceFiles((current) => { const next = { ...current }; delete next[id]; return next; });
    commit((current) => {
      let threads = current.threads.filter((thread) => thread.id !== id);
      if (!threads.length) threads = [createAudioThread()];
      return { activeId: current.activeId === id ? threads[0].id : current.activeId, threads };
    });
  }, [commit, jobRunning, status.threadId]);

  const resetWorkspace = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    workspaceDirty.current = false;
    pendingJob.current = null;
    try { localStorage.removeItem(PENDING_JOB_KEY); } catch { /* The active workspace is still reset. */ }
    setReferenceFiles({});
    setError(null);
    const thread = createAudioThread();
    const next = { activeId: thread.id, threads: [thread] };
    workspaceRef.current = next;
    setWorkspace(next);
    saveAudioThreads(next);
  }, []);

  const setReferenceFile = useCallback((id: string, file: File | null) => {
    setReferenceFiles((current) => {
      const next = { ...current };
      if (file) next[id] = file;
      else delete next[id];
      return next;
    });
  }, []);

  const waitForJob = useCallback(async (jobId: string) => {
    let failures = 0;
    for (;;) {
      let next: TtsStatus;
      try {
        next = validateStatus(await request<TtsStatus>("/api/tts/status"));
        failures = 0;
        setStatusLoaded(true);
        setStatusError(null);
      } catch (caught) {
        setStatusError("Reconnecting to the audio service…");
        if (++failures >= 3) throw caught;
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        continue;
      }
      setStatus(next);
      reconcileJob(next);
      if (next.id !== jobId) throw new Error("The audio job was interrupted. Check the service and try again.");
      if (next.status === "complete") return next;
      if (next.status === "stopped") return next;
      if (next.status === "failed") throw new Error(next.error || "Qwen3-TTS failed.");
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }
  }, [reconcileJob]);

  const setupModel = useCallback(async (model: QwenTtsModel) => {
    if (requestActive.current) return;
    requestActive.current = true;
    setBusy(true); setError(null);
    try {
      const threadId = activeThread.id;
      const started = await request<{ job: TtsStatus }>("/api/tts/setup", { model, threadId });
      setStatus(started.job);
      await waitForJob(started.job.id!);
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { requestActive.current = false; setBusy(false); }
  }, [activeThread.id, refresh, waitForJob]);

  const generate = useCallback(async () => {
    if (requestActive.current) return;
    const thread = activeThread;
    if (!thread.text.trim()) { setError("Enter the text you want Qwen3-TTS to speak."); return; }
    if (thread.model === "voice-design-1.7b" && !thread.designInstruction.trim()) { setError("Describe the voice you want Qwen3-TTS to create."); return; }
    const file = thread.model.startsWith("base-") ? referenceFiles[thread.id] : undefined;
    if (thread.model.startsWith("base-") && !file) { setError("Choose a reference voice clip for voice cloning."); return; }
    if (file && file.size > 12_000_000) { setError("Reference audio must be smaller than 12 MB."); return; }
    requestActive.current = true;
    setBusy(true); setError(null);
    try {
      let referenceAudio: string | undefined;
      if (file) referenceAudio = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read the reference audio."));
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
        reader.readAsDataURL(file);
      });
      const threadId = thread.id;
      const started = await request<{ job: TtsStatus }>("/api/tts/generate", { model: thread.model, threadId, text: thread.text, language: thread.language, speaker: thread.speaker, instruction: thread.model === "voice-design-1.7b" ? thread.designInstruction : thread.instruction, referenceText: thread.referenceText, referenceAudio, device: thread.device });
      const pending: PendingAudioJob = {
        id: started.job.id!, threadId, text: thread.text, model: thread.model, language: thread.language,
        speaker: thread.speaker, instruction: thread.instruction, designInstruction: thread.designInstruction,
        referenceText: thread.referenceText, referenceFileName: file?.name, device: thread.device,
      };
      pendingJob.current = pending;
      try { localStorage.setItem(PENDING_JOB_KEY, JSON.stringify(pending)); } catch { /* The live job still completes in this window. */ }
      setStatus(started.job);
      await waitForJob(started.job.id!);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { requestActive.current = false; setBusy(false); await refresh(); }
  }, [activeThread, referenceFiles, refresh, waitForJob]);

  const stopJob = useCallback(async () => {
    if (!jobRunning || status.status === "stopping") return;
    try {
      const stopped = await request<{ job: TtsStatus }>("/api/tts/stop", {});
      setStatus(stopped.job);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not stop the audio job."); }
  }, [jobRunning, status.status]);

  return { workspace, threads: workspace.threads, activeThread, status, statusLoaded, statusError, retryStatus: refresh, busy, error, clearError: () => setError(null), referenceFiles, setReferenceFile, updateThread, updateOutput, deleteOutput, newThread, selectThread, renameThread, archiveThread, deleteThread, resetWorkspace, setupModel, generate, stopJob };
}
