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
    const poll = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/models`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("Could not load models. Retrying…");
        const data = await response.json();
        if (alive) {
          setModels(data.models);
          setError("");
        }
      } catch (error) {
        if (alive)
          setError(
            error instanceof Error ? error.message : "Could not load models.",
          );
      } finally {
        if (alive) timer = setTimeout(poll, 1500);
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
      if (!response.ok) throw new Error(data.error);
      setModels(data.models);
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
    ["downloading", "verifying", "removing"].includes(model.state),
  );
  return (
    <section className="preferences-section" aria-labelledby="models-title">
      <div className="preferences-section-heading">
        <div>
          <h3 id="models-title">Models</h3>
          <p>
            Install either model or keep both. Models load only when you
            generate.
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
          <article className="model-library-card" key={model.id}>
            <h4>{model.label}</h4>
            <p>
              {(model.bytes / 1e9).toFixed(2)} GB ·{" "}
              {model.id === "4b"
                ? "Smaller download and lower memory use"
                : "Larger model"}
            </p>
            <p role="status">
              {model.state === "not-installed"
                ? "Not installed"
                : model.state === "installed"
                  ? "Installed"
                  : model.state}
            </p>
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
            <div className="model-library-actions">
              {["downloading", "verifying"].includes(model.state) ? (
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void action(model.id, "pause")}
                >
                  Pause
                </button>
              ) : !model.installed && model.state !== "repair-needed" ? (
                <button
                  className="btn btn-secondary"
                  disabled={busy || downloading}
                  onClick={() => void action(model.id, "install")}
                >
                  {["paused", "failed"].includes(model.state)
                    ? "Resume download"
                    : "Install"}
                </button>
              ) : null}
              {model.installed ||
              ["failed", "paused", "repair-needed"].includes(model.state) ? (
                remove === model.id ? (
                  <>
                    <span>
                      Remove model files? Your images and threads stay.
                    </span>
                    <button
                      className="btn btn-secondary"
                      disabled={busy || downloading}
                      onClick={() => void action(model.id, "remove")}
                    >
                      Confirm removal
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setRemove(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-secondary"
                    disabled={busy || downloading}
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
        Auto chooses an installed model on a usable device. Choose Klein 4B for a
        smaller model.
      </p>
    </section>
  );
}
