import Search from "lucide-react/dist/esm/icons/search.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { ComponentProps } from "react";
import { DialogClose } from "./Dialog";
import { IconButton, Input } from "./controls";

export function SearchDialogField({ closeLabel, ...input }: ComponentProps<typeof Input> & { closeLabel: string }) {
  return <div className="ui-search-dialog-field">
    <Search size={17} aria-hidden="true" />
    <Input autoComplete="off" {...input} />
    <DialogClose render={<IconButton aria-label={closeLabel}><X size={16} aria-hidden="true" /></IconButton>} />
  </div>;
}
