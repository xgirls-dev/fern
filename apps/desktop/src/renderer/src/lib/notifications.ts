export interface Notification {
  id: number;
  message: string;
  kind: "success" | "error" | "info";
  action?: { label: string; run: () => void };
}
let sequence = 0;
export function notify(
  message: string,
  kind: Notification["kind"] = "success",
  action?: Notification["action"],
) {
  window.dispatchEvent(
    new CustomEvent("fern-notification", {
      detail: { id: ++sequence, message, kind, action },
    }),
  );
}
