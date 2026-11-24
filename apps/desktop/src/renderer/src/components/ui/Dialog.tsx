import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import type { ComponentProps, ReactNode } from "react";

type PopupProps = ComponentProps<typeof BaseDialog.Popup>;

export function Dialog({ children, onClose, className = "", variant = "default", initialFocus, finalFocus, alert = false }: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  variant?: "default" | "search";
  initialFocus?: PopupProps["initialFocus"];
  finalFocus?: PopupProps["finalFocus"];
  alert?: boolean;
}) {
  const Root = alert ? BaseAlertDialog.Root : BaseDialog.Root;
  return <Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className={`ui-dialog-backdrop${variant === "search" ? " ui-dialog-backdrop--search" : ""}`} />
      <BaseDialog.Viewport className="ui-dialog-viewport">
        <BaseDialog.Popup
          className={`ui-dialog${variant === "search" ? " ui-dialog--search" : ""}${alert ? " ui-dialog--alert" : ""} ${className}`}
          aria-modal="true"
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  </Root>;
}

export const DialogTitle = BaseDialog.Title;
export const DialogDescription = BaseDialog.Description;
export const DialogClose = BaseDialog.Close;
