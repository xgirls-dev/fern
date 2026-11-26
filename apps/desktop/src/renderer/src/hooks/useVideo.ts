import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVideoStatus, mutateVideo, type VideoSnapshot } from "../lib/api";
import type { ReferenceAttachment } from "../lib/reference";

export function useVideo(ready: boolean, visible: boolean) {
  const [snapshot, setSnapshot] = useState<VideoSnapshot>();
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState("42");
  const [selectedFrames, setFrames] = useState<number>();
  const [reference, setReference] = useState<ReferenceAttachment>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [pending, setPending] = useState(false);
  const operation = useRef(false);
  const revision = useRef(0);
  const job = snapshot?.job;
  const format = snapshot?.model.videoFormat;
  const frames = selectedFrames !== undefined && format?.frameOptions.includes(selectedFrames)
    ? selectedFrames : format?.defaultFrames;
  const running = job?.status === "running" || job?.status === "stopping";

  useEffect(() => {
    if (!ready || (!visible && !running)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = revision.current;
      try {
        const data = await fetchVideoStatus(running);
        if (!active || current !== revision.current || operation.current) return;
        setSnapshot((current) => ({ ...data, clips: data.clips ?? current?.clips ?? [] }));
        setConnectionError("");
      } catch {
        if (active) setConnectionError("Video status is unavailable. Reconnecting…");
      } finally {
        if (active) timer = setTimeout(poll, running ? 900 : 4000);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [ready, visible, running]);

  const update = useCallback(async (action: "generate" | "stop" | "remove", payload?: object) => {
    if (operation.current) return;
    operation.current = true;
    revision.current += 1;
    setPending(true);
    setError("");
    try {
      const data = await mutateVideo(action, payload);
      setSnapshot((old) => old ? { ...old, ...data } : old);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The video operation failed.");
    } finally {
      operation.current = false;
      setPending(false);
    }
  }, []);

  const generate = () => {
    if (!reference || !prompt.trim()) return;
    const value = Number(seed);
    if (!seed.trim() || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
      setError("Use a whole-number seed from 0 to 2,147,483,647.");
      return;
    }
    void update("generate", { prompt, seed: value, referenceImage: reference.dataUrl, device: "AUTO", frames });
  };

  const reset = useCallback(() => {
    revision.current += 1;
    setSnapshot(undefined);
    setReference(undefined);
    setPrompt("");
    setSeed("42");
    setFrames(undefined);
    setError("");
  }, []);

  return {
    clips: snapshot?.clips, model: snapshot?.model, job, running, pending, error,
    connectionError, setError, prompt, setPrompt, seed, setSeed, frames, setFrames, reference, setReference, generate, update, reset,
  };
}
