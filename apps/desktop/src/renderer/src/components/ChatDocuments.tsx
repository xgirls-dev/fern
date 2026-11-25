import { useRef } from "react";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { CHAT_DOCUMENT_ACCEPT, type ChatDocument, type ChatDocumentSource } from "../lib/chatDocuments";
import { Button } from "./ui/controls";
import { Disclosure } from "./ui/Disclosure";
import { TooltipIconButton } from "./ui/Tooltip";

function ReplaceChatDocument({ name, disabled, onChoose }: {
  name: string;
  disabled: boolean;
  onChoose: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <small>Unavailable</small>
    <input ref={input} type="file" accept={CHAT_DOCUMENT_ACCEPT} aria-label={`Replacement for ${name}`} hidden
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) onChoose(file);
      }} />
    <Button className="text-document-replace" variant="ghost" aria-label={`Replace ${name}`}
      disabled={disabled} onClick={() => input.current?.click()}>Replace</Button>
  </>;
}

export function ChatDocumentAttachments({ documents, disabled, onRemove, onReplace }: {
  documents: readonly ChatDocument[];
  disabled: boolean;
  onRemove: (id: string) => void;
  onReplace: (id: string, file: File) => void;
}) {
  return <ul className="text-document-attachments" aria-label="Chat documents">
    {documents.map(({ id, name, unavailable }) => <li key={id} data-unavailable={unavailable || undefined}>
      <FileText size={15} aria-hidden="true" />
      <span title={name}>{name}</span>
      {unavailable && <ReplaceChatDocument name={name} disabled={disabled} onChoose={(file) => onReplace(id, file)} />}
      <TooltipIconButton aria-label={`Remove ${name} from this chat`} tooltip="Remove document from this chat"
        disabled={disabled} onClick={() => onRemove(id)}><X size={13} aria-hidden="true" /></TooltipIconButton>
    </li>)}
  </ul>;
}

export function ChatDocumentSources({ sources }: { sources: readonly ChatDocumentSource[] }) {
  return <Disclosure className="text-document-sources" label="Document sources">
    <ul>
      {sources.map(({ number, name, location, excerpt }) => <li key={number}>
        <strong>[{number}] {name}</strong>
        <span>{location}</span>
        <p>{excerpt}</p>
      </li>)}
    </ul>
  </Disclosure>;
}
