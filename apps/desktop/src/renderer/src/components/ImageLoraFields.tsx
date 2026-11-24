import { useEffect, useId, useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { getApiBaseUrl } from "../lib/api";
import type { LoraSelection } from "../lib/types";
import { Button, Checkbox, Input } from "./ui/controls";
import { TooltipIconButton } from "./ui/Tooltip";

function loraDisplayName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const filename = parts.at(-1)?.replace(/\.safetensors$/i, "").replace(/^[a-f0-9]{12}-/, "") ?? path;
  return /^(pytorch_lora_weights|adapter_model)$/i.test(filename) && parts.length > 1 && parts[parts.length - 2].toLowerCase() !== "loras"
    ? parts[parts.length - 2]
    : filename;
}

function downloadedLoraLabel(url: string, path: string): string {
  const fallback = loraDisplayName(path);
  if (!/^(pytorch_lora_weights|adapter_model)$/i.test(fallback)) return fallback;
  try {
    const source = new URL(url);
    const parts = source.pathname.split("/").filter(Boolean);
    if (source.hostname.endsWith("huggingface.co") && parts.length >= 5) {
      return decodeURIComponent(parts.length > 5 ? parts[parts.length - 2] : parts[1]);
    }
  } catch { /* Use the filename when the source link is unavailable. */ }
  return fallback;
}

export function ImageLoraFields({ loras, onChange, disabled, error }: {
  loras: LoraSelection[];
  onChange: (loras: LoraSelection[]) => void;
  disabled?: boolean;
  error?: string;
}) {
  const linkId = useId();
  const [loraError, setLoraError] = useState("");
  const [loraUrl, setLoraUrl] = useState("");
  const [loraDownload, setLoraDownload] = useState<{ status: string; name?: string; path?: string; downloaded?: number; bytes?: number; error?: string }>({ status: "idle" });
  const [startingLoraDownload, setStartingLoraDownload] = useState(false);
  const [loraDownloadOpen, setLoraDownloadOpen] = useState(false);
  useEffect(() => {
    if (!loraDownloadOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/loras/download`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error("Could not check the LoRA download.");
        const state = await response.json();
        if (!cancelled) { setLoraDownload(state); if (["checking", "downloading"].includes(state.status)) timer = setTimeout(poll, 1200); }
      } catch (error) { if (!cancelled) setLoraError(error instanceof Error ? error.message : "Could not check the LoRA download."); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [loraDownloadOpen, startingLoraDownload]);
  const downloadLora = async (cancel = false) => {
    setStartingLoraDownload(true); setLoraError("");
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/loras/download${cancel ? "/cancel" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cancel ? {} : { url: loraUrl }) });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || "Could not download the LoRA.");
      setLoraDownload(state);
    } catch (error) { setLoraError(error instanceof Error ? error.message : "Could not download the LoRA."); }
    finally { setStartingLoraDownload(false); }
  };
  const addLoras = async () => {
    try {
      const paths = await window.studio.pickLoraFiles();
      const existing = new Set(loras.map((item) => item.path.toLowerCase()));
      const next = [...loras];
      for (const path of paths) {
        if (existing.has(path.toLowerCase())) continue;
        if (next.length >= 4) { setLoraError("Choose up to four LoRAs."); break; }
        existing.add(path.toLowerCase());
        next.push({ path, strength: 1, enabled: true });
      }
      if (next.length <= 4 && paths.length <= 4 - loras.length) setLoraError("");
      onChange(next);
    } catch (error) {
      setLoraError(error instanceof Error ? error.message : "Could not open the file picker.");
    }
  };
  return <fieldset className="image-lora-fields" disabled={disabled} aria-label="LoRAs">
    <p className="lora-intro">Add local LoRAs to guide your image. Include their trigger words in your prompt.</p>
    {loras.length ? <div className="lora-list-heading" aria-hidden="true"><span>LoRA</span><span>Strength</span><span /></div> : null}
    {loras.map((lora, index) => (
      <div className={`lora-control${lora.enabled ? "" : " is-disabled"}`} key={lora.path}>
        <div className="lora-control-heading">
          <label className="lora-control-name" title={lora.path}>
            <Checkbox checked={lora.enabled} aria-label={lora.path.split(/[\\/]/).pop()} onChange={(event) => onChange(loras.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item))} />
            <span>{lora.label || loraDisplayName(lora.path)}</span>
          </label>
          <label className="lora-control-strength"><span className="sr-only">Strength</span>
            <Input type="number" min={-4} max={4} step={0.1} value={lora.strength} aria-label={`Strength for ${lora.path.split(/[\\/]/).pop()}`} onChange={(event) => onChange(loras.map((item, i) => i === index ? { ...item, strength: Number(event.target.value) } : item))} />
          </label>
          <TooltipIconButton onClick={() => onChange(loras.filter((_, i) => i !== index))} aria-label={`Remove ${lora.path.split(/[\\/]/).pop()}`} tooltip="Remove LoRA"><X size={15} aria-hidden="true" /></TooltipIconButton>
        </div>
      </div>
    ))}
    <Button variant="ghost" className="lora-add" disabled={loras.length >= 4} onClick={() => void addLoras()}><Plus size={15} aria-hidden="true" /> Add LoRA files</Button>
    <details className="lora-download" onToggle={(event) => setLoraDownloadOpen(event.currentTarget.open)}><summary>Download from a link</summary><div className="lora-download-content">
      <label htmlFor={linkId}>Hugging Face or Civitai link</label>
      <Input id={linkId} type="url" placeholder="https://…" value={loraUrl} onChange={(event) => setLoraUrl(event.target.value)} disabled={startingLoraDownload || ["checking", "downloading"].includes(loraDownload.status)} />
      {["checking", "downloading"].includes(loraDownload.status) ? <><p role="status">{loraDownload.status === "checking" ? "Checking link…" : `Downloading ${loraDownload.name ?? "LoRA"}…`}</p><progress aria-label="LoRA download" {...(loraDownload.bytes ? { value: loraDownload.downloaded ?? 0, max: loraDownload.bytes } : {})} /><Button onClick={() => void downloadLora(true)} disabled={startingLoraDownload}>Cancel download</Button></> : <Button disabled={!loraUrl.trim() || startingLoraDownload || loras.length >= 4} onClick={() => void downloadLora()}>Download LoRA</Button>}
      {loraDownload.status === "complete" && loraDownload.path ? <div className="lora-downloaded"><span title={loraDownload.name}>{loraDownload.name} downloaded</span><Button disabled={loras.length >= 4 || loras.some((item) => item.path.toLowerCase() === loraDownload.path!.toLowerCase())} onClick={() => onChange([...loras, { path: loraDownload.path!, strength: 1, enabled: true, label: downloadedLoraLabel(loraUrl, loraDownload.path!) }])}>Add to thread</Button></div> : null}
      {loraDownload.status === "failed" ? <p role="alert" className="field-error">{loraDownload.error || "Download failed."}</p> : null}
    </div></details>
    {loraError || error ? <p role="alert" className="field-error">{loraError || error}</p> : null}
  </fieldset>;
}
