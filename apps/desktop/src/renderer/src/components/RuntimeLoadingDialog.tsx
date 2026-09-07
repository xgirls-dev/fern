import { useRef } from "react";
import type { RuntimeStatus } from "../lib/types";
import { useModalFocus } from "../hooks/useModalFocus";

interface RuntimeLoadingDialogProps {
  onDismiss: () => void;
  runtime: RuntimeStatus | null;
  cpuAvailable: boolean;
  onRetry: () => void;
  onUseCpu: () => void;
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
      return "Auto-selected device";
  }
}

export function RuntimeLoadingDialog({
  onDismiss,
  runtime,
  cpuAvailable,
  onRetry,
  onUseCpu,
}: RuntimeLoadingDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const failed = runtime?.status === "failed" || runtime?.status === "blocked";
  const message = runtime?.message ?? "Preparing the Fern runtime…";
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
            <p className="eyebrow">Runtime Startup</p>
            <h2 id="runtime-loading-title">
              {failed ? "Generation unavailable" : "Preparing generation"}
            </h2>
            <p>
              Fern loads the model into the selected device memory before
              generation.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onDismiss}
          >
            Continue to workspace
          </button>
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
          <span className="runtime-loading-device">{formatDevice(device)}</span>
        </div>

        {logs.length > 0 ? (
          <div
            className="runtime-loading-log"
            aria-label="Runtime loading activity"
          >
            {logs.slice(-4).map((log, index) => (
              <div key={`${log}-${index}`}>{log}</div>
            ))}
          </div>
        ) : null}

        {failed ? (
          <div className="runtime-loading-actions">
            <p>
              Fern could not start the selected device. Retry the same adapter
              or use CPU as a fallback.
            </p>
            <div className="runtime-loading-buttons">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onRetry}
              >
                Retry startup
              </button>
              {cpuAvailable ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onUseCpu}
                >
                  Use CPU instead
                </button>
              ) : null}
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
