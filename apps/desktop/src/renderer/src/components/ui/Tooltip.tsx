import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { createContext, useContext, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { IconButton } from "./IconButton";

type TooltipSide = "top" | "right" | "bottom" | "left";
type TooltipPayload = { content: ReactNode; side: TooltipSide };
const SharedTooltip = createContext<BaseTooltip.Handle<TooltipPayload> | null>(null);

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
    <BaseTooltip.Root handle={handle}>
      {({ payload }) => payload && <TooltipPopup {...payload} />}
    </BaseTooltip.Root>
  </SharedTooltip.Provider>;
}

export function Tooltip({ children, content, side = "top" }: {
  children: ReactElement;
  content: ReactNode;
  side?: TooltipSide;
}) {
  const handle = useContext(SharedTooltip);
  if (handle) return <BaseTooltip.Trigger handle={handle} payload={{ content, side }} render={children} delay={450} />;
  return <BaseTooltip.Root>
    <BaseTooltip.Trigger render={children} delay={450} />
    <TooltipPopup content={content} side={side} />
  </BaseTooltip.Root>;
}

export function TooltipIconButton({ tooltip, tooltipSide, ...button }: ComponentProps<typeof IconButton> & {
  tooltip: ReactNode;
  tooltipSide?: TooltipSide;
}) {
  return <Tooltip content={tooltip} side={tooltipSide}><IconButton {...button} /></Tooltip>;
}
