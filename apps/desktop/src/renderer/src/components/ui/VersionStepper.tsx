import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import { TooltipIconButton } from "./Tooltip";

export function VersionStepper({ label, previousLabel, nextLabel, index, count, disabled, onChange }: {
  label: string;
  previousLabel: string;
  nextLabel: string;
  index: number;
  count: number;
  disabled?: boolean;
  onChange: (index: number) => void;
}) {
  const previousDisabled = !!disabled || index <= 0;
  const nextDisabled = !!disabled || index >= count - 1;
  return <div className="ui-version-stepper" role="group" aria-label={label}>
    <TooltipIconButton aria-label={previousLabel} tooltip={previousLabel} tooltipSide="bottom"
      aria-disabled={previousDisabled} onClick={() => { if (!previousDisabled) onChange(index - 1); }}>
      <ChevronLeft size={14} aria-hidden="true" />
    </TooltipIconButton>
    <span aria-hidden="true">{index + 1} / {count}</span>
    <TooltipIconButton aria-label={nextLabel} tooltip={nextLabel} tooltipSide="bottom"
      aria-disabled={nextDisabled} onClick={() => { if (!nextDisabled) onChange(index + 1); }}>
      <ChevronRight size={14} aria-hidden="true" />
    </TooltipIconButton>
    <span className="sr-only" role="status" aria-atomic="true">Version {index + 1} of {count}</span>
  </div>;
}
