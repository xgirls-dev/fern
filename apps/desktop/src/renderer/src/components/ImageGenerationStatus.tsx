import { Button } from "./ui/controls";

interface Props {
  logs: string[];
  phase?: string;
  elapsed: number | null;
  stopping: boolean;
  onStop: () => void;
}

function renderProgress(logs: string[]) {
  let image = 1,
    count = 1,
    current = 0,
    total = 0;
  for (const line of logs) {
    const batch = line.match(/Batch image (\d+)\/(\d+)/i);
    if (batch) {
      image = Number(batch[1]);
      count = Number(batch[2]);
      current = 0;
      total = 0;
    }
    const step = line.match(/\bStep\s+(\d+)\s*\/\s*(\d+)/i);
    if (step) {
      current = Number(step[1]);
      total = Number(step[2]);
    }
  }
  return {
    label: `Image ${image} of ${count} — ${total ? `step ${current} of ${total}` : "preparing…"}`,
    percent: total || image > 1 ? Math.min(
      99,
      Math.round(((image - 1 + (total ? current / total : 0)) / count) * 100),
    ) : null,
  };
}
export function ImageGenerationStatus({ logs, phase, elapsed, stopping, onStop }: Props) {
  const progress = renderProgress(logs);
  return <div className="generation-progress-strip">
    <div className="generation-progress-header">
      <span className="generation-phase" role="status">
        {stopping ? "Stopping generation…" : progress.percent === null ? phase ?? "Preparing image…" : progress.label}
      </span>
      {elapsed != null && <span className="generation-elapsed" role="timer">{elapsed}s elapsed</span>}
      <Button className="generation-stop" variant="secondary" disabled={stopping} aria-label="Stop generation" onClick={onStop}>
        {stopping ? "Stopping…" : "Stop"}
      </Button>
    </div>
    {progress.percent !== null && !stopping && <div
      className="render-progress-track"
      role="progressbar"
      aria-label={progress.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress.percent}
    >
      <span style={{ width: `${progress.percent}%` }} />
    </div>}
  </div>;
}
