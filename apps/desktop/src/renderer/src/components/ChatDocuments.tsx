import { useEffect, useLayoutEffect, useRef, useState } from "react";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { fetchChatDocumentSource } from "../lib/api";
import { CHAT_DOCUMENT_ACCEPT, type ChatDocument, type ChatDocumentPassage, type ChatDocumentPreview, type ChatDocumentSource } from "../lib/chatDocuments";
import { Button, IconButton } from "./ui/controls";
import { Dialog, DialogClose, DialogDescription, DialogTitle } from "./ui/Dialog";
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

export type OpenDocumentSource = (source: ChatDocumentSource, trigger: HTMLButtonElement) => void;

export function ChatDocumentSources({ sources, onOpen }: { sources: readonly ChatDocumentSource[]; onOpen: OpenDocumentSource }) {
  return <Disclosure className="text-document-sources" label="Document sources">
    <ul>
      {sources.map((source) => <li key={source.number}>
        <button type="button" className="text-source-link" aria-label={`Open source [${source.number}], ${source.name}, ${source.location}`}
          onClick={(event) => onOpen(source, event.currentTarget)}>[{source.number}] {source.name}</button>
        <span>{source.location}</span>
        <p>{source.excerpt}</p>
      </li>)}
    </ul>
  </Disclosure>;
}

function NearbyDocumentPassage({ label, passage }: { label: string; passage: ChatDocumentPassage }) {
  return <section>
    <h3>{label} · {passage.location}</h3>
    <p>{passage.text}</p>
  </section>;
}

export function ChatDocumentSourcePreview({ source, trigger, onClose }: {
  source: ChatDocumentSource;
  trigger: HTMLButtonElement;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ChatDocumentPreview | null>();
  const [attempt, setAttempt] = useState(0);
  const close = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const citation = useRef<HTMLElement>(null);
  const reference = source.reference;

  useEffect(() => {
    if (!reference) return;
    const controller = new AbortController();
    void fetchChatDocumentSource(reference, controller.signal).then((passage) => {
      if (!controller.signal.aborted) setPreview(passage);
    }, () => {
      if (!controller.signal.aborted) setPreview(null);
    });
    return () => controller.abort();
  }, [attempt, reference]);

  useLayoutEffect(() => {
    if (preview && citation.current && scroll.current) scroll.current.scrollTop = citation.current.offsetTop;
  }, [preview]);

  return <Dialog className="text-source-dialog" onClose={onClose} initialFocus={close}
    finalFocus={() => trigger.isConnected ? trigger : true}>
    <header className="text-source-heading">
      <div>
        <DialogTitle>{source.name}</DialogTitle>
        <DialogDescription>Source [{source.number}] · {source.location}</DialogDescription>
      </div>
      <DialogClose render={<IconButton ref={close} aria-label="Close document source" />}><X size={18} aria-hidden="true" /></DialogClose>
    </header>
    <div className="text-source-preview" ref={scroll} tabIndex={0} role="region" aria-label="Source text">
      {preview?.before && <NearbyDocumentPassage label="Before the citation" passage={preview.before} />}
      <section ref={citation}>
        <h3>{preview ? "Cited text" : "Saved excerpt"}</h3>
        {preview ? <p><mark>{preview.quoted}</mark>{preview.remaining}</p> : <p>{source.excerpt}</p>}
      </section>
      {preview?.after && <NearbyDocumentPassage label="After the citation" passage={preview.after} />}
    </div>
    {reference && preview === undefined && <p className="text-source-status" role="status">Loading local passage…</p>}
    {preview === null && <div className="text-source-status">
      <span role="status">The local passage is unavailable. The saved excerpt is still here.</span>
      <Button variant="ghost" onClick={() => { setPreview(undefined); setAttempt((value) => value + 1); }}>Retry</Button>
    </div>}
  </Dialog>;
}
