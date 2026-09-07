import { useEffect, useState } from "react";
import type { Notification } from "../lib/notifications";
export function Notifications() {
  const [items, setItems] = useState<Notification[]>([]);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const receive = (event: Event) => {
      const item = (event as CustomEvent<Notification>).detail;
      setItems((current) => [
        ...current.filter((old) => old.message !== item.message),
        item,
      ]);
      if (item.kind !== "error" && !item.action) {
        const timer = setTimeout(() => {
          setItems((current) => current.filter((old) => old.id !== item.id));
          timers.delete(timer);
        }, 5000);
        timers.add(timer);
      }
    };
    window.addEventListener("fern-notification", receive);
    return () => {
      window.removeEventListener("fern-notification", receive);
      timers.forEach(clearTimeout);
    };
  }, []);
  return (
    <aside className="notifications" aria-label="Notifications">
      {items.map((item) => (
        <div
          key={item.id}
          className={`notification is-${item.kind}`}
          role={item.kind === "error" ? "alert" : "status"}
        >
          <span>{item.message}</span>
          {item.action ? (
            <button
              type="button"
              onClick={() => {
                item.action!.run();
                setItems((current) =>
                  current.filter((old) => old.id !== item.id),
                );
              }}
            >
              {item.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() =>
              setItems((current) => current.filter((old) => old.id !== item.id))
            }
          >
            ×
          </button>
        </div>
      ))}
    </aside>
  );
}
