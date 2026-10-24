import { useState } from "react";
import type { useTextChat } from "../hooks/useTextChat";

export function TextModelLibrary({ studio }: { studio: ReturnType<typeof useTextChat> }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const { status, busy } = studio;
  const error = studio.actionError ?? studio.statusError ?? status.registryError;
  return <section aria-label="Text models">
    <div className="models-section-heading"><div><h3>Text models</h3><p>Run private conversations on your device.</p></div><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void studio.importModel()}>Add local model</button></div>
    {error ? <p role="alert" className="text-error">{error}</p> : null}
    {!studio.statusLoaded ? <p role="status">Checking text models…</p> : null}
    <div className="model-library-grid">
      {status.recommendedModels?.map((model) => {
        const install = status.modelInstall;
        const installing = install?.modelId === model.id && ["downloading", "preparing"].includes(install.status);
        return <article className="model-library-card" key={model.id}>
          <div className="model-card-heading"><h4>{model.name}</h4><span className="model-card-badge">Recommended</span></div>
          <p>{(model.bytes / 1024 ** 3).toFixed(2)} GiB · OpenVINO</p>
          <p role="status">{model.installed ? "Installed" : installing ? install?.phase || "Installing…" : "Not installed"}</p>
          {install?.modelId === model.id && install.status === "failed" ? <p role="alert">{install.error}</p> : null}
          {installing ? <progress aria-label="Text model installation" /> : null}
          <div className="model-library-actions"><button type="button" className="btn btn-secondary" disabled={busy || model.installed} onClick={() => void studio.installRecommendedModel(model.id)}>{model.installed ? "Installed" : installing ? "Installing…" : "Download"}</button></div>
        </article>;
      })}
    </div>
    {status.models.length ? <div className="models-installed-list"><h3>Installed text models</h3>{status.models.map((model) => <article className="models-installed-row" key={model.id}>
      <div><strong title={model.name}>{model.name}</strong><small title={model.path}>{model.installed ? "Local OpenVINO model" : "Folder unavailable"}</small></div>
      {removing === model.id ? <div className="model-remove-confirm"><p>Remove from Fern? The files on disk will be kept.</p><button type="button" className="btn btn-secondary" onClick={() => setRemoving(null)}>Cancel</button><button type="button" className="btn btn-danger-outline" disabled={busy} onClick={async () => { if (await studio.deleteModel(model.id)) setRemoving(null); }}>Remove model</button></div> : <button type="button" className="btn btn-secondary" disabled={busy} aria-label={`Remove ${model.name}`} onClick={() => setRemoving(model.id)}>Remove</button>}
    </article>)}</div> : null}
  </section>;
}
