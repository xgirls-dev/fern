import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { Button } from "./controls";
import { Dropdown, DropdownGroup, DropdownItem, DropdownRadioGroup, DropdownRadioItem, DropdownSeparator } from "./Dropdown";

export interface ModelMenuOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function ModelMenu({ label, value, options, disabled, triggerLabel, className = "", triggerClassName = "",
  onChange, onManageModels, onOpen }: {
  label: string;
  value: string;
  options: readonly ModelMenuOption[];
  disabled?: boolean;
  triggerLabel?: string;
  className?: string;
  triggerClassName?: string;
  onChange: (value: string) => void;
  onManageModels: () => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const optionList = useRef<HTMLDivElement>(null);
  const manageAction = useRef<HTMLElement>(null);
  const focusedOption = useRef<string | undefined>(undefined);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const name = triggerLabel ?? options.find((option) => option.value === value)?.label ?? "Select model";
  const available = options.filter((option) => !option.disabled);
  const unavailable = options.filter((option) => option.disabled);
  const grouped = available.length > 0 && unavailable.length > 0;

  useLayoutEffect(() => {
    const list = optionList.current;
    const previous = focusedOption.current;
    if (!open || disabled || !list || previous === undefined || document.activeElement !== document.body) return;
    // Availability can move a focused model to another group and replace its DOM node.
    const item = list.querySelector<HTMLElement>(`[data-model-option="${CSS.escape(previous)}"]`)
      ?? list.querySelector<HTMLElement>(`[data-model-option="${CSS.escape(value)}"]:not([aria-disabled="true"])`)
      ?? list.querySelector<HTMLElement>('[data-model-option]:not([aria-disabled="true"])')
      ?? manageAction.current;
    item?.focus();
  }, [disabled, open, options, value]);

  const renderOption = (option: ModelMenuOption) => <DropdownRadioItem key={option.value} value={option.value}
    data-model-option={option.value} label={option.label} aria-label={option.label}
    aria-description={option.description} disabled={option.disabled}>
    <span className="ui-popup-label">{option.label}</span>
    {option.description ? <span className="ui-model-menu-note" aria-hidden="true">{option.description}</span>
      : option.value === value ? <Check size={14} aria-hidden="true" /> : null}
  </DropdownRadioItem>;

  return <Dropdown label={label} className={`ui-model-menu ${className}`} side="top" align="end" triggerTooltip={name}
    open={open && !disabled} onOpenChange={(next) => {
      focusedOption.current = undefined;
      if (next) onOpen?.();
      setOpen(next);
    }}
    trigger={<Button variant="ghost" className={`composer-model-trigger ${triggerClassName}`}
      aria-label={`${label}: ${name}`} disabled={disabled}>
      <span>{name}</span><ChevronDown size={13} aria-hidden="true" />
    </Button>}>
    <div className="ui-model-menu-options" ref={optionList} onFocusCapture={(event) => {
      if (event.target instanceof HTMLElement) focusedOption.current = event.target.dataset.modelOption;
    }}>
      <DropdownRadioGroup value={value} onValueChange={onChange}>
        {!!available.length && <DropdownGroup label={grouped ? "Available" : undefined}>{available.map(renderOption)}</DropdownGroup>}
        {grouped && <DropdownSeparator />}
        {!!unavailable.length && <DropdownGroup label={grouped ? "Unavailable" : undefined}>{unavailable.map(renderOption)}</DropdownGroup>}
      </DropdownRadioGroup>
    </div>
    <DropdownSeparator />
    <DropdownItem ref={manageAction} onClick={onManageModels}>Manage models</DropdownItem>
  </Dropdown>;
}
