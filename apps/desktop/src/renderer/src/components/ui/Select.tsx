import { Select as BaseSelect } from "@base-ui/react/select";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import type { ComponentProps } from "react";
import { Tooltip } from "./Tooltip";

type SelectValue = string | number;
type SelectOption<T> = { value: T; label: string; disabled?: boolean };

type SelectProps<T extends SelectValue> = Omit<ComponentProps<"button">, "onChange" | "value" | "children"> & {
  value: T | null;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  appearance?: "field" | "toolbar";
  triggerTooltip?: string;
  triggerTooltipSide?: ComponentProps<typeof Tooltip>["side"];
  finalFocus?: ComponentProps<typeof BaseSelect.Popup>["finalFocus"];
  popupContainer?: ComponentProps<typeof BaseSelect.Portal>["container"];
};

export function Select<T extends SelectValue>({
  value, options, onChange, placeholder = "Choose an option", appearance = "field",
  className = "", disabled, name, form, finalFocus, popupContainer, triggerTooltip, triggerTooltipSide, ...trigger
}: SelectProps<T>) {
  const emptyOptionLabel = value === "" ? options.find((option) => option.value === value)?.label : undefined;
  const selectTrigger = <BaseSelect.Trigger
    className={`ui-field ui-select ui-select--${appearance} ${className}`}
    {...trigger}
  >
    <BaseSelect.Value className="ui-select-value" placeholder={placeholder}>{emptyOptionLabel}</BaseSelect.Value>
    <BaseSelect.Icon className="ui-select-chevron"><ChevronDown size={14} aria-hidden="true" /></BaseSelect.Icon>
  </BaseSelect.Trigger>;
  return <BaseSelect.Root<T> value={value} items={options} name={name} form={form} disabled={disabled}
    modal={false} onValueChange={(next) => { if (next !== null) onChange(next); }}>
    {triggerTooltip ? <Tooltip content={triggerTooltip} side={triggerTooltipSide}>{selectTrigger}</Tooltip> : selectTrigger}
    <BaseSelect.Portal container={popupContainer}>
      <BaseSelect.Positioner className="ui-popup-positioner" align="start" side={appearance === "toolbar" ? "top" : "bottom"}
        sideOffset={5} alignItemWithTrigger={false}>
        <BaseSelect.Popup className="ui-popup ui-select-popup" finalFocus={finalFocus}>
          <BaseSelect.List className="ui-popup-list">
            {options.map((option) => <BaseSelect.Item className="ui-menu-item ui-popup-item" key={option.value}
              value={option.value} disabled={option.disabled} label={option.label}>
              <BaseSelect.ItemText className="ui-popup-label">{option.label}</BaseSelect.ItemText>
              <BaseSelect.ItemIndicator className="ui-popup-indicator"><Check size={14} aria-hidden="true" /></BaseSelect.ItemIndicator>
            </BaseSelect.Item>)}
          </BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  </BaseSelect.Root>;
}
