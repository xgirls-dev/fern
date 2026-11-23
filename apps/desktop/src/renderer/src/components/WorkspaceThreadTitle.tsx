import { Select } from "./ui/Select";

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
      <Select appearance="icon" className={`workspace-thread-switcher${sidebarCollapsed ? " is-visible" : ""}`}
        aria-label={switchLabel} title={switchLabel} value={thread.id} onChange={onSwitch}
        options={threads.filter((item) => !item.archived || item.id === thread.id).map(({ id, title }) => ({ value: id, label: title }))} />
    </div>
  );
}
