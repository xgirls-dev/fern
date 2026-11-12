import { useState } from "react";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import { Button, ErrorMessage, InlineConfirmation, ModelCard, ModelCardActions, ModelCardHeading, ModelStatus } from "./ui/controls";
import type { useTextChat } from "../hooks/useTextChat";
import { useReturnFocus } from "../hooks/useReturnFocus";

export function TextModelLibrary({ studio }: { studio: ReturnType<typeof useTextChat> }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const removalFocus = useReturnFocus();
  const { status, busy } = studio;
  const error = studio.actionError ?? studio.statusError ?? status.registryError;
  return <section aria-label="Text models">
    <div className="models-section-heading"><div><h3>Text models</h3><p>Run private conversations on your device.</p></div><Button type="button"  disabled={busy} onClick={() => void studio.importModel()}>Add local model</Button></div>
    {error ? <ErrorMessage>{error}</ErrorMessage> : null}
    {!studio.statusLoaded ? <p role="status">Checking text models…</p> : null}
    <div className="model-library-grid">
      {status.recommendedModels?.map((model) => {
        const install = status.modelInstall;
        const installing = install?.modelId === model.id && ["downloading", "preparing"].includes(install.status);
        return <ModelCard key={model.id}>
          <ModelCardHeading icon={<MessageSquare size={17} />}><div className="model-card-heading"><h4>{model.name}</h4><span className="model-card-badge">Recommended</span></div></ModelCardHeading>
          <p>{(model.bytes / 1024 ** 3).toFixed(2)} GiB · OpenVINO</p>
          <ModelStatus installed={model.installed}>{model.installed ? "Installed" : installing ? install?.phase || "Installing…" : "Not installed"}</ModelStatus>
          {install?.modelId === model.id && install.status === "failed" ? <ErrorMessage>{install.error}</ErrorMessage> : null}
          {installing ? <progress aria-label="Text model installation" /> : null}
          <ModelCardActions><Button disabled={busy || model.installed} onClick={() => void studio.installRecommendedModel(model.id)}>{model.installed ? "Installed" : installing ? "Installing…" : "Download"}</Button></ModelCardActions>
        </ModelCard>;
      })}
    </div>
    {status.models.length ? <div className="models-installed-list"><h3>Installed text models</h3>{status.models.map((model) => <article className="models-installed-row" key={model.id}>
      <div><strong title={model.name}>{model.name}</strong><small title={model.path}>{model.installed ? "Local OpenVINO model" : "Folder unavailable"}</small></div>
      {removing === model.id ? <InlineConfirmation confirmLabel="Remove model" disabled={busy} onCancel={() => { setRemoving(null); removalFocus.restore(model.id); }} onConfirm={() => { void (async () => { if (await studio.deleteModel(model.id)) setRemoving(null); })(); }}>Remove from Fern? The files on disk will be kept.</InlineConfirmation> : <Button ref={removalFocus.register(model.id)} type="button" disabled={busy} aria-label={`Remove ${model.name}`} onClick={() => setRemoving(model.id)}>Remove</Button>}
    </article>)}</div> : null}
  </section>;
}
