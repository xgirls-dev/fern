import { Menu } from "@base-ui/react/menu";
import { createContext, useContext, useRef, useState, type ReactNode, type RefObject } from "react";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal.mjs";
import { trashName } from "../lib/trash";
import type { ImageRecord } from "../lib/types";
import { resolveAssetUrl } from "../lib/api";
import { notify } from "../lib/notifications";
import { Button, IconButton } from "./ui/controls";
import { Dialog, DialogDescription, DialogTitle } from "./ui/Dialog";
import { Dropdown, DropdownItem, DropdownPopup, DropdownSeparator, useDropdownActions } from "./ui/Dropdown";
import { Tooltip, TooltipScope } from "./ui/Tooltip";

type ImageHandlers = {
  onRemix: (image: ImageRecord) => void;
  onRemixInNewThread: (image: ImageRecord) => void;
  onDelete: (image: ImageRecord) => Promise<void>;
};

function useImageOperations(onDelete: ImageHandlers["onDelete"]) {
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ image: ImageRecord; trigger: HTMLButtonElement | null }>();
  const [deleteError, setDeleteError] = useState("");
  const cancelDelete = useRef<HTMLButtonElement>(null);

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

  const save = (image: ImageRecord) => void run(async () => {
    const path = await window.studio.saveImageAs(image.name);
    if (!path) return false;
    await window.studio.writeImageFile(path, resolveAssetUrl(image.url, image.mtime));
  }, "Image saved.");

  const confirm = (image: ImageRecord, trigger: HTMLButtonElement | null) => {
    setDeleteError("");
    setConfirmation({ image, trigger });
  };

  const dialog = confirmation && <Dialog alert initialFocus={cancelDelete} finalFocus={() => confirmation.trigger ?? true}
    onClose={() => { if (!busy) setConfirmation(undefined); }}>
    <DialogTitle>Move image to {trashName}?</DialogTitle>
    <DialogDescription>
      <strong>{confirmation.image.name}</strong>
      It will disappear from Library and every thread. You can restore the file from {trashName}.
    </DialogDescription>
    {deleteError && <p role="alert">{deleteError}</p>}
    <div className="ui-dialog-actions">
      <Button ref={cancelDelete} variant="secondary" disabled={busy} onClick={() => setConfirmation(undefined)}>Cancel</Button>
      <Button variant="danger" disabled={busy} onClick={() => void run(async () => {
        setDeleteError("");
        await onDelete(confirmation.image);
        setConfirmation(undefined);
      }, `Image moved to ${trashName}.`, setDeleteError)}>
        {busy ? "Deleting…" : "Delete image"}
      </Button>
    </div>
  </Dialog>;

  return { busy, run, save, confirm, dialog };
}

function ImageMenuItems({ image, allowSaveAndRemix, operations, choose, trigger, onRemix, onRemixInNewThread }: {
  image: ImageRecord;
  allowSaveAndRemix?: boolean;
  operations: ReturnType<typeof useImageOperations>;
  choose: ReturnType<typeof useDropdownActions>["choose"];
  trigger: RefObject<HTMLButtonElement | null>;
} & Pick<ImageHandlers, "onRemix" | "onRemixInNewThread">) {
  const { busy, run, save, confirm } = operations;
  return <>
    {allowSaveAndRemix && <>
      <DropdownItem disabled={busy} onClick={() => choose(() => save(image))}>Save image</DropdownItem>
      <DropdownItem disabled={busy} onClick={() => choose(() => onRemix(image))}>Remix</DropdownItem>
    </>}
    <DropdownItem disabled={busy} onClick={() => choose(() => onRemixInNewThread(image))}>Remix in new thread</DropdownItem>
    <DropdownItem disabled={busy || !image.prompt} onClick={() => choose(() =>
      void run(() => window.studio.copyText(image.prompt ?? ""), "Prompt copied."),
    )}>Copy prompt</DropdownItem>
    <DropdownItem disabled={busy} onClick={() => choose(() => void run(() => window.studio.copyText(
      Object.entries({
        Prompt: image.prompt, Size: `${image.width} × ${image.height}`, Seed: image.seed,
        Steps: image.steps, Guidance: image.guidance, Device: image.device,
        Reference: image.referenceUsed == null ? "Unknown" : image.referenceUsed ? "Used" : "None",
      }).filter(([, value]) => value != null).map(([key, value]) => `${key}: ${value}`).join("\n"),
    ), "Settings copied."))}>Copy settings</DropdownItem>
    <DropdownItem disabled={busy} onClick={() => choose(() => void run(async () => {
      const error = await window.studio.openOutputImage(image.name);
      if (error) throw new Error(error);
    }, "Opened image."))}>Open in default app</DropdownItem>
    <DropdownItem disabled={busy} onClick={() => choose(() => void run(async () => {
      const error = await window.studio.openOutputsFolder();
      if (error) throw new Error(error);
    }, "Opened output folder."))}>Open output folder</DropdownItem>
    <DropdownSeparator />
    <DropdownItem disabled={busy} destructive onClick={() => {
      const anchor = trigger.current;
      choose(() => confirm(image, anchor));
    }}>Delete image</DropdownItem>
  </>;
}

