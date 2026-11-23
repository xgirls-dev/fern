import { useEffect, useRef, useState, type PointerEvent, type Ref } from "react";

type Drag = { pointerId: number; start: number; value: number; pixelsPerUnit: number; cancel: () => void };

export function ResizeHandle({ label, controls, orientation, value, min, max, step, inverted = false, resetValue,
  measurePixelsPerUnit, formatValue, onPreview, onCommit, onCancel, className = "", ref }: {
  label: string;
  controls: string;
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  step: number;
  inverted?: boolean;
  resetValue?: number;
  measurePixelsPerUnit?: () => number;
  formatValue: (value: number) => string;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
  onCancel: () => void;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const vertical = orientation === "vertical";
  const direction = inverted ? -1 : 1;
  const current = preview ?? value;
  useEffect(() => () => {
    drag.current?.cancel();
    drag.current = null;
  }, []);

  const clamp = (next: number) => Math.max(min, Math.min(max, next));
  const coordinate = (event: PointerEvent<HTMLDivElement>) => vertical ? event.clientX : event.clientY;
  const valueAt = (event: PointerEvent<HTMLDivElement>, active: Drag) => {
    const delta = coordinate(event) - active.start;
    return delta ? clamp(Math.round(active.value + direction * delta / active.pixelsPerUnit)) : active.value;
  };
  const cancelDrag = (pointerId: number) => {
    const active = drag.current;
    if (active?.pointerId !== pointerId) return;
    drag.current = null;
    setPreview(null);
    active.cancel();
  };

  return <div ref={ref} className={`ui-resize-handle ${className}`} role="separator" tabIndex={0}
    aria-label={label} aria-controls={controls} aria-orientation={orientation}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={current} aria-valuetext={formatValue(current)}
    data-resizing={preview !== null || undefined}
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return;
      const pixelsPerUnit = measurePixelsPerUnit?.() ?? 1;
      if (pixelsPerUnit <= 0) return;
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, start: coordinate(event), value, pixelsPerUnit, cancel: onCancel };
      setPreview(value);
    }}
    onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const next = valueAt(event, active);
      if (next === preview) return;
      setPreview(next);
      onPreview(next);
    }}
    onPointerUp={(event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      drag.current = null;
      setPreview(null);
      const next = valueAt(event, active);
      if (next === active.value) active.cancel();
      else onCommit(next);
    }}
    onPointerCancel={(event) => cancelDrag(event.pointerId)}
    onLostPointerCapture={(event) => cancelDrag(event.pointerId)}
    onDoubleClick={resetValue === undefined ? undefined : () => onCommit(clamp(resetValue))}
    onKeyDown={(event) => {
      const active = drag.current;
      if (active) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cancelDrag(active.pointerId);
        if (event.currentTarget.hasPointerCapture(active.pointerId)) event.currentTarget.releasePointerCapture(active.pointerId);
        return;
      }
      const before = vertical ? "ArrowLeft" : "ArrowUp";
      const after = vertical ? "ArrowRight" : "ArrowDown";
      const next = event.key === "Home" ? min : event.key === "End" ? max
        : event.key === before ? value - direction * step : event.key === after ? value + direction * step : null;
      if (next === null) return;
      event.preventDefault();
      onCommit(clamp(next));
    }} />;
}
