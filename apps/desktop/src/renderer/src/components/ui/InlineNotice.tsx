import type { ReactNode } from "react";

export function InlineNotice({ children, actions, tone = "neutral", announce, className = "" }: {
  children: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "error";
  announce?: boolean;
  className?: string;
}) {
  return <div className={`ui-inline-notice ${className}`} data-tone={tone}>
    <div className="ui-inline-notice-message" role={announce ? "alert" : undefined}>
      {children}
    </div>
    {actions && <div className="ui-inline-notice-actions">{actions}</div>}
  </div>;
}
