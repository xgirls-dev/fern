import { useRef } from "react";
import type { RuntimeStatus } from "../lib/types";
import { useModalFocus } from "../hooks/useModalFocus";
import { Button } from "./ui/controls";

interface RuntimeLoadingDialogProps {
  onDismiss: () => void;
  runtime: RuntimeStatus | null;
  onRetry: () => void;
  onOpenPreferences: () => void;
  connecting: boolean;
  connectionError?: string | null;
}

function formatDevice(device: string | null): string {
  switch (device) {
    case "INTEL_GPU":
      return "Intel GPU";
    case "NVIDIA_GPU":
      return "NVIDIA GPU";
    case "CPU":
      return "CPU";
    default:
      return "Available GPU";
  }
}

export function RuntimeLoadingDialog({
  onDismiss,
  runtime,
  onRetry,
  onOpenPreferences,
  connecting,
  connectionError,
}: RuntimeLoadingDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const failed = connecting ? !!connectionError : runtime?.status === "failed" || runtime?.status === "blocked";
  const message = connecting ? "Waiting for the local Fern service." : runtime?.message ?? "Checking the image runtime…";
  const device = runtime?.device ?? null;
  const logs = runtime?.logs ?? [];
  useModalFocus(true, dialogRef, onDismiss);

  return (
    <div className="dialog-backdrop runtime-loading-backdrop">
      <section
        ref={dialogRef}
        className="data-dialog runtime-loading-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="runtime-loading-title"
        tabIndex={-1}
      >
        <header className="data-dialog-header">
          <div>
            <h2 id="runtime-loading-title">
              {connecting ? failed ? "Connection interrupted" : "Connecting to Fern" : failed ? "Image generation unavailable" : "Preparing image generation"}
            </h2>
          </div>
          <Button variant="secondary" onClick={onDismiss}>
            Continue to workspace
          </Button>
        </header>

        <div
          className={`runtime-loading-content${failed ? " runtime-loading-content--failed" : ""}`}
          role={failed ? "alert" : "status"}
          aria-live="polite"
          aria-busy={!failed}
        >
          <span
            className={failed ? "runtime-failure-mark" : "spinner"}
            aria-hidden="true"
          >
            {failed ? "!" : null}
          </span>
          <strong>{message}</strong>
          {!connecting && device ? <span className="runtime-loading-device">{formatDevice(device)}</span> : null}
        </div>

        {logs.length > 0 || (connecting && connectionError) ? (
          <details className="runtime-loading-log">
            <summary>Technical details</summary>
            {connecting && connectionError ? <div>{connectionError}</div> : null}
            {logs.slice(-4).map((log, index) => (
              <div key={`${log}-${index}`}>{log}</div>
            ))}
          </details>
        ) : null}

        {failed ? (
          <div className="runtime-loading-actions">
            <div className="runtime-loading-buttons">
              <Button variant="primary" onClick={onRetry}>
                {connecting ? "Retry connection" : "Check again"}
              </Button>
              {!connecting ? <Button variant="secondary" onClick={onOpenPreferences}>
                Open Preferences
              </Button> : null}
            </div>
          </div>
        ) : (
          <footer className="data-dialog-footer">
            The first load can take a little while. Keep Fern open.
          </footer>
        )}
      </section>
    </div>
  );
}
