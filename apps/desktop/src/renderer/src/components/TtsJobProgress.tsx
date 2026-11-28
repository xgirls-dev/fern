import { useEffect, useState } from "react";
import { Button } from "./ui/controls";

interface Props {
  label: string;
  phase?: string | null;
  startedAt?: number | null;
  stopping: boolean;
  onStop: () => void;
}

export function TtsJobProgress({ label, phase, startedAt, stopping, onStop }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const elapsed = startedAt ? Math.max(0, Math.floor(now / 1000 - startedAt)) : null;
  return <div className="tts-header-actions tts-job-progress">
    <div className="tts-job-status" role="status">
      <span>{label}</span>
      {phase && !stopping ? <span className="tts-job-phase" title={phase}>{phase}</span> : null}
    </div>
    {elapsed !== null ? <span className="generation-elapsed">{elapsed}s elapsed</span> : null}
    <Button variant="secondary" disabled={stopping} onClick={onStop}>{stopping ? "Stopping…" : "Stop audio"}</Button>
  </div>;
}
