import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImageRecord } from "../lib/types";
import { resolveAssetUrl } from "../lib/api";
import { notify } from "../lib/notifications";
import { useModalFocus } from "../hooks/useModalFocus";

export function ImageActions({
  image,
  onRemix,
  onRemixInNewThread,
  onDelete,
  compact = false,
}: {
  image: ImageRecord;
  onRemix: (image: ImageRecord) => void;
  onRemixInNewThread: (image: ImageRecord) => void;
  onDelete: (image: ImageRecord) => Promise<void>;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const menuContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menuOpen || !menu.current || !menuContent.current) return;
    const anchor = menu.current
      .querySelector("summary")!
      .getBoundingClientRect();
    const bounds = menuContent.current.getBoundingClientRect();
    const safeTop =
      document.querySelector(".titlebar")?.getBoundingClientRect().bottom ?? 0;
    const top =
      anchor.bottom + 6 + bounds.height <= window.innerHeight - 12
        ? anchor.bottom + 6
        : Math.max(safeTop + 12, anchor.top - bounds.height - 6);
    setMenuPosition({
      top,
      right: Math.max(
        12,
        Math.min(
          window.innerWidth - anchor.right,
          window.innerWidth - bounds.width - 12,
        ),
      ),
    });
  }, [menuOpen]);
  useModalFocus(confirm, dialog, () => {
    if (!busy) setConfirm(false);
  });
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      setMenuOpen(false);
      setMenuPosition(null);
    };
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);
  async function run(task: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true);
    setMenuOpen(false);
    setMenuPosition(null);
    try {
      const result = await task();
      if (result !== false) notify(message);
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Could not complete that action. Try again.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    run(async () => {
      const path = await window.studio.saveImageAs(image.name);
      if (!path) return false;
      await window.studio.writeImageFile(
        path,
        resolveAssetUrl(image.url, image.mtime),
      );
    }, "Image saved.");
  return (
    <div
      className="image-actions"
      aria-label={`Actions for ${image.name}`}
      aria-busy={busy}
    >
      {!compact ? (
        <>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => void save()}
          >
            Save image
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => onRemix(image)}
          >
            Remix
          </button>
        </>
      ) : null}
      <details
        ref={menu}
        open={menuOpen}
        className="image-menu"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setMenuOpen(false);
            setMenuPosition(null);
            menu.current?.querySelector("summary")?.focus();
          }
        }}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            setMenuPosition(null);
            setMenuOpen((open) => !open);
          }}
          className="btn btn-secondary"
          aria-label={`Image actions for ${image.name}`}
        >
          {compact ? "Actions" : "More"} ▾
        </summary>
        <div
          className="image-menu-content"
          ref={menuContent}
          style={{
            position: "fixed",
            top: menuPosition?.top ?? 0,
            right: menuPosition?.right ?? 0,
            visibility: menuPosition ? "visible" : "hidden",
          }}
        >
          {compact ? (
            <>
              <button type="button" disabled={busy} onClick={() => void save()}>
                Save image
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  setMenuPosition(null);
                  onRemix(image);
                }}
              >
                Remix
              </button>
            </>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMenuOpen(false);
              setMenuPosition(null);
              onRemixInNewThread(image);
            }}
          >
            Remix in new thread
          </button>
          <button
            type="button"
            disabled={busy || !image.prompt}
            onClick={() =>
              void run(
                () => window.studio.copyText(image.prompt ?? ""),
                "Prompt copied.",
              )
            }
          >
            Copy prompt
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  window.studio.copyText(
                    Object.entries({
                      Prompt: image.prompt,
                      Size: `${image.width} × ${image.height}`,
                      Seed: image.seed,
                      Steps: image.steps,
                      Guidance: image.guidance,
                      Device: image.device,
                      Reference:
                        image.referenceUsed == null
                          ? "Unknown"
                          : image.referenceUsed
                            ? "Used"
                            : "None",
                    })
                      .filter(([, value]) => value != null)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join("\n"),
                  ),
                "Settings copied.",
              )
            }
          >
            Copy settings
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const error = await window.studio.openOutputImage(image.name);
                if (error) throw new Error(error);
              }, "Opened image.")
            }
          >
            Open in default app
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const error = await window.studio.openOutputsFolder();
                if (error) throw new Error(error);
              }, "Opened output folder.")
            }
          >
            Open output folder
          </button>
          <button
            type="button"
            disabled={busy}
            className="danger-text"
            onClick={() => {
              setMenuOpen(false);
              setMenuPosition(null);
              setConfirm(true);
            }}
          >
            Delete image
          </button>
        </div>
      </details>
      {confirm
        ? createPortal(
            <div className="dialog-backdrop image-delete-backdrop">
              <div
                className="delete-image-dialog"
                ref={dialog}
                role="alertdialog"
                aria-modal="true"
                aria-label="Delete image"
                tabIndex={-1}
              >
                <h3>Move image to Recycle Bin?</h3>
                <p>{image.name}</p>
                <p>
                  It will disappear from Library and every thread. You can
                  restore the file from the Windows Recycle Bin.
                </p>
                <div className="image-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => setConfirm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await onDelete(image);
                        setConfirm(false);
                      }, "Image moved to Recycle Bin.")
                    }
                  >
                    {busy ? "Deleting…" : "Delete image"}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
