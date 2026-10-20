import { useEffect, useId, useRef, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import type { StudioSettings } from "../lib/types";

export interface ComposerModel {
  id: "9b" | "4b" | "qwen21-turbo" | "flux3-klein" | "tame-pony-v25-sdxl" | "tame-pony-v25-sdxl-int8";
  label: string;
}

const MODEL_LABELS: Record<ComposerModel["id"], string> = {
  "9b": "Klein 9B",
  "4b": "Klein 4B",
  "qwen21-turbo": "Qwen Image 2.1 Turbo",
  "flux3-klein": "FLUX.3 Klein · INT4",
  "tame-pony-v25-sdxl": "Tame Pony · SDXL",
  "tame-pony-v25-sdxl-int8": "Tame Pony · SDXL INT8",
};
const MODEL_CHOICES: ComposerModel["id"][] = ["9b", "4b", "qwen21-turbo", "flux3-klein", "tame-pony-v25-sdxl", "tame-pony-v25-sdxl-int8"];

export function ComposerModelMenu({
  models,
  loading = false,
  value,
  disabled,
  onChange,
  onOpen,
}: {
  models: ComposerModel[];
  loading?: boolean;
  value: StudioSettings["model"];
  disabled: boolean;
  onChange: (model: StudioSettings["model"]) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selectedId = value === "4b" || value === "qwen21-turbo" || value === "flux3-klein" || value === "tame-pony-v25-sdxl" || value === "tame-pony-v25-sdxl-int8" ? value : "9b";
  const current = models.find((model) => model.id === selectedId);
  const triggerLabel = loading
    ? "Checking…"
    : current
      ? MODEL_LABELS[current.id]
      : models.length
        ? `${MODEL_LABELS[selectedId]} · Missing`
        : "No models";

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    const first =
      menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)') ??
      menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (first) first.focus();
    else menu.current?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <div className="composer-model-anchor" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="composer-model-trigger"
        aria-label={`Image model: ${triggerLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onOpen();
            setOpen(true);
          }
        }}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={id}
          ref={menu}
          className="composer-model-menu"
          role="menu"
          aria-label="Image model"
          tabIndex={-1}
          onBlur={(event) => {
            if (!root.current?.contains(event.relatedTarget as Node))
              setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setOpen(false);
              trigger.current?.focus();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              if (!items.length) return;
              event.preventDefault();
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}
        >
          {MODEL_CHOICES.map((modelId) => {
            const installed = models.some((model) => model.id === modelId);
            return (
              <button
                type="button"
                tabIndex={-1}
                key={modelId}
                role="menuitemradio"
                aria-checked={selectedId === modelId}
                disabled={!installed}
                title={installed ? undefined : "Not installed"}
                onClick={() => {
                  onChange(modelId);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <span>{MODEL_LABELS[modelId]}</span>
                {installed && selectedId === modelId ? (
                  <Check size={14} aria-hidden="true" />
                ) : !installed ? (
                  <span className="composer-model-unavailable">Not installed</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
