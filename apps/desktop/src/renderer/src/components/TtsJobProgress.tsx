import { useEffect, useState } from "react";

interface Props {
  status: { status: string; operation: string | null; startedAt?: number | null; finishedAt?: number | null; logs: string[]; diagnostics?: string[]; phase?: string | null; error: string | null };
  onStop: () => void;
}

export function TtsJobProgress({ status, onStop }: Props) {
  const [now, setNow] = useState(Date.now());
  const running = ["running", "setting_up", "stopping"].includes(status.status);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, status.startedAt]);
  const elapsed = status.startedAt ? Math.max(0, Math.floor(((status.finishedAt ? status.finishedAt * 1000 : now) - status.startedAt * 1000) / 1000)) : 0;
  const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const title = status.status === "stopping" ? "Stopping audio…" : status.status === "complete" ? status.operation === "setup" ? "Model ready" : "Take complete" : status.status === "failed" ? "Audio job failed" : status.status === "stopped" ? "Audio job stopped" : status.operation === "setup" ? "Setting up voice model" : "Creating your take";
  return <section className="tts-job-progress" aria-label="Audio job progress">
    <header><strong role="status">{title}</strong><span aria-label="Elapsed time">{duration} elapsed</span>{running ? <button type="button" className="btn btn-secondary" disabled={status.status === "stopping"} onClick={onStop}>Stop</button> : null}</header>
    <p role="status">{status.phase || "Preparing speech locally…"}</p>
    {running ? <small>{status.operation === "setup" ? "Setup downloads this model once. No conversion is needed." : "The first run compiles the model and tokenizer. Later takes reuse the loaded model."}</small> : null}
    {status.logs.length ? <details><summary>Activity timeline</summary><pre>{status.logs.join("\n")}</pre></details> : null}
    {status.diagnostics?.length ? <details className="tts-job-diagnostics"><summary>Technical diagnostics ({status.diagnostics.length})</summary><pre>{status.diagnostics.join("\n")}</pre></details> : null}
  </section>;
}
