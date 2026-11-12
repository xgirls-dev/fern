import type { ComponentProps, ReactNode, Ref } from "react";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

/** Shared interactive primitives. Keep their dimensions and states in design-system.css. */
export function Button({ variant = "secondary", className = "", type = "button", ...props }: ButtonProps) {
  return <button type={type} className={`ui-button ui-button--${variant} ${className}`} {...props} />;
}

export function IconButton({ variant = "default", shape = "square", className = "", type = "button", ref, ...props }: ComponentProps<"button"> & {
  variant?: "default" | "primary" | "danger";
  shape?: "square" | "circle";
  ref?: Ref<HTMLButtonElement>;
}) {
  return <button ref={ref} type={type} className={`ui-icon-button ui-icon-button--${variant} ui-icon-button--${shape} ${className}`} {...props} />;
}

export function MenuItem({ destructive = false, className = "", type = "button", ref, ...props }: ComponentProps<"button"> & { destructive?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return <button ref={ref} type={type} className={`ui-menu-item${destructive ? " ui-menu-item--danger" : ""} ${className}`} {...props} />;
}

export function Checkbox({ className = "", ...props }: Omit<ComponentProps<"input">, "type">) {
  return <input type="checkbox" className={`ui-checkbox ${className}`} {...props} />;
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input className={`ui-field ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea className={`ui-textarea ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <select className={`ui-field ui-select ${className}`} {...props} />;
}

export function ChoiceCard({ selected, className = "", ...props }: ComponentProps<"button"> & { selected: boolean }) {
  return <button type="button" className={`ui-choice-card${selected ? " is-selected" : ""} ${className}`} aria-pressed={selected} {...props} />;
}

export function ToggleRow({ icon, title, description, pressed, onClick, className = "" }: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  pressed: boolean;
  onClick: () => void;
  className?: string;
}) {
  return <button type="button" className={`ui-toggle-row ${className}`} onClick={onClick} aria-pressed={pressed}>
    <span className="ui-toggle-row-icon" aria-hidden="true">{icon}</span>
    <span className="ui-toggle-row-copy"><strong>{title}</strong><small>{description}</small></span>
    <span className={`ui-toggle-switch${pressed ? " is-on" : ""}`} aria-hidden="true"><span /></span>
  </button>;
}

export function NavigationButton({ selected = false, className = "", ...props }: ComponentProps<"button"> & { selected?: boolean }) {
  return <button type="button" className={`ui-nav-button${selected ? " is-active" : ""} ${className}`} aria-current={selected ? "page" : undefined} {...props} />;
}

export function ToggleChip({ selected, className = "", ...props }: ComponentProps<"button"> & { selected: boolean }) {
  return <button type="button" className={`ui-chip${className ? ` ${className}` : ""}`} aria-pressed={selected} {...props} />;
}

export function SegmentedControl<T extends string>({ label, value, options, onChange, className = "" }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return <div className={`ui-segmented ${className}`} role="group" aria-label={label}>
    {options.map((option) => <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

export function PageHeader({ id, title, description, actions, titleRef, className = "" }: {
  id: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
  className?: string;
}) {
  return <header className={`ui-page-header ${className}`}><div><h2 id={id} ref={titleRef} tabIndex={-1}>{title}</h2><p>{description}</p></div>{actions}</header>;
}

export function ModelCard({ className = "", ...props }: ComponentProps<"article">) {
  return <article className={`ui-model-card model-library-card ${className}`} {...props} />;
}

export function ModelCardHeading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="ui-model-card-heading model-library-card-heading"><span className="ui-model-icon" aria-hidden="true">{icon}</span><div className="ui-model-title">{children}</div></div>;
}

export function ModelCardActions({ children }: { children: ReactNode }) {
  return <div className="ui-model-actions model-library-actions">{children}</div>;
}

export function InlineConfirmation({ children, confirmLabel, disabled = false, cancelDisabled = false, onCancel, onConfirm }: {
  children: ReactNode;
  confirmLabel: string;
  disabled?: boolean;
  cancelDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="ui-inline-confirmation" role="group" aria-label="Confirm removal" onKeyDown={(event) => {
    if (event.key === "Escape" && !cancelDisabled) { event.stopPropagation(); onCancel(); }
  }}>
    <p>{children}</p>
    <div className="ui-inline-confirmation-actions">
      <Button autoFocus disabled={cancelDisabled} onClick={onCancel}>Cancel</Button>
      <Button variant="danger" disabled={disabled} onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  </div>;
}

export function ModelStatus({ installed, children, ...props }: ComponentProps<"p"> & { installed?: boolean }) {
  return <p className={`ui-model-status model-library-status${installed ? " is-installed" : ""}`} role="status" {...props}>{children}</p>;
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  return <p className="ui-error-message" role="alert">{children}</p>;
}
