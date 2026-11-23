import type { ReactNode } from "react";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";

export function ProgressLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`ui-progress-label ${className}`}>
    <LoaderCircle className="spinner" size={15} aria-hidden="true" />
    <span>{children}</span>
  </span>;
}
