import Database from "lucide-react/dist/esm/icons/database.mjs";
import HardDrive from "lucide-react/dist/esm/icons/hard-drive.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clearGenerationCache, fetchStorageStatus } from "../lib/api";
import type { StorageStatus } from "../lib/types";
import { Button, PageHeader } from "./ui/controls";

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
        <PageHeader className="shell-page-header" id="storage-view-title" title="Local data" description="See what Fern stores and clean it up without opening system folders." />

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
                  <span>Generated images</span>
                  <strong>{formatBytes(storage.images.bytes)}</strong>
                  <small>{storage.images.fileCount} PNG files</small>
                </div>
              </article>
              <article className="storage-card">
                <span className="storage-icon"><HardDrive size={16} aria-hidden="true" /></span>
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
                  <small>Preserved when local data is cleared</small>
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
