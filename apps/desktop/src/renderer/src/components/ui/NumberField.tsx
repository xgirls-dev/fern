import { useEffect, useId, useRef, useState } from "react";
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

export function NumberField({ label, value, min, max, integer = false, optional = false, hideLabel = false,
  disabled, placeholder, help, invalidHelp, onChange }: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState(() => displayDraft(value));
  const lastReported = useRef(value);
  useEffect(() => {
    if (value === lastReported.current) return;
    lastReported.current = value;
    setDraft(displayDraft(value));
  }, [value]);

  const accepts = (text: string, badInput: boolean) => {
    if (badInput) return false;
    if (text === "") return optional;
    const number = Number(text);
    return Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isInteger(number));
  };
  const valid = accepts(draft.text, draft.badInput);
  const hint = valid ? help : invalidHelp;

  return <label htmlFor={id}>
    <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    <Input id={id} type="number" inputMode={integer ? "numeric" : "decimal"} min={min} max={max} step={integer ? 1 : "any"}
      value={draft.text} disabled={disabled} placeholder={placeholder} aria-invalid={!valid}
      aria-describedby={hint ? id + "-help" : undefined}
      onBlur={() => {
        lastReported.current = value;
        setDraft(displayDraft(value));
      }}
      onChange={(event) => {
        const input = event.currentTarget;
        const { value: text, validity: { badInput }, valueAsNumber } = input;
        setDraft({ text, badInput });
        if (!accepts(text, badInput)) return;
        const next = text === "" ? undefined : valueAsNumber;
        lastReported.current = next;
        onChange(next);
      }} />
    {hint && <small id={id + "-help"} className={valid ? "text-setting-help" : "field-error"}>{hint}</small>}
  </label>;
}
