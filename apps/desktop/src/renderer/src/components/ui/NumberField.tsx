import { useEffect, useId, useRef, useState, type ChangeEvent, type ComponentProps } from "react";
import { Input } from "./controls";

interface NumberFieldProps {
  label: string;
  value?: number;
  min: number;
  max: number;
  integer?: boolean;
  optional?: boolean;
  hideLabel?: boolean;
  disabled?: boolean;
  placeholder?: string;
  help?: string;
  invalidHelp?: string;
  onChange: (value: number | undefined) => void;
}

function displayDraft(value: number | undefined) {
  return { text: value?.toString() ?? "", badInput: false };
}

function useNumberDraft({ value, emptyValue, accepts, onChange }: {
  value: number | undefined;
  emptyValue?: number;
  accepts?: (value: number | undefined) => boolean;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(() => displayDraft(value));
  const lastReported = useRef(value);
  useEffect(() => {
    if (value === lastReported.current) return;
    lastReported.current = value;
    setDraft(displayDraft(value));
  }, [value]);

  const isValid = (number: number | undefined, badInput: boolean) =>
    !badInput && (number === undefined || Number.isFinite(number)) && (accepts?.(number) ?? true);
  const number = draft.text === "" ? emptyValue : Number(draft.text);
  return {
    valid: isValid(number, draft.badInput),
    inputProps: {
      value: draft.text,
      onBlur: () => {
        lastReported.current = value;
        setDraft(displayDraft(value));
      },
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        const { value: text, validity: { badInput }, valueAsNumber } = event.currentTarget;
        setDraft({ text, badInput });
        const next = text === "" ? emptyValue : valueAsNumber;
        if (!isValid(next, badInput)) return;
        lastReported.current = next;
        onChange(next);
      },
    },
  };
}

// The caller validates the complete setting, such as a model-specific image size.
export function NumberInput({ value, onChange, error, ...props }:
  Omit<ComponentProps<typeof Input>, "type" | "value" | "defaultValue" | "onChange" | "onBlur"> & {
    value: number;
    onChange: (value: number) => void;
    error?: string;
  }) {
  const id = useId();
  const errorId = `${props.id ?? props.name ?? id}-error`;
  const { valid, inputProps } = useNumberDraft({ value, emptyValue: 0, onChange: (next) => onChange(next ?? 0) });
  const description = [props["aria-describedby"], error ? errorId : undefined].filter(Boolean).join(" ") || undefined;
  return <>
    <Input inputMode="numeric" {...props} {...inputProps} type="number"
      aria-invalid={!!error || !valid} aria-describedby={description} />
    {error && <span className="field-error" id={errorId} role="alert">{error}</span>}
  </>;
}

export function NumberField({ label, value, min, max, integer = false, optional = false, hideLabel = false,
  disabled, placeholder, help, invalidHelp, onChange }: NumberFieldProps) {
  const id = useId();
  const { valid, inputProps } = useNumberDraft({
    value,
    onChange,
    accepts: (number) => number === undefined ? optional : number >= min && number <= max && (!integer || Number.isInteger(number)),
  });
  const hint = valid ? help : invalidHelp;

  return <label htmlFor={id}>
    <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    <Input id={id} type="number" inputMode={integer ? "numeric" : "decimal"} min={min} max={max} step={integer ? 1 : "any"}
      disabled={disabled} placeholder={placeholder} aria-invalid={!valid}
      aria-describedby={hint ? id + "-help" : undefined} {...inputProps} />
    {hint && <small id={id + "-help"} className={valid ? "text-setting-help" : "field-error"}>{hint}</small>}
  </label>;
}
