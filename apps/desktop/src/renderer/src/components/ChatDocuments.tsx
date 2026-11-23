import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { ChatDocument, ChatDocumentSource } from "../lib/chatDocuments";
import { Disclosure } from "./ui/Disclosure";
import { TooltipIconButton } from "./ui/Tooltip";

export function ChatDocumentAttachments({ documents, disabled, onRemove }: {
  documents: readonly ChatDocument[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  return <ul className="text-document-attachments" aria-label="Chat documents">
    {documents.map(({ id, name }) => <li key={id}>
      <FileText size={15} aria-hidden="true" />
      <span title={name}>{name}</span>
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
