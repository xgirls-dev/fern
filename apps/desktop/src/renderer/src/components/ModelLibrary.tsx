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
  supportsReferenceImage?: boolean;
  error?: string;
  family?: string;
  familyLabel?: string;
  sourceType?: "local" | "huggingface";
  repoId?: string;
}
interface CustomImageDownload {
  status: string;
  phase?: string;
  repoId?: string;
  downloaded?: number;
  bytes?: number;
  error?: string | null;
}
const CUSTOM_IMAGE_FAMILIES = [
  ["stable-diffusion", "Stable Diffusion 1.x / 2.x"],
  ["sdxl", "Stable Diffusion XL"],
  ["sd3", "Stable Diffusion 3"],
  ["flux", "FLUX.1"],
  ["flux2-klein", "FLUX.2 Klein"],
  ["lcm", "Latent Consistency Model"],
] as const;
export function ModelLibrary({ status }: { status: ModelStatus | null }) {
  const [models, setModels] = useState<InstalledModel[]>([]);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const [customFamily, setCustomFamily] = useState<string>("sdxl");
  const [customRepo, setCustomRepo] = useState("");
  const [customDownload, setCustomDownload] = useState<CustomImageDownload>({ status: "idle" });
  const [addingCustom, setAddingCustom] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      let setupActive = false;
      let customDownloadActive = false;
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/models`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("Could not load models. Retrying…");
        const data = await response.json();
        if (!Array.isArray(data.models)) throw new Error("Model status response is invalid.");
        failures = 0;
        setupActive = data.models.some((model: InstalledModel) => ["installing", "checking-runtime"].includes(model.state));
        customDownloadActive = ["checking", "downloading", "validating"].includes(data.customImageDownload?.status);
        if (alive) {
          setModels(data.models);
          if (data.customImageDownload) setCustomDownload(data.customImageDownload);
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
            : setupActive || customDownloadActive ? 1_500 : 8_000;
          timer = setTimeout(poll, delay);
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [customDownload.status]);
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
  ) || ["checking", "downloading", "validating"].includes(customDownload.status);
  const actionsUnavailable = busy || Boolean(error);
  const addCustomModel = async () => {
    setAddingCustom(true);
    setActionError("");
    try {
      const path = await window.studio.pickCustomImageModelFolder();
      if (!path) return;
      const response = await fetch(`${getApiBaseUrl()}/api/models/custom/add`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ path, family: customFamily }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not add this model.");
      if (!Array.isArray(data.models)) throw new Error("The model service returned an invalid status response.");
      setModels(data.models);
      setError("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not add this model.");
    } finally {
      setAddingCustom(false);
    }
  };
  const downloadCustomModel = async () => {
    setActionError("");
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/models/custom/download`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ repoId: customRepo.trim(), family: customFamily }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start the Hugging Face download.");
      if (data.customImageDownload) setCustomDownload(data.customImageDownload);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not start the Hugging Face download.");
    }
  };
  const cancelCustomDownload = async () => {
    setActionError("");
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/models/custom/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000), body: "{}",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not cancel the download.");
      if (data.customImageDownload) setCustomDownload(data.customImageDownload);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not cancel the download.");
    }
  };
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
      <div className="model-library-import">
        <label>
          <span>Model family</span>
          <select aria-label="Custom image model family" value={customFamily} disabled={addingCustom || downloading || busy} onChange={(event) => setCustomFamily(event.target.value)}>
            {CUSTOM_IMAGE_FAMILIES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="model-library-hub-repo">
          <span>Hugging Face repository</span>
          <input aria-label="Hugging Face repository" placeholder="owner/model or Hugging Face URL" value={customRepo} disabled={downloading || busy} onChange={(event) => setCustomRepo(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && customRepo.trim()) void downloadCustomModel(); }} />
        </label>
        <div className="model-library-import-actions">
          {downloading ? (
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void cancelCustomDownload()}>Cancel download</button>
          ) : (
            <button className="btn btn-primary" type="button" disabled={!customRepo.trim() || addingCustom || busy || Boolean(error)} onClick={() => void downloadCustomModel()}>Download</button>
          )}
          <button className="btn btn-secondary" type="button" disabled={addingCustom || downloading || busy || Boolean(error)} onClick={() => void addCustomModel()}>
            {addingCustom ? "Validating…" : "Add local folder"}
          </button>
        </div>
        <p>Fern downloads the selected OpenVINO export into managed model storage. Public repos work directly; gated or private repos need an authorized Hugging Face login. Local folders are linked in place.</p>
        {customDownload.status !== "idle" ? (
          <div className="model-library-download-status" role="status" aria-live="polite">
            <span>{customDownload.phase || customDownload.status}{customDownload.repoId ? ` · ${customDownload.repoId}` : ""}</span>
            {["checking", "downloading", "validating"].includes(customDownload.status) ? (
              customDownload.status === "downloading" && (customDownload.bytes ?? 0) > 0 ? (
                <><progress aria-label="Custom OpenVINO model download" value={customDownload.downloaded ?? 0} max={customDownload.bytes} /><small>{((customDownload.downloaded ?? 0) / 1e9).toFixed(2)} / {((customDownload.bytes ?? 0) / 1e9).toFixed(2)} GB</small></>
              ) : <progress className="model-library-indeterminate" aria-label="Custom model setup is in progress" />
            ) : null}
            {customDownload.error ? <span role="alert">{customDownload.error}</span> : null}
          </div>
        ) : null}
      </div>
      {!models.length && !error ? (
        <p role="status">Checking installed models…</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      <div className="model-library-grid">
        {models.map((model) => (
          <article
            className={`model-library-card${model.id === "qwen21-turbo" ? " model-library-card-qwen" : model.id === "flux3-klein" ? " model-library-card-flux3" : model.id.startsWith("tame-pony-") || model.id.startsWith("custom-") ? " model-library-card-sdxl" : ""}`}
            key={model.id}
            aria-busy={["installing", "checking-runtime"].includes(model.state) || undefined}
          >
            <h4>{model.label}</h4>
            <p>
              {model.id.startsWith("custom-")
              ? `OpenVINO · ${model.familyLabel ?? model.family ?? "Custom family"} · ${model.sourceType === "huggingface" ? model.repoId ?? "Hugging Face download" : "linked local folder"}`
              : model.id === "qwen21-turbo"
              ? `Official 8-step checkpoint · OpenVINO INT8 · ${model.bytes > 0 ? `about ${(model.bytes / 1e9).toFixed(1)} GB download · ` : ""}compiled GPU caches add disk use after first launch`
                : model.id === "flux3-klein"
                  ? `OpenVINO mixed INT4/INT8 · 16 steps · text-to-image · ${model.bytes > 0 ? `about ${(model.bytes / 1e9).toFixed(2)} GB download` : ""}`
                  : model.id.startsWith("tame-pony-")
                    ? `SDXL · OpenVINO ${model.id.endsWith("-int8") ? "INT8 quantized" : "export"} · text-to-image · ${model.bytes > 0 ? `about ${(model.bytes / 1e9).toFixed(2)} GB download` : ""}`
                    : `${model.bytes > 0 ? `${(model.bytes / 1e9).toFixed(2)} GB · ` : ""}${model.id === "4b" ? "Smaller download and lower memory use" : "Larger model"}`}
            </p>
              {model.id.startsWith("custom-") ? (
              <p className="model-library-note">Text-to-image only. {model.sourceType === "huggingface" ? "Downloaded files are stored and managed by Fern." : "Remove from Fern to unlink it; the local model files stay where they are."}</p>
            ) : model.id.startsWith("tame-pony-") ? (
              <p className="model-library-note">Text-to-image only. Starts at 1024 × 1024, 30 steps, guidance 7.0; resolution and sampling remain adjustable. Licensed under FAIPL-1.0-SD.</p>
            ) : null}
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
            {model.id === "flux3-klein" ? (
              <>
                <p className="model-library-note">FLUX Kommunity License · the model card includes the required license and attribution notice.</p>
                <p className="model-library-note">Fern prepares a separate Diffusers compatibility layer during setup. Text-to-image only; 1024 × 1024 is the published end-to-end validation size.</p>
                <p className="model-library-note">The updated runner requests FP32 transformer inference on OpenVINO GPU. Fern's previous GPU runs were blank; output quality is being rechecked with the updated runner.</p>
              </>
            ) : null}
            <p className="model-library-status" role="status" aria-live="polite">
              {model.state === "not-installed"
                ? "Not installed"
                : model.state === "installed"
                  ? model.id.startsWith("custom-")
                    ? model.sourceType === "huggingface" ? "Installed · Hugging Face export downloaded" : "Installed · local OpenVINO export linked"
                    : model.id.startsWith("tame-pony-")
                      ? "Installed · OpenVINO SDXL files present"
                      : "Installed · OpenVINO runtime ready"
                  : model.state === "installing"
                    ? model.id === "flux3-klein"
                      ? model.phase || "Preparing FLUX.3 runtime…"
                      : model.phase?.replace("FERN_QWEN_PROGRESS:", "") || "Setting up official Qwen Turbo…"
                    : model.state === "checking-runtime"
                      ? "Checking OpenVINO runtime and available devices…"
                    : model.state === "repair-needed"
                      ? model.id.startsWith("custom-") ? "Model folder unavailable. Add the export folder again." : "Incomplete model files. Remove them, then install again."
                      : model.state === "runtime-unavailable"
                        ? model.id === "flux3-klein"
                          ? "Model files are present, but the FLUX.3 Diffusers runtime is unavailable."
                          : model.id.startsWith("custom-")
                            ? "Model files are present, but OpenVINO GenAI is unavailable."
                            : model.id.startsWith("tame-pony-")
                            ? "Model files are present, but this Fern runtime cannot load OpenVINO SDXL."
                            : "Model files are present, but this Fern runtime cannot load OpenVINO Qwen."
                    : model.state}
            </p>
            {model.id === "flux3-klein" && model.state === "installing" ? (
              model.downloaded > 0 && model.downloaded < model.bytes ? (
                <>
                  <progress
                    aria-label="FLUX.3 Klein model download"
                    value={model.downloaded}
                    max={model.bytes}
                  />
                  <p>
                    {(model.downloaded / 1e9).toFixed(2)} / {(model.bytes / 1e9).toFixed(2)} GB
                  </p>
                </>
              ) : (
                <progress
                  className="model-library-indeterminate"
                  aria-label={model.phase?.startsWith("Downloading") ? "Downloading FLUX.3 Klein model" : "Preparing FLUX.3 runtime"}
                />
              )
            ) : null}
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
            {model.id === "flux3-klein" && model.logs?.length ? (
              <details>
                <summary>Setup details</summary>
                <ul>{model.logs.slice(-12).map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>
              </details>
            ) : null}
            <div className="model-library-actions">
              {model.id.startsWith("custom-") ? (
                remove === model.id ? (
                  <>
                    <span>{model.sourceType === "huggingface" ? "Remove the downloaded model files from Fern?" : "Remove this model from Fern? Its files stay untouched."}</span>
                    <button className="btn btn-secondary" disabled={actionsUnavailable || downloading} onClick={() => void action(model.id, "remove")}>Confirm removal</button>
                    <button className="btn btn-secondary" disabled={busy || Boolean(error)} onClick={() => setRemove(null)}>Cancel</button>
                  </>
                ) : <button className="btn btn-secondary" disabled={actionsUnavailable || downloading} onClick={() => setRemove(model.id)}>Remove</button>
              ) : model.state === "installing" && model.id === "flux3-klein" ? (
                <button
                  className="btn btn-secondary"
                  disabled={actionsUnavailable}
                  onClick={() => void action(model.id, "pause")}
                >
                  Cancel setup
                </button>
              ) : model.state === "installing" && model.id === "qwen21-turbo" ? (
                <button
                  className="btn btn-secondary"
                  disabled={actionsUnavailable}
                  onClick={() => void action(model.id, "pause")}
                >
                  Cancel setup
                </button>
              ) : model.id === "flux3-klein" && model.state === "runtime-unavailable" ? (
                <button
                  className="btn btn-secondary"
                  disabled={actionsUnavailable || downloading}
                  onClick={() => void action(model.id, "install")}
                >
                  Repair runtime
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
                  {model.id === "qwen21-turbo" || model.id === "flux3-klein"
                    ? model.state === "paused"
                      ? "Resume setup"
                      : model.state === "failed"
                        ? "Retry setup"
                        : model.state === "runtime-unavailable"
                          ? "Repair runtime"
                          : "Install"
                    : ["paused", "failed"].includes(model.state)
                      ? "Resume download"
                      : "Install"}
                </button>
              ) : null}
              {!model.id.startsWith("custom-") &&
              (model.installed ||
                ["failed", "paused", "repair-needed", "runtime-unavailable"].includes(model.state)) ? (
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
