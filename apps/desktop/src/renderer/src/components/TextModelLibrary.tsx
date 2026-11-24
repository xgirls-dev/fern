import { useEffect, useId, useRef, useState } from "react";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import { Button, ErrorMessage, InlineConfirmation, ModelCard, ModelCardActions, ModelCardHeading, ModelStatus } from "./ui/controls";
import type { useTextChat } from "../hooks/useTextChat";
import { useReturnFocus } from "../hooks/useReturnFocus";
import { isTextModelInstalling, textModelReadiness } from "../lib/textThreads";

function gigabytes(bytes: number) {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function TextModelLibrary({ studio, recommendedId }: { studio: ReturnType<typeof useTextChat>; recommendedId?: string }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const removalFocus = useReturnFocus();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const requirementsPrefix = useId();
  const { status, busy, refreshModels } = studio;
  useEffect(() => { void refreshModels(); }, [refreshModels]);
  const runtime = { ...status, residentModel: studio.statusError ? undefined : status.residentModel,
    runningModelId: status.job.status === "running" ? status.job.modelId : null };
  const recommendations = status.recommendedModels ?? [];
  const ordered = recommendedId ? [...recommendations].sort((a, b) => Number(b.id === recommendedId) - Number(a.id === recommendedId)) : recommendations;
  const error = (studio.actionError?.threadId ? undefined : studio.actionError?.message) ?? studio.statusError ?? status.registryError;
  return <section aria-label="Text models">
    <div className="models-section-heading"><div><h3 ref={heading} tabIndex={-1}>Text models</h3><p>Run private conversations on your device.</p></div><div className="text-model-import-actions">
      {window.studio.platform !== "darwin" && <Button type="button" disabled={busy} onClick={() => void studio.importModel()}>Add local model</Button>}
      {status.ggufAvailable && <Button type="button" disabled={busy} onClick={() => void studio.importModel("gguf")}>Import GGUF</Button>}
    </div></div>
    {error ? <ErrorMessage>{error}</ErrorMessage> : null}
    {!studio.statusLoaded ? <p role="status">Checking text models…</p> : null}
    <div className="model-library-grid">
      {ordered.map((model) => {
        const install = status.modelInstall?.modelId === model.id ? status.modelInstall : undefined;
        const installing = isTextModelInstalling(install);
        const paused = install?.status === "paused";
        const pausing = install?.status === "pausing";
        const pauseId = install?.status === "downloading" ? install.id : null;
        const canResume = paused || model.hasPartialDownload;
        const registered = status.models.find((entry) => entry.id === (model.registeredModelId ?? model.repairModelId));
        const readiness = registered && textModelReadiness(runtime, registered);
        const canRepair = Boolean(model.repairModelId);
        const needsRepair = canRepair && !model.installed;
        const repairing = install?.operation === "repair";
        const gguf = model.format === "gguf";
        const unavailable = gguf ? status.ggufAvailable !== true : canRepair && !status.runtimeAvailable;
        const showRequirements = !model.installed && !unavailable;
        const canDownload = !unavailable && !installing && (!model.installed || canRepair);
        const actionLabel = canRepair ? canResume ? "Resume repair" : needsRepair ? "Repair model" : "Check and repair"
          : canResume ? "Resume download" : "Download";
        const requirementsId = requirementsPrefix + model.id;
        const device = studio.computeDevice === "CPU" ? "CPU" : gguf && window.studio.platform === "darwin" ? "Apple GPU" : "Intel GPU";
        return <ModelCard key={model.id}>
          <ModelCardHeading icon={<MessageSquare size={17} />}><div className="model-card-heading"><h4>{model.name}</h4>
            {model.id === recommendedId && <span className="model-card-badge">{needsRepair ? "Current chat" : "Recommended"}</span>}</div></ModelCardHeading>
          <p>{!showRequirements && `${gigabytes(model.bytes)} · `}{gguf ? "GGUF · Chat, vision and image tools" : "OpenVINO · Chat"}</p>
          {showRequirements && <dl className="text-model-requirements" id={requirementsId}>
            <dt>{canResume || needsRepair ? "Full download" : "Download"}</dt><dd>{gigabytes(model.bytes)}</dd>
            <dt>Device</dt><dd>{device}</dd>
            {model.minimumFreeBytes !== undefined && <><dt>Free space</dt>
              <dd>{gigabytes(Math.ceil(model.minimumFreeBytes / 1e7) * 1e7)} for a fresh install</dd></>}
            {model.projectorBytes !== undefined && <><dt>Includes</dt><dd>Vision projector · {model.projectorBytes < 1e9
              ? `${Math.round(model.projectorBytes / 1e6)} MB` : gigabytes(model.projectorBytes)}</dd></>}
            {!gguf && <><dt>Files</dt><dd>Fern prepares the tokenizer and detokenizer</dd></>}
          </dl>}
          {needsRepair && !installing && !paused && <p>Fern checks the download and replaces files that are missing or damaged.</p>}
          {showRequirements && gguf && <p>Fern may download the GGUF runtime on first use.</p>}
          <ModelStatus installed={model.installed && readiness?.usable !== false && !installing && !paused} role="status">
            {paused ? repairing ? "Repair paused" : "Download paused" :
              installing ? install.phase || (repairing ? "Repairing…" : "Installing…") :
              model.installed ? readiness?.label ?? "Installed" :
              needsRepair ? "Needs repair" : "Not installed"}
          </ModelStatus>
          {repairing && install.status === "complete" && model.installed && <p>Repaired and verified.</p>}
          {paused ? <p>Downloaded files are kept for when you resume.</p> : null}
          {install?.status === "failed" ? <ErrorMessage>{install.error}</ErrorMessage> : null}
          {installing ? <progress aria-label="Text model installation" /> : null}
          {unavailable ? <p>{gguf ? status.ggufUnavailableReason ?? "GGUF runtime availability is unknown." :
            status.runtimeError ?? "The OpenVINO text runtime is unavailable."}</p> : null}
          <ModelCardActions>
            {pauseId || pausing || canDownload ? <Button variant={canDownload && !model.installed && model.id === recommendedId ? "primary" : "secondary"}
              aria-describedby={canDownload && showRequirements ? requirementsId : undefined}
              aria-disabled={pausing || (!!pauseId && !!studio.modelAction) || undefined}
              disabled={canDownload && (busy || !studio.statusLoaded || Boolean(studio.statusError))}
              onClick={() => {
                if (pauseId && !studio.modelAction) void studio.pauseRecommendedModel(pauseId);
                else if (canDownload) void studio.installRecommendedModel(model.id, canRepair);
              }}>{pausing ? "Pausing…" : pauseId ? repairing ? "Pause repair" : "Pause download" : actionLabel}</Button> : null}
          </ModelCardActions>
        </ModelCard>;
      })}
    </div>
    {status.models.length ? <div className="models-installed-list"><h3>Local text models</h3>{status.models.map((model) => {
      const managed = model.ownership === "managed";
      const label = managed ? "Remove download" : "Unlink model";
      const format = model.format === "gguf" ? model.supportsVision ? "GGUF · Text and vision" : "GGUF · Text" : "OpenVINO";
      const readiness = textModelReadiness(runtime, model);
      return <article className="models-installed-row" key={model.id}>
        <div>
          <strong title={model.name}>{model.name}</strong>
          <small title={model.path}>{managed ? "Downloaded by Fern" : "Linked files"} · {format}</small>
          <small>{readiness.label}{readiness.detail ? ` · ${readiness.detail}` : ""}</small>
        </div>
        {removing === model.id ? <InlineConfirmation confirmLabel={label} disabled={busy}
          onCancel={() => { setRemoving(null); removalFocus.restore(model.id); }}
          onConfirm={async () => {
            if (await studio.deleteModel(model.id, managed ? "remove-download" : "unlink")) {
              setRemoving(null);
              heading.current?.focus({ preventScroll: true });
            }
          }}>
          {managed ? "Delete this download from disk? Your chats and drafts stay." : "Unlink this model? Its files stay on disk."}
        </InlineConfirmation> : <Button ref={removalFocus.register(model.id)} type="button" disabled={busy}
          aria-label={managed ? `Remove download for ${model.name}` : `Unlink ${model.name}`}
          onClick={() => setRemoving(model.id)}>{label}</Button>}
      </article>;
    })}</div> : null}
  </section>;
}
