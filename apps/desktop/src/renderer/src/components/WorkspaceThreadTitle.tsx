import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";

interface WorkspaceThreadTitleProps {
  id?: string;
  thread: { id: string; title: string };
  threads: readonly { id: string; title: string; archived?: boolean }[];
  switchLabel: string;
  sidebarCollapsed: boolean;
  onSwitch: (id: string) => void;
}

export function WorkspaceThreadTitle({ id, thread, threads, switchLabel, sidebarCollapsed, onSwitch }: WorkspaceThreadTitleProps) {
  return (
    <div className="workspace-thread-title">
      <h2 id={id} title={thread.title}>{thread.title}</h2>
      <label className={`ui-icon-button workspace-thread-switcher${sidebarCollapsed ? " is-visible" : ""}`}>
        <ChevronDown size={15} aria-hidden="true" />
        <select aria-label={switchLabel} title={switchLabel} value={thread.id} onChange={(event) => onSwitch(event.target.value)}>
          {threads.filter((item) => !item.archived || item.id === thread.id).map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