function imageMenuTop() {
  return (document.querySelector(".titlebar")?.getBoundingClientRect().bottom ?? 0) + 8;
}

export function ImageActions({ image, onRemix, onRemixInNewThread, onDelete, menuContainer }: ImageHandlers & {
  image: ImageRecord;
  menuContainer?: RefObject<HTMLElement | null>;
}) {
  const operations = useImageOperations(onDelete);
  const [collisionTop, setCollisionTop] = useState(8);
  const { trigger, choose, menuProps } = useDropdownActions({ dismissOnResize: true });

  return <div className="image-actions" role="group" aria-label={`Actions for ${image.name}`} aria-busy={operations.busy}>
    <Button variant="ghost" disabled={operations.busy} onClick={() => operations.save(image)}>Save image</Button>
    <Button variant="ghost" disabled={operations.busy} onClick={() => onRemix(image)}>Remix</Button>
    <Dropdown align="end" side={menuContainer ? "top" : "bottom"} label="Image actions" triggerTooltip="Image actions"
      portalContainer={menuContainer} collisionPadding={{ top: collisionTop, right: 8, bottom: 8, left: 8 }}
      {...menuProps} onOpenChange={(open) => {
        if (open) setCollisionTop(imageMenuTop());
        menuProps.onOpenChange(open);
      }}
      trigger={<IconButton ref={trigger} className="image-menu-trigger" aria-label={`Image actions for ${image.name}`}>
        <MoreHorizontal size={16} aria-hidden="true" />
      </IconButton>}>
      <ImageMenuItems {...{ image, operations, choose, trigger, onRemix, onRemixInNewThread }} />
    </Dropdown>
    {operations.dialog}
  </div>;
}

const GalleryMenu = createContext<Menu.Handle<ImageRecord> | null>(null);

export function GalleryImageActions({ children, onRemix, onRemixInNewThread, onDelete }: ImageHandlers & { children: ReactNode }) {
  const [handle] = useState(() => Menu.createHandle<ImageRecord>());
  const operations = useImageOperations(onDelete);
  const [collisionTop, setCollisionTop] = useState(8);
  const { trigger, choose, menuProps } = useDropdownActions({ dismissOnResize: true });

  return <TooltipScope>
    <GalleryMenu.Provider value={handle}>{children}</GalleryMenu.Provider>
    <Menu.Root handle={handle} modal={false} open={menuProps.open} onOpenChangeComplete={menuProps.onOpenChangeComplete}
      onOpenChange={(open, details) => {
        if (open && details.trigger instanceof HTMLButtonElement) {
          trigger.current = details.trigger;
          setCollisionTop(imageMenuTop());
        }
        menuProps.onOpenChange(open);
      }}>
      {({ payload: image }) => image && <DropdownPopup align="end" label="Image actions"
        collisionPadding={{ top: collisionTop, right: 8, bottom: 8, left: 8 }} finalFocus={menuProps.finalFocus}>
        <ImageMenuItems allowSaveAndRemix {...{ image, operations, choose, trigger, onRemix, onRemixInNewThread }} />
      </DropdownPopup>}
    </Menu.Root>
    {operations.dialog}
  </TooltipScope>;
}

export function GalleryImageActionTrigger({ image }: { image: ImageRecord }) {
  const handle = useContext(GalleryMenu);
  if (!handle) return null;
  return <div className="image-actions" role="group" aria-label={`Actions for ${image.name}`}>
    <Tooltip content="Image actions" side="bottom">
      <Menu.Trigger handle={handle} payload={image}
        render={<IconButton className="image-menu-trigger" aria-label={`Image actions for ${image.name}`}>
          <MoreHorizontal size={16} aria-hidden="true" />
        </IconButton>} />
    </Tooltip>
  </div>;
}
