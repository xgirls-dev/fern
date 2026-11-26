import { useId, useLayoutEffect } from "react";
import Send from "lucide-react/dist/esm/icons/arrow-up.mjs";
import { Button, Textarea } from "./ui/controls";
import { isComposingKey } from "../lib/keyboard";
import { useTextDraftField } from "../hooks/useTextDraftField";

export function TextPromptEditor({ draftKey, content, original, replaceLatest, focusRequested, hasImage, sendUnavailable, invalid, onChange, onCancel, onApply, onResend, onFocusHandled }: {
  draftKey: string;
  content: string;
  original: string;
  replaceLatest?: boolean;
  focusRequested: boolean;
  hasImage: boolean;
  sendUnavailable: string;
  invalid?: boolean;
  onChange: (content: string) => void;
  onCancel: () => void;
  onApply: (sendNow: boolean) => void;
  onResend?: () => void;
  onFocusHandled: () => void;
}) {
  const { fieldRef: field, bindField } = useTextDraftField(draftKey, content, 240);
  const statusId = useId();
  const resendScopeId = `${statusId}-resend`;
  const canApply = !!content.trim() || hasImage;
  const canSend = canApply && !sendUnavailable && (!replaceLatest || content.trim() !== original.trim());
  const sendLabel = replaceLatest ? "Send revision" : "Send in new chat";
  useLayoutEffect(() => {
    if (!focusRequested || !field.current) return;
    const input = field.current;
    input.focus({ preventScroll: true });
    input.form?.scrollIntoView({ block: "nearest" });
    onFocusHandled();
  }, [field, focusRequested, onFocusHandled]);
  useLayoutEffect(() => {
    const form = field.current?.form;
    const feed = form?.closest<HTMLElement>(".text-conversation");
    if (!form || !feed) return;
    const observer = new ResizeObserver(() => {
      const focused = form.ownerDocument.activeElement;
      if (!focused || !form.contains(focused) || !feed.clientHeight) return;
      const viewport = feed.getBoundingClientRect();
      const bounds = form.getBoundingClientRect();
      // The user can scroll away while the editor still has focus.
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return;
      const target = bounds.height <= feed.clientHeight - 16 ? bounds : focused.getBoundingClientRect();
      if (target.top < viewport.top + 8) feed.scrollTop += target.top - viewport.top - 8;
      else if (target.bottom > viewport.bottom - 8) feed.scrollTop += target.bottom - viewport.bottom + 8;
    });
    observer.observe(form);
    observer.observe(feed);
    return () => observer.disconnect();
  }, [field]);

  return (
    <form className="text-prompt-editor" aria-label="Edit prompt" onSubmit={(event) => {
      event.preventDefault();
      if (canSend) onApply(true);
    }} onKeyDown={(event) => {
      if (isComposingKey(event.nativeEvent)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (canSend && !event.repeat) onApply(true);
      }
    }}>
      <Textarea key={draftKey} ref={bindField} autosize aria-label="Edited prompt" aria-invalid={invalid || undefined}
        aria-describedby={sendUnavailable ? statusId : undefined} rows={2} value={content} onChange={(event) => onChange(event.target.value)} />
      <div className="text-prompt-editor-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="secondary" disabled={!canApply} onClick={() => onApply(false)}>Open branch draft</Button>
        {onResend && <Button variant="secondary" disabled={!canSend} onClick={onResend} aria-describedby={resendScopeId}>Resend here</Button>}
        <Button type="submit" variant="primary" disabled={!canSend} aria-describedby={sendUnavailable ? statusId : undefined}><Send size={15} aria-hidden="true" />{sendLabel}</Button>
      </div>
      {sendUnavailable && <span id={statusId} className="text-prompt-editor-status" role="status">{sendUnavailable}</span>}
      {!sendUnavailable && replaceLatest && <span className="text-prompt-editor-status">The previous prompt and reply stay in Prompt versions.</span>}
      {onResend && <span id={resendScopeId} className="text-prompt-editor-status">Resending here replaces this prompt and the messages after it. You can restore the original in Versions.</span>}
    </form>
  );
}
