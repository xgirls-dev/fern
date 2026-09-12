import { useEffect, useId, useRef, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import type { StudioSettings } from "../lib/types";

export interface ComposerModel {
  id: "9b" | "4b";
  label: string;
}
export function ComposerModelMenu({
  models,
  value,
  resolvedModel,
  disabled,
  onChange,
  onOpen,
}: {
  models: ComposerModel[];
  value: StudioSettings["model"];
  resolvedModel?: string;
  disabled: boolean;
  onChange: (model: StudioSettings["model"]) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const available = models.length > 1;
  useEffect(() => {
    if (!available || disabled) setOpen(false);
  }, [available, disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    const first =
      menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  if (!available) return null;
  const current = models.find(
    (model) => model.id === (value === "auto" ? resolvedModel : value),
  );
  return (
    <div className="composer-model-anchor" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="composer-model-trigger"
        aria-label="Choose model"
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
        <span>
          {current?.label ?? "Choose model"}
          {value === "auto" ? " · Auto" : ""}
        </span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={id}
          ref={menu}
          className="composer-model-menu"
          role="menu"
          aria-label="Model"
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
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button",
                ),
              );
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }
          }}
        >
          {[
            {
              id: "auto" as const,
              label: "Auto",
              detail: "Choose from installed models",
            },
            ...models.map((model) => ({ ...model, detail: "Installed" })),
          ].map((model) => (
            <button
              type="button"
              tabIndex={-1}
              key={model.id}
              role="menuitemradio"
              aria-checked={value === model.id}
              onClick={() => {
                onChange(model.id);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>
                <strong>{model.label}</strong>
                <small>{model.detail}</small>
              </span>
              {value === model.id ? (
                <Check size={15} aria-hidden="true" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
