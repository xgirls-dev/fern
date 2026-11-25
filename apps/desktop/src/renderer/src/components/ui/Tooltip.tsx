import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { isComposingKey } from "../../lib/keyboard";
import { IconButton } from "./IconButton";

type TooltipSide = "top" | "right" | "bottom" | "left";
type TooltipPayload = { content: ReactNode; side: TooltipSide };
const SharedTooltip = createContext<BaseTooltip.Handle<TooltipPayload> | null>(null);

function preserveComposition(_open: boolean, details: BaseTooltip.Root.ChangeEventDetails) {
  if (details.reason === "escape-key" && isComposingKey(details.event)) {
    details.cancel();
    details.allowPropagation();
  }
}

function TooltipPopup({ content, side }: TooltipPayload) {
  return <BaseTooltip.Portal>
    <BaseTooltip.Positioner className="ui-tooltip-positioner" side={side} sideOffset={6}>
      <BaseTooltip.Popup className="ui-tooltip" role="tooltip">{content}</BaseTooltip.Popup>
    </BaseTooltip.Positioner>
  </BaseTooltip.Portal>;
}

export function TooltipScope({ children }: { children: ReactNode }) {
  const [handle] = useState(() => BaseTooltip.createHandle<TooltipPayload>());
  return <SharedTooltip.Provider value={handle}>
    {children}
    <BaseTooltip.Root handle={handle} onOpenChange={preserveComposition}>
      {({ payload }) => payload && <TooltipPopup {...payload} />}
    </BaseTooltip.Root>
  </SharedTooltip.Provider>;
}

export function Tooltip({ children, content, side = "top", dismissOn }: {
  children: ReactElement;
  content: ReactNode;
  side?: TooltipSide;
  dismissOn?: string;
}) {
  const handle = useContext(SharedTooltip);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (dismissOn !== undefined && trigger.current?.hasAttribute("data-popup-open")) handle?.close();
  }, [dismissOn, handle]);
  if (handle) return <BaseTooltip.Trigger ref={dismissOn === undefined ? undefined : trigger}
    handle={handle} payload={{ content, side }} render={children} delay={450} />;
  return <BaseTooltip.Root onOpenChange={preserveComposition}>
    <BaseTooltip.Trigger render={children} delay={450} />
    <TooltipPopup content={content} side={side} />
  </BaseTooltip.Root>;
}

export function TooltipIconButton({ tooltip, tooltipSide, dismissTooltipOn, ...button }: ComponentProps<typeof IconButton> & {
  tooltip: ReactNode;
  tooltipSide?: TooltipSide;
  dismissTooltipOn?: string;
}) {
  return <Tooltip content={tooltip} side={tooltipSide} dismissOn={dismissTooltipOn}><IconButton {...button} /></Tooltip>;
}
