import Database from "lucide-react/dist/esm/icons/database.mjs";
import HardDrive from "lucide-react/dist/esm/icons/hard-drive.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clearGenerationCache, fetchStorageStatus } from "../lib/api";
import type { StorageStatus } from "../lib/types";

interface StorageViewProps {
  active: boolean;
  running: boolean;
  onResetLocalData: () => Promise<void>;
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
  onResetLocalData,
}: StorageViewProps) {
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"cache" | "reset" | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
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
  }, [active, refreshStorage]);


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

  const diskUsedPercent = storage
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
        <header className="shell-page-header">
          <div>
            <h2 tabIndex={-1} id="storage-view-title">Local data</h2>
            <p>See what Fern stores and clean it up without opening system folders.</p>
          </div>

        </header>

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
                Fern protects a {formatBytes(storage.disk.reserveBytes)} free-space reserve.
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
                  <span>Generated Images</span>
                  <strong>{formatBytes(storage.outputs.bytes)}</strong>
                  <small>{storage.outputs.fileCount} local files</small>
                </div>
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
                  <span>Downloaded Model</span>
                  <strong>{formatBytes(storage.models.bytes)}</strong>
                  <small>Preserved when local data is cleared</small>
                </div>
              </article>
            </div>
          </>
        ) : null}

        {error ? (
          <p className="dialog-error" role="alert">
            {error}
            <button type="button" className="text-action" disabled={loading || Boolean(action)} onClick={() => void refreshStorage()}>Retry</button>
          </p>
        ) : null}

        <div className="data-actions">
          <div>
            <strong>Clear Generation Cache</strong>
            <p>Removes compiled generation cache files. The next generation may start more slowly.</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={running || loading || Boolean(action)}
            onClick={() => void clearCache()}
          >
            {action === "cache" ? "Clearing…" : "Clear Cache"}
          </button>
        </div>

        <div className="data-actions data-actions-danger">
          <div>
            <strong>Clear Local Data</strong>
            <p>Deletes generated images, cache, prompts, gallery history, and preferences.</p>
          </div>
          {confirmingReset ? (
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={Boolean(action)}
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={running || loading || Boolean(action)}
                onClick={() => void resetData()}
              >
                <Trash2 size={13} aria-hidden="true" />
                {action === "reset" ? "Deleting…" : "Delete Local Data"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-danger-outline"
              disabled={running || loading || Boolean(action)}
              onClick={() => setConfirmingReset(true)}
            >
              Clear Local Data
            </button>
          )}
        </div>

        <footer className="data-dialog-footer">
          The model and bundled runtime stay installed, so Fern remains ready to generate.
        </footer>
        </div>
      </section>
  );
}

