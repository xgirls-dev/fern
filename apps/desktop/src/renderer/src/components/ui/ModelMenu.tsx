import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { matchesShortcut, shortcutAriaLabel, shortcutLabel, type Shortcut } from "../../lib/workspaceNavigation";
import { Button } from "./controls";
import { Dropdown, DropdownGroup, DropdownItem, DropdownRadioGroup, DropdownRadioItem, DropdownSeparator } from "./Dropdown";

export interface ModelMenuOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function ModelMenu({ label, value, options, disabled, triggerLabel, className = "", triggerClassName = "",
  keyboardShortcut, shortcutActive, onChange, onManageModels, onOpen }: {
  label: string;
  value: string;
  options: readonly ModelMenuOption[];
  disabled?: boolean;
  triggerLabel?: string;
  className?: string;
  triggerClassName?: string;
  keyboardShortcut?: Shortcut;
  shortcutActive?: boolean;
  onChange: (value: string) => void;
  onManageModels: () => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const shortcutOrigin = useRef<HTMLElement | null>(null);
  const navigated = useRef(false);
  const optionList = useRef<HTMLDivElement>(null);
  const manageAction = useRef<HTMLElement>(null);
  const focusedOption = useRef<string | undefined>(undefined);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const name = triggerLabel ?? options.find((option) => option.value === value)?.label ?? "Select model";
  const shortcutHint = keyboardShortcut && shortcutLabel(keyboardShortcut);
  const available = options.filter((option) => !option.disabled);
  const unavailable = options.filter((option) => option.disabled);
  const grouped = available.length > 0 && unavailable.length > 0;
  const defaultOption = useCallback(() => {
    const list = optionList.current;
    return list?.querySelector<HTMLElement>(`[data-model-option="${CSS.escape(value)}"]:not([aria-disabled="true"])`)
      ?? list?.querySelector<HTMLElement>('[data-model-option]:not([aria-disabled="true"])')
      ?? manageAction.current;
  }, [value]);

  useEffect(() => {
    if (!keyboardShortcut || !shortcutActive || disabled || open) return;
    const openFromKeyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !matchesShortcut(event, keyboardShortcut)
        || document.querySelector('[aria-modal="true"]')) return;
      const origin = document.activeElement;
      if (origin?.closest('[role="menu"], [role="listbox"], [aria-expanded="true"][aria-haspopup="menu"]')
        || !trigger.current?.getClientRects().length) return;
      event.preventDefault();
      shortcutOrigin.current = origin instanceof HTMLElement && origin !== document.body ? origin : trigger.current;
      trigger.current.click();
    };
    window.addEventListener("keydown", openFromKeyboard);
    return () => window.removeEventListener("keydown", openFromKeyboard);
  }, [disabled, keyboardShortcut, open, shortcutActive]);

  useLayoutEffect(() => {
    const list = optionList.current;
    const previous = focusedOption.current;
    if (!open || disabled || !list || previous === undefined || document.activeElement !== document.body) return;
    // Availability can move a focused model to another group and replace its DOM node.
    const item = list.querySelector<HTMLElement>(`[data-model-option="${CSS.escape(previous)}"]`) ?? defaultOption();
    item?.focus();
  }, [defaultOption, disabled, open, options]);

  const renderOption = (option: ModelMenuOption) => <DropdownRadioItem key={option.value} value={option.value}
    data-model-option={option.value} label={option.label} aria-label={option.label}
    aria-description={option.description} disabled={option.disabled}>
    <span className="ui-popup-label">{option.label}</span>
    {option.description ? <span className="ui-model-menu-note" aria-hidden="true">{option.description}</span> : null}
    {option.value === value && !option.disabled ? <Check size={14} aria-hidden="true" /> : null}
  </DropdownRadioItem>;

  return <Dropdown label={label} className={`ui-model-menu ${className}`} side="top" align="end"
    triggerTooltip={shortcutHint ? `${name} · ${shortcutHint}` : name}
    finalFocus={shortcutOrigin.current ? () => {
      const origin = shortcutOrigin.current;
      shortcutOrigin.current = null;
      return origin?.isConnected ? origin : false;
    } : undefined}
    open={open && !disabled} onOpenChange={(next, { reason }) => {
      focusedOption.current = undefined;
      navigated.current = false;
      if (next) onOpen?.();
      else if (reason !== "escape-key" && reason !== "item-press") shortcutOrigin.current = null;
      setOpen(next);
    }}
    onItemHighlighted={(_, { reason }) => { if (reason !== "none") navigated.current = true; }}
    onOpenChangeComplete={(next) => {
      if (next && shortcutOrigin.current && !navigated.current) defaultOption()?.focus();
    }}
    trigger={<Button ref={trigger} variant="ghost" className={`composer-model-trigger ${triggerClassName}`}
      aria-label={`${label}: ${name}`} disabled={disabled}
      aria-keyshortcuts={keyboardShortcut && shortcutAriaLabel(keyboardShortcut)}>
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
