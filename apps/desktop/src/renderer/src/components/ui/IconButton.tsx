import type { ComponentProps, Ref } from "react";

export function IconButton({ variant = "default", shape = "square", className = "", type = "button", ref, ...props }: ComponentProps<"button"> & {
  variant?: "default" | "primary" | "danger";
  shape?: "square" | "circle";
  ref?: Ref<HTMLButtonElement>;
}) {
  return <button ref={ref} type={type} className={`ui-icon-button ui-icon-button--${variant} ui-icon-button--${shape} ${className}`} {...props} />;
}
