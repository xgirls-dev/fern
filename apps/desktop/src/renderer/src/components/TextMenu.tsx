import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";

export function TextMenu({ label, value, options, onSelect, disabled, children }: {
  label: string; value: string; options: { value: string; label: string; description?: string; disabled?: boolean }[];
  onSelect: (value: string) => void; disabled?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    (root.current?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)')
      ?? root.current?.querySelector<HTMLElement>('[role="menu"] button:not(:disabled)'))?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="text-menu" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} className="composer-model-trigger text-menu-trigger" type="button" aria-label={label} title={options.find(option => option.value === value)?.label ?? label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => setOpen(!open)} onKeyDown={(event) => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>
      <span>{options.find(option => option.value === value)?.label ?? "Select model"}</span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && <div className="composer-model-menu text-menu-panel" id={id} role="menu" aria-label={label} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
      {options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={option.value === value} disabled={option.disabled} onClick={() => { onSelect(option.value); setOpen(false); trigger.current?.focus(); }}>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Check size={15} aria-hidden="true" />}
      </button>)}
      {children && <div className="text-menu-extra" onClick={() => { trigger.current?.focus(); setOpen(false); }}>{children}</div>}
    </div>}
  </div>;
}
