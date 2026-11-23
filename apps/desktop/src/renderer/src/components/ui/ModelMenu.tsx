import { useEffect, useState } from "react";
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
  const availability = options.map(({ value, disabled }) => `${value}:${!!disabled}`).join("|");
  useEffect(() => { setOpen(false); }, [availability, disabled]);
  const name = triggerLabel ?? options.find((option) => option.value === value)?.label ?? "Select model";
  const available = options.filter((option) => !option.disabled);
  const unavailable = options.filter((option) => option.disabled);
  const renderOption = (option: ModelMenuOption) => <DropdownRadioItem key={option.value} value={option.value}
    label={option.label} aria-label={option.label} aria-description={option.description} disabled={option.disabled}>
    <span className="ui-popup-label">{option.label}</span>
    {option.description ? <span className="ui-model-menu-note" aria-hidden="true">{option.description}</span>
      : option.value === value ? <Check size={14} aria-hidden="true" /> : null}
  </DropdownRadioItem>;

  return <Dropdown label={label} className={`ui-model-menu ${className}`} side="top" align="end" triggerTooltip={name}
    open={open && !disabled} onOpenChange={(next) => {
      if (next) onOpen?.();
      setOpen(next);
    }}
    trigger={<Button variant="ghost" className={`composer-model-trigger ${triggerClassName}`}
      aria-label={`${label}: ${name}`} disabled={disabled}>
      <span>{name}</span><ChevronDown size={13} aria-hidden="true" />
    </Button>}>
    <div className="ui-model-menu-options">
      <DropdownRadioGroup value={value} onValueChange={onChange}>
        {available.length > 0 && unavailable.length > 0 ? <>
          <DropdownGroup label="Available">{available.map(renderOption)}</DropdownGroup>
          <DropdownSeparator />
          <DropdownGroup label="Unavailable">{unavailable.map(renderOption)}</DropdownGroup>
        </> : options.map(renderOption)}
      </DropdownRadioGroup>
    </div>
    <DropdownSeparator />
    <DropdownItem onClick={onManageModels}>Manage models</DropdownItem>
  </Dropdown>;
}
