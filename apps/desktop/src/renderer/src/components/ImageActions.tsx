import { trashName } from "../lib/trash";
import { useRef, useState, type RefObject } from "react";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal.mjs";
import type { ImageRecord } from "../lib/types";
import { resolveAssetUrl } from "../lib/api";
import { notify } from "../lib/notifications";
import { Button, IconButton } from "./ui/controls";
import { Dialog, DialogDescription, DialogTitle } from "./ui/Dialog";
import { Dropdown, DropdownItem, DropdownSeparator, useDropdownActions } from "./ui/Dropdown";

export function ImageActions({
  image,
  onRemix,
  onRemixInNewThread,
  onDelete,
  compact = false,
  menuContainer,
}: {
  image: ImageRecord;
  onRemix: (image: ImageRecord) => void;
  onRemixInNewThread: (image: ImageRecord) => void;
  onDelete: (image: ImageRecord) => Promise<void>;
  compact?: boolean;
  menuContainer?: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [collisionTop, setCollisionTop] = useState(8);
  const [confirm, setConfirm] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const { trigger, choose, menuProps } = useDropdownActions({ dismissOnResize: true });

  async function run(task: () => Promise<unknown>, message: string, onError?: (message: string) => void) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await task();
      if (result !== false) notify(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not complete that action. Try again.";
      if (onError) onError(detail);
      else notify(detail, "error");
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
      role="group"
      aria-label={`Actions for ${image.name}`}
      aria-busy={busy}
    >
      {!compact ? (
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void save()}
          >
            Save image
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onRemix(image)}
          >
            Remix
          </Button>
        </>
      ) : null}
      <Dropdown
        align="end"
        side={menuContainer ? "top" : "bottom"}
        label="Image actions"
        triggerTooltip="Image actions"
        portalContainer={menuContainer}
        collisionPadding={{ top: collisionTop, right: 8, bottom: 8, left: 8 }}
        {...menuProps}
        onOpenChange={(open) => {
          if (open) setCollisionTop((document.querySelector(".titlebar")?.getBoundingClientRect().bottom ?? 0) + 8);
          menuProps.onOpenChange(open);
        }}
        trigger={<IconButton ref={trigger} className="image-menu-trigger" aria-label={`Image actions for ${image.name}`}>
          <MoreHorizontal size={16} aria-hidden="true" />
        </IconButton>}
      >
        {compact && <>
          <DropdownItem disabled={busy} onClick={() => choose(() => void save())}>Save image</DropdownItem>
          <DropdownItem disabled={busy} onClick={() => choose(() => onRemix(image))}>Remix</DropdownItem>
        </>}
        <DropdownItem disabled={busy} onClick={() => choose(() => onRemixInNewThread(image))}>
          Remix in new thread
        </DropdownItem>
        <DropdownItem disabled={busy || !image.prompt} onClick={() => choose(() =>
          void run(() => window.studio.copyText(image.prompt ?? ""), "Prompt copied."),
        )}>
          Copy prompt
        </DropdownItem>
        <DropdownItem disabled={busy} onClick={() => choose(() =>
          void run(() => window.studio.copyText(
            Object.entries({
              Prompt: image.prompt,
              Size: `${image.width} × ${image.height}`,
              Seed: image.seed,
              Steps: image.steps,
              Guidance: image.guidance,
              Device: image.device,
              Reference: image.referenceUsed == null ? "Unknown" : image.referenceUsed ? "Used" : "None",
            })
              .filter(([, value]) => value != null)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n"),
          ), "Settings copied."),
        )}>
          Copy settings
        </DropdownItem>
        <DropdownItem disabled={busy} onClick={() => choose(() => void run(async () => {
          const error = await window.studio.openOutputImage(image.name);
          if (error) throw new Error(error);
        }, "Opened image."))}>
          Open in default app
        </DropdownItem>
        <DropdownItem disabled={busy} onClick={() => choose(() => void run(async () => {
          const error = await window.studio.openOutputsFolder();
          if (error) throw new Error(error);
        }, "Opened output folder."))}>
          Open output folder
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem disabled={busy} destructive onClick={() => choose(() => {
          setDeleteError("");
          setConfirm(true);
        })}>
          Delete image
        </DropdownItem>
      </Dropdown>
      {confirm && <Dialog alert initialFocus={cancelDelete} finalFocus={trigger}
        onClose={() => { if (!busy) setConfirm(false); }}>
        <DialogTitle>Move image to {trashName}?</DialogTitle>
        <DialogDescription>
          <strong>{image.name}</strong>
          It will disappear from Library and every thread. You can restore the file from {trashName}.
        </DialogDescription>
        {deleteError && <p role="alert">{deleteError}</p>}
        <div className="ui-dialog-actions">
          <Button ref={cancelDelete} variant="secondary" disabled={busy} onClick={() => setConfirm(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void run(async () => {
            setDeleteError("");
            await onDelete(image);
            setConfirm(false);
          }, `Image moved to ${trashName}.`, setDeleteError)}>
            {busy ? "Deleting…" : "Delete image"}
          </Button>
        </div>
      </Dialog>}
    </div>
  );
}
