import type { ReactNode } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { Button } from "./ui/controls";
import { Dropdown, DropdownRadioGroup, DropdownRadioItem, DropdownSeparator } from "./ui/Dropdown";

export function TextMenu({ label, value, options, onSelect, disabled, children }: {
  label: string;
  value: string;
  options: { value: string; label: string; description?: string; disabled?: boolean }[];
  onSelect: (value: string) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const displayedName = options.find((option) => option.value === value)?.label ?? "Select model";
  return <Dropdown label={label} className="text-model-dropdown" side="top" align="end"
    trigger={<Button variant="ghost" className="composer-model-trigger text-menu-trigger"
      aria-label={`${label}: ${displayedName}`} title={displayedName} disabled={disabled}>
      <span>{displayedName}</span><ChevronDown size={13} aria-hidden="true" />
    </Button>}
  >
    <DropdownRadioGroup value={value} onValueChange={onSelect}>
      {options.map((option) => <DropdownRadioItem key={option.value} value={option.value} disabled={option.disabled} label={option.label}>
        <span className="ui-popup-label">{option.label}</span>
        {option.description ? <span className="composer-model-unavailable">{option.description}</span>
          : option.value === value ? <Check size={14} aria-hidden="true" /> : null}
      </DropdownRadioItem>)}
    </DropdownRadioGroup>
    {children && <><DropdownSeparator />{children}</>}
  </Dropdown>;
}
