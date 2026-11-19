const workspaceKey = "fern-last-workspace:v1";
type Workspace = "create" | "text" | "tts" | "library";

function isWorkspace(value: unknown): value is Workspace {
  return value === "create" || value === "text" || value === "tts" || value === "library";
}

export function loadLastWorkspace(): Workspace {
  try {
    const value = localStorage.getItem(workspaceKey);
    if (isWorkspace(value)) return value;
    // Profiles from before workspace restoration may already have image drafts.
    return localStorage.getItem("fern-threads:v1") ? "create" : "text";
  } catch {
    return "text";
  }
}

export function saveLastWorkspace(value: string) {
  if (!isWorkspace(value)) return;
  try {
    localStorage.setItem(workspaceKey, value);
  } catch {
    // Navigation remains available without persistence.
  }
}

export const shortcuts = {
  commands: { key: "k", label: "Open commands", shift: false, alt: false },
  image: { key: "n", label: "Create image", shift: false, alt: false },
  speech: { key: "n", label: "Create speech", shift: true, alt: false },
  chat: { key: "n", label: "Chat", shift: false, alt: true },
  images: { key: "l", label: "Open Images", shift: false, alt: false },
  sidebar: { key: "b", label: "Toggle sidebar", shift: false, alt: false },
} as const;

type Shortcut = (typeof shortcuts)[keyof typeof shortcuts];

export function shortcutLabel(shortcut: Shortcut): string {
  return [
    window.studio.platform === "darwin" ? "Cmd" : "Ctrl",
    shortcut.shift && "Shift", shortcut.alt && "Alt", shortcut.key.toUpperCase(),
  ].filter(Boolean).join(" ");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  return (event.metaKey || event.ctrlKey) && !event.isComposing &&
    event.key.toLowerCase() === shortcut.key && event.shiftKey === shortcut.shift && event.altKey === shortcut.alt;
}
