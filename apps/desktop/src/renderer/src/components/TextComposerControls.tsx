import { memo, useRef } from "react";
import Send from "lucide-react/dist/esm/icons/arrow-up.mjs";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Paperclip from "lucide-react/dist/esm/icons/paperclip.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import { CHAT_DOCUMENT_ACCEPT, MAX_CHAT_DOCUMENTS } from "../lib/chatDocuments";
import type { TextMode } from "../lib/textThreads";
import { chatModelShortcut } from "../lib/workspaceNavigation";
import { ModelMenu, type ModelMenuOption } from "./ui/ModelMenu";
import { Select } from "./ui/Select";
import { TooltipIconButton } from "./ui/Tooltip";

const RESPONSE_MODES = [{ value: "instant", label: "Instant" }, { value: "reasoning", label: "Reasoning" }] as const;

// Reply chunks change the transcript without changing these action controls.
export const TextComposerControls = memo(function TextComposerControls({
  busy, canAttach, canSend, cancellingLoad, documentCount, focused, imageTooltip, mode, model, models, responding, sendTooltip, stopping,
  onAttachDocuments, onAttachImage, onChangeMode, onChangeModel, onManageModels, onOpenModelPicker, onStop, stopRef,
}: {
  busy: boolean;
  canAttach: boolean;
  canSend: boolean;
  cancellingLoad: boolean;
  documentCount: number;
  focused: boolean;
  imageTooltip: string;
  mode?: TextMode;
  model: string;
  models: readonly ModelMenuOption[];
  responding: boolean;
  sendTooltip: string;
  stopping: boolean;
  onAttachDocuments: (files: File[]) => void;
  onAttachImage: (files: File[]) => void;
  onChangeMode: (mode: TextMode) => void;
  onChangeModel: (id: string) => void;
  onManageModels: () => void;
  onOpenModelPicker: () => void;
  onStop: () => void;
  stopRef: (button: HTMLButtonElement | null) => void;
}) {
  const documentInput = useRef<HTMLInputElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const documentsFull = documentCount >= MAX_CHAT_DOCUMENTS;

  return <div className="text-composer-bottom">
    <div className="text-composer-model-controls">
      <input ref={documentInput} type="file" accept={CHAT_DOCUMENT_ACCEPT} aria-label="Chat document files" hidden multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          onAttachDocuments(files);
        }} />
      <TooltipIconButton aria-label="Attach documents" tooltip={documentsFull ? "This chat has eight documents" : "Attach documents for this chat"}
        disabled={busy || documentsFull} onClick={() => documentInput.current?.click()}><Paperclip size={16} aria-hidden="true" /></TooltipIconButton>
      <input ref={attachmentInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Chat image file" hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          onAttachImage(files);
        }} />
      <TooltipIconButton aria-label="Attach chat image" tooltip={imageTooltip} disabled={!canAttach}
        onClick={() => attachmentInput.current?.click()}><ImagePlus size={16} aria-hidden="true" /></TooltipIconButton>
      {mode && <Select appearance="toolbar" className="text-response-mode" aria-label="Response mode" value={mode} disabled={busy}
        options={RESPONSE_MODES} onChange={onChangeMode} />}
    </div>
    <div className="composer-send-tools">
      <ModelMenu label="Text model" className="text-model-dropdown" triggerClassName="text-menu-trigger"
        value={model} disabled={busy} options={models} keyboardShortcut={chatModelShortcut} shortcutActive={focused}
        onManageModels={onManageModels} onChange={onChangeModel} onOpen={onOpenModelPicker} />
      {responding ? <TooltipIconButton key="stop" ref={stopRef} variant="primary" shape="circle"
        className="composer-submit is-stop" disabled={stopping} onClick={onStop} aria-keyshortcuts="Escape"
        aria-label={cancellingLoad ? "Cancel model load" : "Stop generation"}
        tooltip={cancellingLoad ? stopping ? "Cancelling model load…" : "Cancel model load · Esc"
          : stopping ? "Stopping generation…" : "Stop generation · Esc"}>
        {stopping ? <LoaderCircle className="spinner" size={16} aria-hidden="true" /> : <Square size={14} fill="currentColor" aria-hidden="true" />}
      </TooltipIconButton> : <TooltipIconButton key="send" type="submit" variant="primary" shape="circle"
        className="composer-submit" disabled={!canSend} aria-label="Send message" tooltip={sendTooltip}>
        <Send size={20} aria-hidden="true" />
      </TooltipIconButton>}
    </div>
  </div>;
});
