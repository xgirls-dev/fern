import { useEffect, useState } from "react";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { Notification } from "../lib/notifications";

function Toast({
  item,
  dismiss,
}: {
  item: Notification;
  dismiss: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(
      () => dismiss(item.id),
      item.action || item.kind === "error" ? 8000 : 5000,
    );
    return () => clearTimeout(timer);
  }, [item.id, item.action, item.kind, hovered, focused, dismiss]);
  return (
    <div
      className={`notification is-${item.kind}`}
      role={item.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setFocused(false);
      }}
    >
      <span>{item.message}</span>
      {item.action ? (
        <button
          type="button"
          onClick={() => {
            item.action!.run();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="notification-close"
        aria-label="Dismiss notification"
        onClick={() => dismiss(item.id)}
      >
        <X size={15} />
      </button>
    </div>
  );
}
export function Notifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [dismiss] = useState(
    () => (id: number) =>
      setItems((current) => current.filter((item) => item.id !== id)),
  );
  useEffect(() => {
    const receive = (event: Event) => {
      const item = (event as CustomEvent<Notification>).detail;
      setItems((current) =>
        [...current.filter((old) => old.message !== item.message), item].slice(
          -3,
        ),
      );
    };
    window.addEventListener("fern-notification", receive);
    return () => window.removeEventListener("fern-notification", receive);
  }, []);
  return (
    <aside className="notifications" aria-label="Notifications">
      {items.map((item) => (
        <Toast key={item.id} item={item} dismiss={dismiss} />
      ))}
    </aside>
  );
}
