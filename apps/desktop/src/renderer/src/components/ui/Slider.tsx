import type { ComponentProps, CSSProperties } from "react";

type SliderProps = Omit<ComponentProps<"input">, "type" | "value" | "defaultValue" | "min" | "max" | "step" | "onChange"> & {
  value: number;
  min: number;
  max: number;
  step: number;
  compact?: boolean;
  onChange: (value: number) => void;
};

export function Slider({ value, min, max, step, compact = false, onChange, className = "", style, ...props }: SliderProps) {
  const progress = max > min ? Math.min(100, Math.max(0, (value - min) / (max - min) * 100)) : 0;
  return <input {...props} type="range" className={`ui-slider${compact ? " ui-slider--compact" : ""} ${className}`}
    min={min} max={max} step={step} value={value}
    style={{ ...style, "--ui-slider-progress": `${progress}%` } as CSSProperties}
    onChange={(event) => onChange(event.currentTarget.valueAsNumber)} />;
}
