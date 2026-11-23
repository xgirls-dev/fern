import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import type { ComponentProps, ReactNode } from "react";

type DisclosureProps = Omit<ComponentProps<"details">, "onToggle"> & {
  label: ReactNode;
  appearance?: "inline" | "section";
  lockOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function Disclosure({ label, appearance = "inline", className = "", lockOpen = false, open, onOpenChange,
  children, ...props }: DisclosureProps) {
  return <details {...props} className={`ui-disclosure ui-disclosure--${appearance} ${className}`} open={lockOpen || open}
    onToggle={onOpenChange ? (event) => {
      if (!lockOpen && event.target === event.currentTarget) onOpenChange(event.currentTarget.open);
    } : undefined}>
    <summary className="ui-disclosure-summary" aria-disabled={lockOpen || undefined}
      onClick={lockOpen ? (event) => event.preventDefault() : undefined}>
      <ChevronRight className="ui-disclosure-caret" size={14} aria-hidden="true" />
      <span>{label}</span>
    </summary>
    {children}
  </details>;
}
