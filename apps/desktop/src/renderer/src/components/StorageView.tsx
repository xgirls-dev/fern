import Database from "lucide-react/dist/esm/icons/database.mjs";
import HardDrive from "lucide-react/dist/esm/icons/hard-drive.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clearGenerationCache, fetchStorageStatus } from "../lib/api";
import { notify } from "../lib/notifications";
import { saveWorkspaceBackup, type WorkspaceBackupSnapshot } from "../lib/workspaceBackup";
import type { WorkspaceBackupPreview, WorkspaceList } from "../../../preload/types";
import type { StorageStatus } from "../lib/types";
import { Dialog, DialogDescription, DialogTitle } from "./ui/Dialog";
import { Button, PageHeader } from "./ui/controls";

interface StorageViewProps {
  active: boolean;
  running: boolean;
  backupReady: boolean;
  captureBackup: () => WorkspaceBackupSnapshot;
  onResetLocalData: () => Promise<void>;
  onOpenModels: () => void;
}

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${numberFormatter.format(value)} ${units[index]}`;
}

function storedPreferenceBytes(): number {
  try {
    let bytes = 0;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("fern-") && !key?.startsWith("iris-")) continue;
      bytes += new TextEncoder().encode(key + (localStorage.getItem(key) ?? "")).byteLength;
    }
    return bytes;
  } catch {
    return 0;
  }
}

export function StorageView({
  active,
  running,
  backupReady,
  captureBackup,
  onResetLocalData,
  onOpenModels,
}: StorageViewProps) {
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"backup" | "inspect" | "restore" | "switch" | "cache" | "reset" | null>(null);
  const [preview, setPreview] = useState<WorkspaceBackupPreview | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceList | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const restoreCancel = useRef<HTMLButtonElement>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const resetConfirmation = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const preferenceBytes = useMemo(
    () => (active ? storedPreferenceBytes() : 0),
    [active, storage],
  );

  const refreshStorage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStorage(await fetchStorageStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read local storage usage.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    setConfirmingReset(false);
    void refreshStorage();
    let current = true;
    void window.studio.listWorkspaces().then((list) => {
      if (!current || !list) return;
      setWorkspaces(list);
      setSelectedWorkspace(list.active);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [active, refreshStorage]);

  useLayoutEffect(() => {
    if (confirmingReset) resetConfirmation.current?.scrollIntoView({ block: "nearest" });
  }, [confirmingReset]);

  useEffect(() => {
    if (!confirmingReset || action) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setConfirmingReset(false);
      requestAnimationFrame(() => resetTrigger.current?.focus());
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [confirmingReset, action]);

  const workspaceError = (cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "";
    notify(message || fallback, "error");
  };

  const createBackup = async () => {
    setAction("backup");
    try {
      if (await saveWorkspaceBackup(captureBackup())) notify("Workspace backup saved.");
    } catch (cause) {
      workspaceError(cause, "Could not save the workspace backup.");
    } finally {
      setAction(null);
    }
  };

  const chooseBackup = async () => {
    setAction("inspect");
    try { setPreview(await window.studio.chooseWorkspaceBackup()); }
    catch (cause) { workspaceError(cause, "Could not open this workspace backup."); }
    finally { setAction(null); }
  };

  const restoreBackup = async () => {
    if (!preview) return;
    setAction("restore");
    try { await window.studio.restoreWorkspaceBackup(preview.token); }
    catch (cause) {
      workspaceError(cause, "Could not restore this workspace.");
      setAction(null);
    }
  };

  const openWorkspace = async () => {
    setAction("switch");
    try { await window.studio.switchWorkspace(selectedWorkspace); }
    catch (cause) {
      workspaceError(cause, "Could not switch workspaces.");
      setAction(null);
    }
  };

  const clearCache = async () => {
    setAction("cache");
    setError(null);
    try {
      const result = await clearGenerationCache();
      setStorage(result.storage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear the generation cache.");
    } finally {
      setAction(null);
    }
  };

  const resetData = async () => {
    setAction("reset");
    setError(null);
    try {
      await onResetLocalData();
      setConfirmingReset(false);
      await refreshStorage();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear local data.");
    } finally {
      setAction(null);
    }
  };

  const cancelReset = () => {
    setConfirmingReset(false);
    requestAnimationFrame(() => resetTrigger.current?.focus());
  };

  const diskUsedPercent = storage && storage.disk.totalBytes > 0
    ? Math.max(
        0,
        Math.min(
          100,
          ((storage.disk.totalBytes - storage.disk.freeBytes) / storage.disk.totalBytes) * 100,
        ),
      )
    : 0;

  return (
      <section
        className="shell-page storage-view" hidden={!active}
        aria-labelledby="storage-view-title"
      >
        <PageHeader className="shell-page-header" id="storage-view-title" title="Local data" description="Back up your workspace and manage Fern’s disk usage." />

        <div className="shell-page-body storage-body">
        {loading && !storage ? (
          <div className="data-dialog-loading" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>Calculating local storage…</span>
          </div>
        ) : null}

        {storage ? (
          <>
            <div className="disk-card">
              <div className="disk-card-heading">
                <span className="storage-icon">
                  <HardDrive size={16} aria-hidden="true" />
                </span>
                <div>
                  <strong>{formatBytes(storage.disk.freeBytes)} free</strong>
                  <span>of {formatBytes(storage.disk.totalBytes)}</span>
                </div>
              </div>
              <div
                className="disk-meter"
                role="meter"
                aria-label="Disk space used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(diskUsedPercent)}
              >
                <span style={{ width: `${diskUsedPercent}%` }} />
              </div>
              <p>
                {Math.round(diskUsedPercent)}% used. {formatBytes(Math.max(0, storage.disk.freeBytes - storage.disk.reserveBytes))} available to Fern after the {formatBytes(storage.disk.reserveBytes)} reserve.
              </p>
            </div>

            <div className="storage-grid">
              <article className="storage-card">
                <span className="storage-icon">
                  <Database size={16} aria-hidden="true" />
                </span>
                <div>
                  <span>Generation Cache</span>
                  <strong>{formatBytes(storage.cache.bytes)}</strong>
                  <small>
                    Expires after {storage.cache.retentionDays} days | capped at{" "}
                    {formatBytes(storage.cache.maxBytes)}
                  </small>
                </div>
              </article>
              <article className="storage-card">
                <span className="storage-icon">
                  <HardDrive size={16} aria-hidden="true" />
                </span>
                <div>
                  <span>Generated images</span>
                  <strong>{formatBytes(storage.images.bytes)}</strong>
                  <small>{storage.images.fileCount} PNG files</small>
                </div>
              </article>
              <article className="storage-card">
                <span className="storage-icon"><HardDrive size={16} aria-hidden="true" /></span>
                {storage.video ? <div><span>Video clips</span><strong>{formatBytes(storage.video.bytes)}</strong><small>{storage.video.fileCount} WebM files</small></div> : null}
                <div><span>Audio takes</span><strong>{formatBytes(storage.audio.bytes)}</strong><small>{storage.audio.fileCount} WAV files</small></div>
              </article>
              <article className="storage-card">
                <span className="storage-icon">
                  <ShieldCheck size={16} aria-hidden="true" />
                </span>
                <div>
                  <span>Prompts & Preferences</span>
                  <strong>{formatBytes(preferenceBytes + storage.metadata.bytes)}</strong>
                  <small>Settings and gallery metadata</small>
                </div>
              </article>
              <article className="storage-card">
                <span className="storage-icon">
                  <Database size={16} aria-hidden="true" />
                </span>
                <div>
                  <span>Downloaded models</span>
                  <strong>{formatBytes(storage.models.bytes)}</strong>
                  <Button variant="ghost" onClick={onOpenModels}>Manage models</Button>
                </div>
              </article>
            </div>
          </>
        ) : null}

        {error ? (
          <p className="dialog-error" role="alert">
            {error}
            <Button variant="ghost" disabled={loading || Boolean(action)} onClick={() => void refreshStorage()}>Retry</Button>
          </p>
        ) : null}

        <div className="data-actions">
          <div>
            <strong>Workspace Backup</strong>
            <p>Save chats, drafts, reply versions, saved attachments, media, and preferences in one file.</p>
            {running && <small>Finish active jobs before backing up or restoring.</small>}
            {workspaces?.error && <p role="alert">{workspaces.error}</p>}
            {action === "backup" && <small role="status">Saving workspace backup…</small>}
          </div>
          <div className="confirm-actions">
            <Button variant="secondary" disabled={!backupReady || running || Boolean(action)} onClick={() => void createBackup()}>
              Save Backup…
            </Button>
            <Button variant="secondary" disabled={running || Boolean(action) || Boolean(workspaces?.error)} onClick={() => void chooseBackup()}>
              {action === "inspect" ? "Opening backup…" : "Restore Backup…"}
            </Button>
          </div>
        </div>

        {workspaces && workspaces.items.length > 1 && <div className="data-actions">
          <div>
            <strong>Workspaces</strong>
            <p>Open another workspace with its own conversations, media, and model setup.</p>
          </div>
          <div className="confirm-actions">
            <select className="ui-field storage-workspace-select" aria-label="Workspace to open" value={selectedWorkspace}
              disabled={running || Boolean(action)} onChange={(event) => setSelectedWorkspace(event.target.value)}>
              {workspaces.items.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
            </select>
            <Button variant="secondary" disabled={running || Boolean(action) || workspaces.active === selectedWorkspace}
              onClick={() => void openWorkspace()}>{action === "switch" ? "Opening…" : "Open Workspace"}</Button>
          </div>
        </div>}

        {preview && <Dialog className="storage-restore-dialog" initialFocus={restoreCancel}
          onClose={() => { if (action !== "restore") setPreview(null); }}>
          <DialogTitle>Restore workspace</DialogTitle>
          <p><strong>{preview.name}</strong> · {formatBytes(preview.size)} · {preview.fileCount.toLocaleString()} saved files</p>
          <p>Saved {new Date(preview.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
          <DialogDescription>Fern will open this backup in a separate workspace. You can return to your current workspace from Local data.</DialogDescription>
          {action === "restore" && <p role="status">Checking and unpacking the backup…</p>}
          <div className="confirm-actions">
            <Button ref={restoreCancel} variant="secondary" disabled={action === "restore"} onClick={() => setPreview(null)}>Cancel</Button>
            <Button variant="primary" disabled={running || Boolean(action)} onClick={() => void restoreBackup()}>Restore and Restart</Button>
          </div>
        </Dialog>}

        <div className="data-actions">
          <div>
            <strong>Clear Generation Cache</strong>
            <p>Removes compiled generation cache files. The next generation may start more slowly.</p>
          </div>
          <Button
            variant="secondary"
            disabled={running || loading || Boolean(action)}
            onClick={() => void clearCache()}
          >
            {action === "cache" ? "Clearing…" : "Clear Cache"}
          </Button>
        </div>

        <div className="data-actions data-actions-danger">
          <div>
            <strong>Clear Local Data</strong>
            <p>Deletes generated images, audio takes, cache, thread history, prompts, and preferences.</p>
          </div>
          {!confirmingReset ? (
            <Button
              ref={resetTrigger}
              variant="danger"
              disabled={running || loading || Boolean(action)}
              onClick={() => setConfirmingReset(true)}
            >
              Clear Local Data
            </Button>
          ) : null}
        </div>
        {confirmingReset ? (
          <div ref={resetConfirmation} className="storage-reset-confirm" role="group" aria-labelledby="storage-reset-confirm-title">
            <div>
              <strong id="storage-reset-confirm-title">Delete local data?</strong>
              <p>This permanently deletes your generated files and thread history. Downloaded models and runtimes stay installed.</p>
            </div>
            <div className="confirm-actions">
              <Button variant="secondary" autoFocus disabled={Boolean(action)} onClick={cancelReset}>Cancel</Button>
              <Button variant="danger" disabled={running || loading || Boolean(action)} onClick={() => void resetData()}>
                <Trash2 size={13} aria-hidden="true" />
                {action === "reset" ? "Deleting…" : "Delete local data"}
              </Button>
            </div>
          </div>
        ) : null}

        <footer className="data-dialog-footer">
          Downloaded models and bundled runtimes stay installed.
        </footer>
        </div>
      </section>
  );
}
