import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchVideoStatus, mutateVideo, type VideoSnapshot } from "../lib/api";
import type { ReferenceAttachment } from "../lib/reference";

export function useVideo(ready: boolean, visible: boolean) {
  const [snapshot, setSnapshot] = useState<VideoSnapshot>();
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState("42");
  const [reference, setReference] = useState<ReferenceAttachment>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [pending, setPending] = useState(false);
  const [statusConfirmed, setStatusConfirmed] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const operation = useRef<number | null>(null);
  const revision = useRef(0);
  const needsHistory = useRef(false);
  const job = snapshot?.job;
  const jobId = job?.id;
  const running = job?.status === "running" || job?.status === "stopping";
  const available = ready && statusConfirmed;

  useLayoutEffect(() => {
    if (ready) return;
    revision.current += 1;
    operation.current = null;
    needsHistory.current = true;
    setPending(false);
    setStatusConfirmed(false);
    setConnectionError("");
    setError("");
  }, [ready]);

  useEffect(() => {
    if (!ready || (!visible && !running)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = revision.current;
      try {
        const data = await fetchVideoStatus(running && !needsHistory.current);
        if (!active || current !== revision.current || operation.current !== null) return;
        if (needsHistory.current) {
          // A clip may have reached disk before the service could report completion.
          setInterrupted(Boolean(running && jobId && data.job.id !== jobId && !data.clips?.some((clip) => clip.id === jobId)));
          needsHistory.current = false;
        }
        setSnapshot((current) => ({ ...data, clips: data.clips ?? current?.clips ?? [] }));
        setStatusConfirmed(true);
        setConnectionError("");
      } catch {
        if (active && current === revision.current) setConnectionError("Video status is unavailable. Reconnecting…");
      } finally {
        if (active) timer = setTimeout(poll, running ? 900 : 4000);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [ready, visible, running, jobId]);

  const update = useCallback(async (action: "generate" | "stop" | "remove", payload?: object) => {
    if (!available || operation.current !== null) return;
    const request = ++revision.current;
    operation.current = request;
    setPending(true);
    setError("");
    if (action === "generate") setInterrupted(false);
    try {
      const data = await mutateVideo(action, payload);
      if (operation.current === request) setSnapshot((old) => old ? { ...old, ...data } : old);
    } catch (cause) {
      if (operation.current === request) setError(cause instanceof Error ? cause.message : "The video operation failed.");
    } finally {
      if (operation.current === request) {
        operation.current = null;
        setPending(false);
      }
    }
  }, [available]);

  const generate = () => {
    if (!reference || !prompt.trim()) return;
    const value = Number(seed);
    if (!seed.trim() || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
      setError("Use a whole-number seed from 0 to 2,147,483,647.");
      return;
    }
    void update("generate", { prompt, seed: value, referenceImage: reference.dataUrl, device: "AUTO" });
  };

  const reset = useCallback(() => {
    revision.current += 1;
    operation.current = null;
    setPending(false);
    setStatusConfirmed(false);
    setInterrupted(false);
    setSnapshot(undefined);
    setReference(undefined);
    setPrompt("");
    setSeed("42");
    setError("");
  }, []);

  return {
    clips: snapshot?.clips, model: snapshot?.model, job, running, available, recovering: ready && !available && !!snapshot,
    pending, interrupted, error,
    connectionError, setError, prompt, setPrompt, seed, setSeed, reference, setReference, generate, update, reset,
  };
}
