import type { TtsModelStatus } from "../hooks/useQwen3Tts";

export function SpeechModelRequirements({ id, model, device, environmentReady, label }: {
  id: string;
  model?: TtsModelStatus;
  device: "GPU" | "CPU";
  environmentReady: boolean;
  label?: string;
}) {
  const needsDownload = !model?.installed;
  return <div id={id} className="speech-model-requirements">
    {label && <strong>{label}</strong>}
    <dl className="model-download-requirements">
      {needsDownload && !!model?.bytes && <><dt>Download</dt><dd>{(model.bytes / 1e9).toFixed(2)} GB</dd></>}
      <dt>Device</dt><dd>{device === "CPU" ? "CPU" : "Intel GPU"}</dd>
      {needsDownload && !!model?.minimumFreeBytes && <>
        <dt>Free space</dt><dd>At least {(Math.ceil(model.minimumFreeBytes / 1e7) / 100).toFixed(2)} GB for a fresh model download</dd>
      </>}
      {needsDownload && !!model?.downloadIncludes?.length && <><dt>Includes</dt><dd>{model.downloadIncludes.join(", ")}</dd></>}
    </dl>
    {!environmentReady && <p>The OpenVINO speech runtime is set up separately and may need more disk space.</p>}
  </div>;
}
