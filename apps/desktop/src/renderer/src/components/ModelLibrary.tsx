import { useEffect, useState } from "react";
import type { ModelStatus } from "../lib/types";
import { getApiBaseUrl } from "../lib/api";
interface InstalledModel {
  id: string;
  label: string;
  bytes: number;
  downloaded: number;
  installed: boolean;
  state: string;
  phase?: string;
  logs?: string[];
  runtimeReady?: boolean;
  error?: string;
}
export function ModelLibrary({ status }: { status: ModelStatus | null }) {
  const [models, setModels] = useState<InstalledModel[]>([]);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      let setupActive = false;
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/models`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("Could not load models. Retrying…");
        const data = await response.json();
        if (!Array.isArray(data.models)) throw new Error("Model status response is invalid.");
        failures = 0;
        setupActive = data.models.some((model: InstalledModel) => ["installing", "checking-runtime"].includes(model.state));
        if (alive) {
          setModels(data.models);
          setError("");
        }
      } catch (error) {
        failures += 1;
        if (alive)
          setError("Model status is unavailable. Reconnecting…");
      } finally {
        if (alive) {
          const delay = failures
            ? Math.min(30_000, 3_000 * 2 ** Math.min(failures - 1, 3))
            : setupActive ? 1_500 : 8_000;
          timer = setTimeout(poll, delay);
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const action = async (id: string, operation: string) => {
    setBusy(true);
    setActionError("");
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/api/models/${operation}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(120_000),
          body: JSON.stringify({ model: id }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Model operation failed. Try again.");
      if (!Array.isArray(data.models)) throw new Error("The model service returned an invalid status response.");
      setModels(data.models);
      setError("");
      setRemove(null);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Model operation failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  const downloading = models.some((model) =>
    ["downloading", "verifying", "removing", "installing"].includes(model.state),
  );
  const actionsUnavailable = busy || Boolean(error);
  return (
    <section className="preferences-section" aria-labelledby="models-title">
      <div className="preferences-section-heading">
        <div>
          <h3 id="models-title">Image models</h3>
          <p>
            Install the image models you need. They load when you generate.
          </p>
        </div>
      </div>
      {!models.length && !error ? (
        <p role="status">Checking installed models…</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      <div className="model-library-grid">
        {models.map((model) => (
          <article
            className={`model-library-card${model.id === "qwen21-turbo" ? " model-library-card-qwen" : ""}`}
            key={model.id}
            aria-busy={["installing", "checking-runtime"].includes(model.state) || undefined}
          >
            <h4>{model.label}</h4>
            <p>
              {model.id === "qwen21-turbo"
              ? `Official 8-step checkpoint · OpenVINO INT8 · ${model.bytes > 0 ? `about ${(model.bytes / 1e9).toFixed(1)} GB download · ` : ""}compiled GPU caches add disk use after first launch`
                : `${model.bytes > 0 ? `${(model.bytes / 1e9).toFixed(2)} GB · ` : ""}${model.id === "4b" ? "Smaller download and lower memory use" : "Larger model"}`}
            </p>
            {model.id === "qwen21-turbo" ? (
              <>
                <p className="model-library-note">
                  Qwen Research License · non-commercial research/evaluation only.
                </p>
                <p className="model-library-note">
                  Setup needs additional disk space. Auto-select prefers Intel GPU; CPU is an explicit fallback. One image per request.
                </p>
              </>
            ) : null}
            <p className="model-library-status" role="status" aria-live="polite">
              {model.state === "not-installed"
                ? "Not installed"
                : model.state === "installed"
                  ? "Installed · OpenVINO runtime ready"
                  : model.state === "installing"
                    ? model.phase?.replace("FERN_QWEN_PROGRESS:", "") || "Setting up official Qwen Turbo…"
                    : model.state === "checking-runtime"
                      ? "Checking OpenVINO runtime and available devices…"
                    : model.state === "repair-needed"
                      ? "Incomplete model files. Remove them, then install again."
                      : model.state === "runtime-unavailable"
                        ? "Model files are present, but this Fern runtime cannot load OpenVINO Qwen."
                    : model.state}
            </p>
            {model.id === "qwen21-turbo" && model.state === "installing" ? (
              model.downloaded > 0 && model.downloaded < model.bytes ? (
                <>
                  <progress
                    aria-label="Qwen Turbo model download"
                    value={model.downloaded}
                    max={model.bytes}
                  />
                  <p>
                    {(model.downloaded / 1e9).toFixed(2)} / {(model.bytes / 1e9).toFixed(2)} GB
                  </p>
                </>
              ) : (
                <progress className="model-library-indeterminate" aria-label="Qwen Turbo setup is in progress" />
              )
            ) : null}
            {model.id === "qwen21-turbo" && model.installed ? (
              <p className="model-library-note">
                The current OpenVINO graph runs without the checkpoint’s KV cache. Fern keeps it warm for about 5 minutes after generation.
              </p>
            ) : null}
            {["downloading", "verifying", "paused"].includes(model.state) ? (
              <>
                <progress
                  aria-label={`${model.label} download`}
                  value={model.downloaded}
                  max={model.bytes}
                />
                <p>
                  {(model.downloaded / 1e9).toFixed(2)} /{" "}
                  {(model.bytes / 1e9).toFixed(2)} GB
                </p>
              </>
            ) : null}
            {model.error ? <p role="alert">{model.error}</p> : null}
            {model.id === "qwen21-turbo" && model.logs?.length ? (
              <details>
                <summary>Setup details</summary>
                <ul>{model.logs.slice(-8).map((line, index) => <li key={`${index}-${line}`}>{line.replace("FERN_QWEN_PROGRESS:", "")}</li>)}</ul>
              </details>
            ) : null}
            <div className="model-library-actions">
              {model.state === "installing" && model.id === "qwen21-turbo" ? (
                <button
                  className="btn btn-secondary"
                  disabled={actionsUnavailable}
                  onClick={() => void action(model.id, "pause")}
                >
                  Cancel setup
                </button>
              ) : ["downloading", "verifying"].includes(model.state) ? (
                <button
                  className="btn btn-secondary"
                  disabled={actionsUnavailable}
                  onClick={() => void action(model.id, "pause")}
                >
                  Pause
                </button>
              ) : !model.installed && model.state !== "repair-needed" ? (
                <button
                  className="btn btn-secondary"
                  disabled={actionsUnavailable || downloading}
                  onClick={() => void action(model.id, "install")}
                >
                  {model.id === "qwen21-turbo"
                    ? model.state === "paused" ? "Resume setup" : model.state === "failed" ? "Retry setup" : model.state === "runtime-unavailable" ? "Repair runtime" : "Install"
                    : ["paused", "failed"].includes(model.state) ? "Resume download" : "Install"}
                </button>
              ) : null}
              {model.installed ||
              ["failed", "paused", "repair-needed", "runtime-unavailable"].includes(model.state) ? (
                remove === model.id ? (
                  <>
                    <span>
                      Remove model files? Your images and threads stay.
                    </span>
                    <button
                      className="btn btn-secondary"
                      disabled={actionsUnavailable || downloading}
                      onClick={() => void action(model.id, "remove")}
                    >
                      Confirm removal
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={busy || Boolean(error)}
                      onClick={() => setRemove(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-secondary"
                    disabled={actionsUnavailable || downloading}
                    onClick={() => setRemove(model.id)}
                  >
                    Remove
                  </button>
                )
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <p>
        {status?.checking ? "Checking runtime. " : ""}
        Auto-select chooses a supported device for the selected model.
      </p>
    </section>
  );
}
