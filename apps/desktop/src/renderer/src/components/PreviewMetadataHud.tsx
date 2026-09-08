import type { ImageRecord } from "../lib/types";

interface PreviewMetadataHudProps {
  image: ImageRecord;
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

export function PreviewMetadataHud({ image }: PreviewMetadataHudProps) {
  if (!hasMetadata(image)) return null;

  const rows: Array<{ label: string; value: string }> = [];
  if (image.prompt) rows.push({ label: "Prompt", value: image.prompt });
  rows.push({
    label: "Reference",
    value:
      image.referenceUsed == null
        ? "Not recorded"
        : image.referenceUsed
          ? "Used"
          : "None",
  });
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
    <dl className="render-metadata">
      {rows.map((row) => (
        <div
          key={row.label}
          className={row.label === "Prompt" ? "metadata-prompt" : ""}
        >
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
