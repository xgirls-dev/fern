import { useId, useRef, useState, type ReactNode } from "react";
import History from "lucide-react/dist/esm/icons/history.mjs";
import type { ChatSearchMatch } from "../lib/chatSearch";
import { showReplyVersion, type TextMessage, type TextPromptVersion } from "../lib/textThreads";
import { TextMarkdown } from "./TextMarkdown";
import { Button, Select } from "./ui/controls";

export function TextPromptVersions({ alternatives, onRestore, searchMatch, onCloseSearch, busy, renderImage }: {
  alternatives: TextPromptVersion[];
  onRestore?: (id: string) => void;
  searchMatch?: ChatSearchMatch;
  onCloseSearch: () => void;
  busy: boolean;
  renderImage: (response: TextMessage) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const versions = [...alternatives].sort((left, right) => right.createdAt - left.createdAt);
  const result = versions.find((version) => version.id === searchMatch?.savedPromptId);
  const match = result ? searchMatch : undefined;
  const selected = result ?? versions.find((version) => version.id === selection) ?? versions[0];
  const response = selected?.response && showReplyVersion(selected.response, match?.versionId);
  const visible = open || !!match;
  const promptMatched = match?.versionId === selected?.id;
  const close = () => {
    setOpen(false);
    setSelection(undefined);
    trigger.current?.focus({ preventScroll: true });
  };

  return <div className="text-prompt-versions">
    <Button ref={trigger} variant="ghost" aria-expanded={visible} aria-controls={visible ? panelId : undefined} disabled={!!match}
      onClick={() => open ? close() : setOpen(true)}>
      <History size={14} aria-hidden="true" />Prompt versions
    </Button>
    {visible && selected && <section id={panelId} className="text-prompt-versions-panel" aria-label="Prompt versions" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (match) onCloseSearch();
        else close();
      }
    }}>
      {versions.length > 1 && !match && <Select aria-label="Earlier prompt version" value={selected.id} onChange={setSelection}
        options={versions.map(({ id, content }) => ({ value: id, label: content.trim().replace(/\s+/g, " ").slice(0, 80) || "Image prompt" }))} />}
      <div><span className="text-prompt-version-label">Saved prompt</span>
        <p data-find-target={promptMatched || undefined} className="text-prompt-version-content">{selected.content}</p>
      </div>
      <div className="text-message-content text-prompt-version-reply">
        <span className="text-prompt-version-label">Reply</span>
        {response?.generatedImage && <div>
          {renderImage(response)}
          {match?.section === "image" && <p className="text-prompt-version-content" data-find-target>{response.generatedImage.prompt}</p>}
        </div>}
        {match?.section === "reasoning" && response?.reasoning && <div>
          <span className="text-prompt-version-label">Reasoning</span>
          <div data-find-target><TextMarkdown content={response.reasoning} /></div>
        </div>}
        {response?.content ? <div data-find-target={match?.section === "body" && !promptMatched || undefined}>
          <TextMarkdown content={response.content} />
        </div> : !response?.generatedImage &&
          <p>{response?.error ?? "No reply was saved for this version."}</p>}
      </div>
      {onRestore && !match && <Button variant="secondary" disabled={busy} onClick={() => { onRestore(selected.id); close(); }}>Restore this version</Button>}
    </section>}
  </div>;
}
