import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { ChatDocument, ChatDocumentSource } from "../lib/chatDocuments";
import { IconButton } from "./ui/controls";

export function ChatDocumentAttachments({ documents, disabled, onRemove }: {
  documents: readonly ChatDocument[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  return <ul className="text-document-attachments" aria-label="Chat documents">
    {documents.map(({ id, name }) => <li key={id}>
      <FileText size={15} aria-hidden="true" />
      <span title={name}>{name}</span>
      <IconButton aria-label={`Remove ${name} from this chat`} title="Remove document from this chat"
        disabled={disabled} onClick={() => onRemove(id)}><X size={13} aria-hidden="true" /></IconButton>
    </li>)}
  </ul>;
}

export function ChatDocumentSources({ sources }: { sources: readonly ChatDocumentSource[] }) {
  return <details className="text-document-sources">
    <summary>Document sources</summary>
    <ul>
      {sources.map(({ number, name, location, excerpt }) => <li key={number}>
        <strong>[{number}] {name}</strong>
        <span>{location}</span>
        <p>{excerpt}</p>
      </li>)}
    </ul>
  </details>;
}
