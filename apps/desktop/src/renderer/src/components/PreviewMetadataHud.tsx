import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import { useState } from "react";
import type { ImageRecord } from "../lib/types";

interface PreviewMetadataHudProps {
  image: ImageRecord;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

function formatGenerationTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatModelPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : normalized;
}

function formatDevice(device: string): string {
  switch (device.toUpperCase()) {
    case "GPU":
    case "INTEL_GPU":
      return "Intel GPU";
    case "NVIDIA_GPU":
    case "NVIDIA":
      return "NVIDIA GPU";
    case "CPU":
      return "CPU";
    default:
      return device;
  }
}

function hasMetadata(image: ImageRecord): boolean {
  return (
    Boolean(image.prompt) ||
    image.seed != null ||
    image.steps != null ||
    image.generationTime != null ||
    image.width != null ||
    image.height != null ||
    image.guidance != null ||
    Boolean(image.device) ||
    Boolean(image.modelPath)
  );
}

export function PreviewMetadataHud({ image, expanded: expandedProp, onExpandedChange }: PreviewMetadataHudProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = expandedProp ?? internalExpanded;

  if (!hasMetadata(image)) return null;

  const rows: Array<{ label: string; value: string }> = [];
  rows.push({
    label: "Reference",
    value:
      image.referenceUsed == null
        ? "Not recorded"
        : image.referenceUsed
          ? "Used"
          : "None",
  });
  if (image.prompt) rows.push({ label: "Prompt", value: image.prompt });
  if (image.seed != null)
    rows.push({ label: "Seed", value: String(image.seed) });
  if (image.steps != null)
    rows.push({ label: "Steps", value: String(image.steps) });
  if (image.generationTime != null) {
    rows.push({
      label: "Time",
      value: formatGenerationTime(image.generationTime),
    });
  }
  if (image.width != null && image.height != null) {
    rows.push({ label: "Size", value: `${image.width} x ${image.height}` });
  }
  if (image.guidance != null)
    rows.push({ label: "Guidance", value: String(image.guidance) });
  if (image.device)
    rows.push({ label: "Device", value: formatDevice(image.device) });
  if (image.modelPath)
    rows.push({ label: "Model", value: formatModelPath(image.modelPath) });

  return (
    <div
      className={`preview-metadata-hud${expanded ? " is-expanded" : " is-collapsed"}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="preview-metadata-hud-header"
        onClick={() => {
          const next = !expanded;
          setInternalExpanded(next);
          onExpandedChange?.(next);
        }}
        aria-expanded={expanded}
      >
        <div className="preview-metadata-hud-title">
          <Info size={12} aria-hidden="true" />
          <span>Render Info</span>

        </div>
        {expanded ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronUp size={13} aria-hidden="true" />
        )}
      </button>

      {expanded && (
        <div className="preview-metadata-hud-body">
          {rows.map((row) => (
            <div key={row.label} className="preview-metadata-hud-row">
              <span className="preview-metadata-hud-label">{row.label}</span>
              <span className="preview-metadata-hud-value">{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
