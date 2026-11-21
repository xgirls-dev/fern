import { ToggleChip } from "./ui/controls";

const STYLES = [
  { label: "Photoreal", suffix: "photorealistic, ultra-detailed, 50mm lens, natural lighting" },
  { label: "Cinematic", suffix: "cinematic lighting, film grain, dramatic, anamorphic" },
  { label: "Anime", suffix: "anime style, cel shading, vibrant colors" },
  { label: "Render", suffix: "3D render, octane, ray tracing, subsurface scattering" },
  { label: "Portrait", suffix: "studio portrait, soft light, shallow depth of field" },
  { label: "Minimal", suffix: "minimalist, clean composition, negative space" },
];

export function ImageStyleFields({ value, disabled, maxLength = Infinity, onChange }: {
  value: string;
  disabled?: boolean;
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  return <div className="ui-chip-group" role="group" aria-label="Style modifiers">
    {STYLES.map(({ label, suffix }) => {
      const selected = value.includes(suffix);
      const combined = [value.trim(), suffix].filter(Boolean).join(", ");
      return <ToggleChip key={label} selected={selected} disabled={disabled || (!selected && combined.length > maxLength)} onClick={() => {
        if (!selected) {
          onChange(combined);
          return;
        }
        const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        onChange(value.replace(new RegExp(",?\\s*" + escaped, "g"), "").replace(/^,\s*/, "").trim());
      }}>{label}</ToggleChip>;
    })}
  </div>;
}
