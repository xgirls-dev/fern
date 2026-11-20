import { useRef, useState } from "react";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { resolveAssetUrl, uploadChatImage } from "../lib/api";
import type { ChatImageSettings } from "../lib/chatImageSettings";
import { readReference } from "../lib/reference";
import { Button, Checkbox, IconButton } from "./ui/controls";

export function ChatImageReferenceFields({ settings, limit, disabled, onChange }: {
  settings: ChatImageSettings;
  limit: number;
  disabled: boolean;
  onChange: (settings: Partial<ChatImageSettings>) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const references = settings.references ?? [];
  const available = limit - Number(Boolean(settings.useMessageImage));
  const move = (index: number, offset: number) => {
    const next = [...references];
    const other = index + offset;
    [next[index], next[other]] = [next[other], next[index]];
    onChange({ references: next });
  };
  const add = async (files: File[]) => {
    setError("");
    if (files.length + references.length > available) {
      setError(`Use up to ${limit} reference ${limit === 1 ? "image" : "images"}, including any image from the message.`);
      return;
    }
    setUploading(true);
    try {
      const next = [...references];
      for (const file of files) {
        const { image } = await uploadChatImage(await readReference(file));
        if (!next.some((item) => item.name === image)) next.push({ name: image, label: file.name });
      }
      onChange({ references: next });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not attach the reference image.");
    } finally {
      setUploading(false);
    }
  };
  return <fieldset className="chat-image-references" disabled={disabled || uploading}>
    <legend>Reference images</legend>
    <label className="chat-image-reference-toggle">
      <Checkbox checked={Boolean(settings.useMessageImage)} disabled={references.length === limit}
        onChange={(event) => onChange({ useMessageImage: event.currentTarget.checked })} />
      Use the image attached to the message
    </label>
    {references.length > 0 && <ol className="chat-image-reference-list">
      {references.map((item, index) => <li key={item.name}>
        <img alt="" src={resolveAssetUrl(`/references/${item.name}`)} />
        <span title={item.label}>{item.label}</span>
        <IconButton aria-label={`Move reference ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></IconButton>
        <IconButton aria-label={`Move reference ${index + 1} down`} disabled={index === references.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></IconButton>
        <IconButton aria-label={`Remove reference ${index + 1}`} onClick={() => onChange({ references: references.filter((_, position) => position !== index) })}><X size={14} /></IconButton>
      </li>)}
    </ol>}
    {references.length < available && <div className="field">
      <Button className="text-compute-link" onClick={() => picker.current?.click()}>Add image references</Button>
      <input ref={picker} hidden aria-label="Add image references" type="file" accept="image/png,image/jpeg,image/webp" multiple={available - references.length > 1}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) void add(files);
        }} />
    </div>}
    {uploading && <small role="status">Adding references…</small>}
    {error && <small className="field-error" role="alert">{error}</small>}
  </fieldset>;
}
