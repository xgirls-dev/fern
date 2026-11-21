import { useEffect, useId, useRef, useState } from "react";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Send from "lucide-react/dist/esm/icons/arrow-up.mjs";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ImageOff from "lucide-react/dist/esm/icons/image-off.mjs";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Paperclip from "lucide-react/dist/esm/icons/paperclip.mjs";
import Columns2 from "lucide-react/dist/esm/icons/columns-2.mjs";
import ArrowLeftRight from "lucide-react/dist/esm/icons/arrow-left-right.mjs";
import { TextMarkdown } from "./TextMarkdown";
import { Button, IconButton, Input, MenuItem, Select, Textarea } from "./ui/controls";
import { WorkspaceThreadTitle } from "./WorkspaceThreadTitle";
import { ImageBatchField, ImageCanvasFields, ImageSamplingFields } from "./ImageGenerationFields";
import { ImageStyleFields } from "./ImageStyleFields";
import { ChatPresets } from "./ChatPresets";
import { ImageLoraFields } from "./ImageLoraFields";
import { ChatImageReferenceFields } from "./ChatImageReferenceFields";
import { ChatDocumentAttachments, ChatDocumentSources } from "./ChatDocuments";

import { TextMenu } from "./TextMenu";
import X from "lucide-react/dist/esm/icons/x.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import type { useTextChat } from "../hooks/useTextChat";
import { useReturnFocus } from "../hooks/useReturnFocus";
import { notify } from "../lib/notifications";
import { resolveAssetUrl } from "../lib/api";
import { chatImageErrors, chatImageSettings, MAX_IMAGE_PROMPT_SUFFIX, type ChatImageSettings } from "../lib/chatImageSettings";
import { isKleinLoraModel, maxReferenceImages } from "../lib/imageModels";
import { CHAT_DOCUMENT_ACCEPT, MAX_CHAT_DOCUMENTS } from "../lib/chatDocuments";
import {
  chatTokenLimits, ggufLoadOptions, KV_CACHE_TYPES, textRuntimeIssue,
  type ChatPane, type GeneratedChatImage, type GgufLoadOptions, type TextMessage, type TextSamplingSettings, type TextThread,
} from "../lib/textThreads";
import type { SetupTask } from "../lib/modelSetup";
import type { ImageRecord } from "../lib/types";

type TextStudio = ReturnType<typeof useTextChat>;

function TokenField({ label, value, min, max, disabled, help, onChange }: {
  label: string; value: number; min: number; max: number; disabled: boolean; help?: string;
  onChange: (number: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const number = Number(draft);
  const valid = draft !== "" && Number.isInteger(number) && number >= min && number <= max;
  const hint = valid ? help : `Use a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`;
  return (
    <label htmlFor={id}>{label}
      <Input id={id} type="number" inputMode="numeric" min={min} max={max} step={1}
        value={draft} disabled={disabled} aria-invalid={!valid} aria-describedby={hint ? `${id}-help` : undefined}
        onBlur={() => { if (!valid) setDraft(String(value)); }}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          setDraft(event.currentTarget.value);
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
      />
      {hint && <small className={valid ? "text-setting-help" : "field-error"} id={`${id}-help`}>{hint}</small>}
    </label>
  );
}

const samplerNumberFields = [
  { key: "topK", label: "Top K", min: 0, max: 2_147_483_647, step: 1, placeholder: "Model default" },
  { key: "minP", label: "Min P", min: 0, max: 0.999999, step: 0.001, placeholder: "Model default" },
  { key: "repeatPenalty", label: "Repetition penalty", min: 0.001, max: 3.402823466e38, step: 0.01, placeholder: "Model default" },
  { key: "fixedSeed", label: "Text seed", min: 0, max: 2_147_483_647, step: 1, placeholder: "Random each response" },
] as const;

function SamplingNumberField({ field, value, disabled, onChange, compact = false }: {
  field: { label: string; min: number; max: number; step: number; placeholder: string };
  value?: number;
  disabled: boolean;
  compact?: boolean;
  onChange: (number?: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value?.toString() ?? "");
  useEffect(() => setDraft(value?.toString() ?? ""), [value]);
  const number = Number(draft);
  const valid = (!draft && !compact) || (Boolean(draft) && Number.isFinite(number) && number >= field.min && number <= field.max
    && (field.step !== 1 || Number.isInteger(number)));
  return <label htmlFor={id}><span className={compact ? "sr-only" : undefined}>{field.label}</span>
    <Input id={id} type="number" min={field.min} max={field.max} step={field.step === 1 ? 1 : "any"} value={draft}
      placeholder={field.placeholder} disabled={disabled} aria-invalid={!valid}
      onBlur={() => { if (!valid) setDraft(value?.toString() ?? ""); }}
      onChange={(event) => {
        const next = event.currentTarget.value;
        const parsed = event.currentTarget.valueAsNumber;
        setDraft(next);
        if (!next && !compact) onChange(undefined);
        else if (Number.isFinite(parsed) && parsed >= field.min && parsed <= field.max && (field.step !== 1 || Number.isInteger(parsed))) onChange(parsed);
      }} />
  </label>;
}

function SamplingRangeField({ label, help, min, max, value, disabled, onChange }: {
  label: string; help: string; min: number; max: number; value: number; disabled: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const step = 0.01;
  return <div className="field text-range-field">
    <label htmlFor={id}>{label}</label>
    <small className="text-setting-help" id={id + "-help"}>{help}</small>
    <div className="text-range-control">
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-describedby={id + "-help"}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)} />
      <SamplingNumberField compact field={{ label: label + " value", min, max, step, placeholder: "" }}
        value={value} disabled={disabled} onChange={(next) => { if (next !== undefined) onChange(next); }} />
    </div>
  </div>;
}

function chatImageRecord(image: GeneratedChatImage, mtime: number): ImageRecord {
  return { ...image, url: `/outputs/${encodeURIComponent(image.name)}`, mtime };
}

function messageImages(message: TextMessage): GeneratedChatImage[] {
  return message.generatedImages?.length ? message.generatedImages : message.generatedImage ? [message.generatedImage] : [];
}

function ChatImage({ image, ordinal, checked, checking, onOpen, onRetryCheck, canRetryCheck, contextLabel, onInclude }: {
  image: GeneratedChatImage;
  ordinal: number;
  checked?: boolean;
  checking?: boolean;
  onOpen: () => void;
  onRetryCheck?: () => void;
  canRetryCheck?: boolean;
  contextLabel?: string;
  onInclude?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const subject = image.prompt.trim().slice(0, 140) || image.name;
  return <figure className="text-generated-artifact">
    {failed ? <div className="text-generated-unavailable">
      <ImageOff size={18} aria-hidden="true" />
      <span role="status">Image unavailable. The file may have been moved or deleted.</span>
      <Button variant="secondary" onClick={() => { setFailed(false); setRevision((value) => value + 1); }}>Retry preview</Button>
    </div> : <button type="button" className="text-generated-image" aria-label={`Review image ${ordinal}: ${subject}`} onClick={onOpen}>
      <img src={resolveAssetUrl(`/outputs/${encodeURIComponent(image.name)}`, String(revision))} alt={`Generated image ${ordinal}. Prompt: ${subject}`} width={image.width} height={image.height} onError={() => setFailed(true)} />
    </button>}
    {!failed && <figcaption>
      {(checked || checking || onRetryCheck || contextLabel) && <span className="text-artifact-status">
        {checked && <span><Check size={14} aria-hidden="true" /> Image checked</span>}
        {checking && <span>Checking image…</span>}
        {onRetryCheck && <span>Image check incomplete</span>}
        {contextLabel && <span className="text-artifact-context">{contextLabel}</span>}
      </span>}
      <span className="text-artifact-metadata">{[image.modelLabel, `${image.width} × ${image.height}`].filter(Boolean).join(" · ")}</span>
    </figcaption>}
    {!failed && !checking && (onRetryCheck || onInclude) ? <div className="text-artifact-actions">
      {onRetryCheck ? <Button variant="secondary" disabled={!canRetryCheck} onClick={onRetryCheck}>Retry image check</Button> : null}
      {onInclude ? <Button variant="ghost" onClick={onInclude}>Include this image again</Button> : null}
    </div> : null}
  </figure>;
}

export interface TextWorkspaceProps {
  studio: TextStudio;
  thread: TextThread;
  pane: ChatPane;
  focused: boolean;
  split: boolean;
  onChooseChat: () => void;
  onClosePane: () => void;
  sidebarCollapsed?: boolean;
  onSetupModels: (task: SetupTask, threadId: string) => void;
  focusRequest?: number;
  imageGpuAvailable?: boolean;
  onOpenImage: (image: ImageRecord, images: ImageRecord[]) => void;
  onCreateImage: () => void;
  onCreateSpeech: () => void;
  onOpenCompute: () => void;
}

export function TextWorkspace({ studio, thread: activeThread, pane, focused, split, onChooseChat, onClosePane,
  sidebarCollapsed = false, onSetupModels, focusRequest = 0, imageGpuAvailable, onOpenImage, onCreateImage, onCreateSpeech, onOpenCompute,
}: TextWorkspaceProps) {
  const { status, statusError, actionError, busy } = studio;
  const [panel, setPanel] = useState<"settings" | "image" | null>(null);
  const openModels = () => { setPanel(null); onSetupModels("chat", activeThread.id); };
  const openImageSetup = () => { setPanel(null); onSetupModels("chat-image", activeThread.id); };
  const fieldPrefix = useId() + "-";
  const inspectorId = `${fieldPrefix}chat-inspector`;
  const panelRef = useRef<HTMLElement>(null);
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [infoId, setInfoId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ threadId: string; messageId: string; content: string } | null>(null);
  const editFocus = useReturnFocus();
  const [showScrollButton, setShowScrollButton] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastFocusRequest = useRef(0);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const [draggingAttachment, setDraggingAttachment] = useState(false);
  useEffect(() => {
    if (focusRequest && focusRequest !== lastFocusRequest.current && focused) inputRef.current?.focus();
    lastFocusRequest.current = focusRequest;
  }, [focusRequest, focused]);
  const runningHere = status.job.status === "running" && status.job.threadId === activeThread?.id;
  const models = status.models;
  const modelOptions = [
    ...models.map(model => ({ value: model.id, label: model.name, description: model.installed ? undefined : "Unavailable", disabled: !model.installed })),
    ...(status.recommendedModels ?? []).filter(model => !model.installed && !models.some(installed => installed.id === model.id))
      .map(model => ({ value: model.id, label: model.name, description: "Not installed", disabled: true })),
  ];
  const installedModels = models.filter((model) => model.installed);
  const preferredModel = installedModels.find((model) => model.id === status.defaultModelId) ?? installedModels[0];
  const selectedModel = activeThread?.modelId ?? preferredModel?.id ?? "";
  const selected = models.find((model) => model.id === selectedModel && model.installed);
  const modelAvailable = !!selected;
  const promptLimit = selected?.format === "gguf" ? undefined : 20_000;
  const runtimeIssue = selected ? textRuntimeIssue(status, selected) : null;
  const localError = actionError && (actionError.threadId ? actionError.threadId === activeThread.id : focused) ? actionError.message : null;
  const visibleError = localError ?? (focused ? statusError ?? status.registryError : null) ?? runtimeIssue;
  const incompatibleImages = !selected?.supportsVision && !!(activeThread?.draftImage || activeThread?.draftContextImage ||
    activeThread?.messages.some((message) => message.image || message.includedImage));
  const lastMessage = activeThread?.messages.at(-1);
  const needsRetry = !!lastMessage && (lastMessage.role === "user" || (!lastMessage.content.trim() && !lastMessage.generatedImage));
  const imageModels = status.imageToolModels ?? [];
  const imageModelAvailable = imageModels.some((model) => activeThread?.imageModel === "auto" || activeThread?.imageModel === model.id);
  const canUseImageSetup = studio.computeDevice === "GPU" && imageGpuAvailable !== false;
  const canCreateImage = canUseImageSetup && !runtimeIssue && selected?.supportsVision && selected.supportsTools && imageModelAvailable;
  const generatingImage = runningHere && !!status.job.phase?.startsWith("Generating");
  const checkingImage = runningHere && !!status.job.phase?.startsWith("Checking the generated image");
  const spokenPhase = runningHere
    ? checkingImage || status.job.inspection ? "Checking the image…" : generatingImage ? "Creating an image…" : "Responding…"
    : "";
  const pinnedToBottom = useRef(true);
  const empty = !activeThread?.messages.length && !runningHere;
  const checking = !studio.statusLoaded && !statusError;
  const pendingHere = !!activeThread?.pendingJobId && !runningHere;
  const unavailableReason = checking ? "Checking local models…" : !modelAvailable ? "Choose an installed model to send" : runtimeIssue ? "Text runtime unavailable" : incompatibleImages ? "Choose a vision model for the attached images" : needsRetry && !busy ? "Retry the response to continue" : "";
  const activity = studio.modelAction ?? (studio.attachingDocument ? "Reading documents…" : studio.attachingImage ? "Attaching image…" : ["downloading", "preparing"].includes(status.modelInstall?.status ?? "") ? status.modelInstall?.phase ?? "Installing model…" : pendingHere ? "Preparing your response…" : busy && !runningHere ? "Another response is running" : "");
  const { selectModel } = studio;

  useEffect(() => {
    if (activeThread && !activeThread.modelId && preferredModel) {
      selectModel(activeThread.id, preferredModel.id);
    }
  }, [activeThread?.id, activeThread?.modelId, preferredModel?.id, selectModel]);

  useEffect(() => {
    const element = feedRef.current;
    if (element && pinnedToBottom.current) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      element.scrollTo({ top: element.scrollHeight, behavior: busy || reduce ? "instant" : "smooth" });
    }
  }, [activeThread?.messages.at(-1)?.id, status.job.partialText, status.job.partialReasoning, status.job.image?.name, status.job.images?.length, status.job.status, busy]);
  useEffect(() => {
    pinnedToBottom.current = true;
    setShowScrollButton(false);
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });

  }, [activeThread?.id]);

  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
  }, [activeThread?.draft, activeThread?.id]);

  const closePanel = () => {
    setPanel(null);
    panelTrigger.current?.focus();
  };

  const inspectorOpen = panel !== null;
  const showPanel = (view: "settings" | "image") => {
    if (view === panel) return;
    if (panelRef.current) panelRef.current.scrollTop = 0;
    setPanel(view);
  };
  useEffect(() => {
    if (inspectorOpen) panelRef.current?.focus({ preventScroll: true });
  }, [inspectorOpen]);

  const copyMessage = async (id: string, content: string) => {
    try {
      await window.studio.copyText(content);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => current === id ? null : current), 1300);
    } catch {
      notify("Could not copy the response. Select the text and copy it manually.", "error");
    }
  };

  const submit = () => {
    if (busy || needsRetry || !modelAvailable || !!runtimeIssue || incompatibleImages) return;
    const text = activeThread?.draft ?? "";
    if (!text.trim()) return;
    pinnedToBottom.current = true;
    void studio.send(activeThread.id, text);
  };

  if (!activeThread) return null;
  const documents = activeThread.documents ?? [];

  const forkChat = (messageId?: string) => {
    if (!studio.forkThread(activeThread.id, messageId)) return;
    setEditing(null);
    pinnedToBottom.current = true;
    inputRef.current?.focus();
  };

  const liveImages = runningHere
    ? (status.job.images?.length ? status.job.images : status.job.image ? [status.job.image] : [])
    : [];
  const imageCollection = activeThread.messages.flatMap((message) => messageImages(message).map((image) => chatImageRecord(image, message.createdAt)));
  for (const image of liveImages) {
    if (!imageCollection.some((item) => item.name === image.name)) imageCollection.push(chatImageRecord(image, (status.job.startedAt ?? 0) * 1000));
  }
  const draftContextImage = imageCollection.find((image) => image.name === activeThread.draftContextImage);
  const latestContext = [...activeThread.messages].reverse().find((message) => message.status === "complete")?.metrics?.context;
  const tokenLimits = chatTokenLimits(activeThread, selected);
  const loadOptions = ggufLoadOptions(activeThread.loadOptions, tokenLimits.contextSize);
  const imageModel = activeThread.imageModel === "auto" ? imageModels[0] : imageModels.find((item) => item.id === activeThread.imageModel);
  const imageSettings = imageModel ? chatImageSettings(imageModel, activeThread.imageRenderSettings?.[imageModel.id]) : undefined;
  const imageErrors = imageModel && imageSettings ? chatImageErrors(imageModel, imageSettings) : undefined;
  const updateImageSettings = (update: Partial<ChatImageSettings>) => {
    if (!imageModel || !imageSettings) return;
    studio.updateThread(activeThread.id, { imageRenderSettings: {
      ...activeThread.imageRenderSettings, [imageModel.id]: { ...imageSettings, ...update },
    } });
  };
  const updateSampling = (update: Partial<TextSamplingSettings>) =>
    studio.updateThread(activeThread.id, { sampling: { ...activeThread.sampling, ...update } });
  const updateLoadOptions = (update: Partial<GgufLoadOptions>) =>
    studio.updateThread(activeThread.id, { loadOptions: { ...activeThread.loadOptions, ...update } });
  let previousCompacted = 0;
  const renderChatImage = (image: GeneratedChatImage, message?: TextMessage) => {
    const index = imageCollection.findIndex((item) => item.name === image.name);
    const primary = message ? message.generatedImage?.name === image.name : liveImages[0]?.name === image.name;
    const canRecover = primary && message && (message.status === "failed" || message.status === "stopped") && !message.metrics?.visionChecked;
    return <ChatImage key={image.name} image={image} ordinal={index + 1}
      checked={primary && message?.metrics?.visionChecked} checking={primary && (message ? !!message.inspectionJobId : checkingImage)}
      onRetryCheck={canRecover ? () => void studio.retryInspection(activeThread.id, message.id) : undefined}
      canRetryCheck={!busy && !!selected?.supportsVision && !runtimeIssue}
      contextLabel={activeThread.draftContextImage === image.name
        ? "Selected for next message"
        : message && latestContext?.imageNames?.includes(image.name) ? "Used in the latest response" : undefined}
      onInclude={message && !busy && selected?.supportsVision && !activeThread.draftImage && activeThread.draftContextImage !== image.name ? () => {
        studio.updateThread(activeThread.id, { draftContextImage: image.name });
        inputRef.current?.focus();
      } : undefined}
      onOpen={() => onOpenImage(imageCollection[index], imageCollection)} />;
  };

  return (
    <section className={`text-workspace${empty ? " text-workspace--empty" : ""}`}
      aria-label={split ? (pane === "primary" ? "Left chat" : "Right chat") : "Text conversation"}>
      <header className="workspace-header text-header">
        <div className="workspace-heading">
          <WorkspaceThreadTitle
            thread={activeThread}
            threads={studio.threads}
            switchLabel="Open text thread"
            sidebarCollapsed={sidebarCollapsed && !split}
            onSwitch={studio.selectThread}
          />
        </div>
        <div className="text-header-actions">
          {activeThread.messages.length > 0 && <IconButton title="Duplicate chat" aria-label="Duplicate chat" disabled={busy}
            onClick={() => forkChat()}><Copy size={15} aria-hidden="true" /></IconButton>}
          {!!activeThread.versions?.length && <Select className="chat-version-select" aria-label="Conversation versions"
            value="" disabled={busy} onChange={(event) => {
              setEditing(null);
              pinnedToBottom.current = true;
              studio.restoreVersion(activeThread.id, event.currentTarget.value);
            }}>
            <option value="">Versions</option>
            {activeThread.versions.map((version) => <option key={version.id} value={version.id}>{version.label}</option>)}
          </Select>}
          <IconButton title={split ? "Choose another chat for this pane" : "Open split chat"}
            aria-label={split ? "Choose another chat for this pane" : "Open split chat"} onClick={onChooseChat}>
            {split ? <ArrowLeftRight size={15} aria-hidden="true" /> : <Columns2 size={15} aria-hidden="true" />}
          </IconButton>
          <Button ref={panelTrigger} variant="secondary" className="workspace-settings-button" title="Chat settings"
            aria-label="Chat settings" aria-expanded={panel !== null} aria-controls={panel ? inspectorId : undefined} onClick={() => panel ? closePanel() : setPanel("settings")}><Settings2 size={15} aria-hidden="true" /><span>Chat settings</span></Button>
          {split && <IconButton title="Close pane" aria-label="Close pane" onClick={onClosePane}><X size={16} aria-hidden="true" /></IconButton>}
        </div>
      </header>

      <div className={`text-layout${panel ? " text-layout--inspecting" : ""}`}>
      <div className="text-main">
      <div className="text-conversation" ref={feedRef} onScroll={(event) => { const el = event.currentTarget; pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setShowScrollButton(!pinnedToBottom.current); }} role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
        {!activeThread.messages.length && !runningHere ? (
          <div className="text-empty-state">
            <h3>What can I help with?</h3>
            {checking ? <p role="status">Checking local models…</p> : !installedModels.length && <p>Download a model to start chatting on your device.</p>}
            {!checking && !installedModels.length && <Button variant="secondary" onClick={openModels}><Plus size={16} aria-hidden="true" /> Browse models</Button>}
            {!checking && canUseImageSetup && status.ggufAvailable === true && !canCreateImage && <Button variant="ghost" onClick={openImageSetup}>Set up images in chat</Button>}
            {canCreateImage && <Button variant="ghost" onClick={() => {
              if (!activeThread.draft.trim()) studio.updateThread(activeThread.id, { draft: "Create a small poster with a red circle on cream, then describe what you see." });
              inputRef.current?.focus();
            }}>Try creating a poster</Button>}
          </div>
        ) : null}

        {activeThread.messages.map((message) => {
          const editingHere = editing?.threadId === activeThread.id && editing.messageId === message.id ? editing : null;
          const cancelEdit = () => {
            setEditing(null);
            editFocus.restore(message.id);
          };
          const compacted = message.metrics?.context?.compactedMessages ?? 0;
          const newlyCompacted = compacted > previousCompacted;
          if (compacted > previousCompacted) previousCompacted = compacted;
          return (
          <article className={`text-message text-message--${message.role}`} key={message.id}>
            {newlyCompacted ? <p className="text-context-note">Earlier messages were summarized to fit this response. Include a previous image again if you want the model to see it.</p> : null}
            {message.image && <img className="text-message-image" src={resolveAssetUrl(`/references/${message.image}`)} alt="Attached chat image" />}
            {message.includedImage ? <p className="text-context-note">Selected image: {imageCollection.find((image) => image.name === message.includedImage)?.prompt || message.includedImage}</p> : null}
            {messageImages(message).map((image) => renderChatImage(image, message))}
            {message.reasoning && <details className="text-reasoning"><summary>Reasoning</summary><TextMarkdown content={message.reasoning} /></details>}
            {editingHere ? <form className="chat-edit-message" onSubmit={(event) => {
              event.preventDefault();
              if (busy || !editingHere.content.trim() || editingHere.content.trim() === message.content.trim()) return;
              void studio.send(activeThread.id, editingHere.content, false, message.id).then((submitted) => {
                if (submitted) setEditing((current) => current?.messageId === message.id ? null : current);
              });
            }}>
              <Textarea aria-label="Edited message" rows={3} value={editingHere.content} maxLength={promptLimit} autoFocus
                onChange={(event) => setEditing({ ...editingHere, content: event.currentTarget.value })}
                onKeyDown={(event) => { if (event.key === "Escape") cancelEdit(); }} />
              <div className="chat-edit-actions">
                <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
                <Button variant="primary" type="submit" disabled={busy || !editingHere.content.trim() || editingHere.content.trim() === message.content.trim()}>Resend</Button>
              </div>
            </form> : <div className="text-message-content">{message.role === "user" ? message.content : <TextMarkdown content={message.content} />}</div>}
            {!!message.metrics?.documentSources?.length && <ChatDocumentSources sources={message.metrics.documentSources} />}
            {message.role === "user" && !editingHere && <div className="text-message-tools">
              <IconButton className="text-icon-button" aria-label="Fork chat here" title="Fork chat here" disabled={busy}
                onClick={() => forkChat(message.id)}><GitBranch size={15} aria-hidden="true" /></IconButton>
              <IconButton ref={editFocus.register(message.id)} className="text-icon-button" aria-label="Edit message" title="Edit message"
                disabled={busy || !modelAvailable || !!runtimeIssue}
                onClick={() => setEditing({ threadId: activeThread.id, messageId: message.id, content: message.content })}><Pencil size={14} aria-hidden="true" /></IconButton>
            </div>}
            {message.status === "failed" ? <div className="text-error" role="alert">
              {message.error ?? "Generation failed. Retry the response."}
              {message.errorCode === "intel-vulkan-driver" && window.studio.platform === "win32" && <> <a href="https://www.intel.com/content/www/us/en/support/detect.html" target="_blank" rel="noreferrer">Get Intel graphics drivers</a></>}
            </div> : null}
            {message.status === "stopped" ? <div className="text-partial-note">Stopped{message.content ? " · Partial response" : " before any text was generated"}</div> : null}
            {message.role === "assistant" && <div className="text-message-tools">
              {message.content.trim() && <IconButton className="text-icon-button" aria-label={copiedId === message.id ? "Copied" : "Copy message"} title={copiedId === message.id ? "Copied" : "Copy message"} onClick={() => void copyMessage(message.id, message.content)}><Copy size={15} aria-hidden="true" /></IconButton>}
              <IconButton className="text-icon-button" aria-label="Fork chat here" title="Fork chat here" disabled={busy}
                onClick={() => forkChat(message.id)}><GitBranch size={15} aria-hidden="true" /></IconButton>
              {message === lastMessage && !busy && (!message.generatedImage || message.status === "complete") && <IconButton className="text-icon-button" aria-label={message.status === "failed" || message.status === "stopped" ? "Retry response" : "Regenerate response"} title="Regenerate response" disabled={!modelAvailable || !!runtimeIssue || incompatibleImages} onClick={() => void studio.retry(activeThread.id)}><RotateCcw size={15} aria-hidden="true" /></IconButton>}
              <IconButton className="text-icon-button" aria-label="Response details" title="Response details" aria-expanded={infoId === message.id} onClick={() => setInfoId(infoId === message.id ? null : message.id)}><Info size={15} aria-hidden="true" /></IconButton>
              {copiedId === message.id && <span role="status">Copied</span>}
            </div>}
            {infoId === message.id && <div className="text-response-details"><span className="text-message-label">{message.modelName ?? message.metrics?.modelName ?? "Local model"}</span>{message.metrics && <span>{message.metrics.backend ? `${message.metrics.backend} · ` : ""}{message.metrics.device} · {message.metrics.inputTokens} in / {message.metrics.outputTokens} out · {message.metrics.tokensPerSecond.toFixed(1)} tokens/s · {message.metrics.generationSeconds.toFixed(1)} s<br />Temperature {message.metrics.temperature ?? "unknown"} · Top P {message.metrics.topP ?? "unknown"} · Seed {message.metrics.seed ?? "unknown"} · Max tokens {message.metrics.maxNewTokens ?? "unknown"}</span>}</div>}
            {infoId === message.id && message.metrics?.context && <div className="text-response-details">
              {message.metrics.context.size.toLocaleString()} token context · {message.metrics.context.images} {message.metrics.context.images === 1 ? "image" : "images"}
              {message.metrics.context.compactedMessages > 0 && ` · ${message.metrics.context.compactedMessages} earlier messages compacted`}
            </div>}
            {infoId === message.id && message.metrics?.loadOptions && Object.keys(message.metrics.loadOptions).length > 0 && <div className="text-response-details">
              {[
                message.metrics.loadOptions.flashAttention && `Flash Attention ${message.metrics.loadOptions.flashAttention}`,
                message.metrics.loadOptions.promptBatch && `Prompt batch ${message.metrics.loadOptions.promptBatch}`,
                message.metrics.loadOptions.microBatch && `Microbatch ${message.metrics.loadOptions.microBatch}`,
                message.metrics.loadOptions.keyCacheType && `KV keys ${message.metrics.loadOptions.keyCacheType}`,
                message.metrics.loadOptions.valueCacheType && `KV values ${message.metrics.loadOptions.valueCacheType}`,
              ].filter(Boolean).join(" · ")}
            </div>}

          </article>
          );
        })}
        {runningHere && !status.job.inspection ? <article className="text-message text-message--assistant text-message--streaming" aria-live="off">
          {liveImages.map((image) => renderChatImage(image))}
          {status.job.partialReasoning && <details className="text-reasoning"><summary>Reasoning</summary><TextMarkdown content={status.job.partialReasoning} /></details>}
          <div className="text-message-content">{status.job.partialText ? <TextMarkdown content={status.job.partialText} /> : <span className="text-thinking">{!status.job.image && (status.job.phase || (generatingImage ? "Creating an image…" : checkingImage ? "Checking the image…" : "Thinking…"))}</span>}<span className="text-stream-cursor" aria-hidden="true" /></div>
        </article> : null}
        {lastMessage?.role === "user" && !busy && <Button variant="secondary" className="text-retry" disabled={!modelAvailable || !!runtimeIssue || incompatibleImages} onClick={() => void studio.retry(activeThread.id)}><RotateCcw size={15} aria-hidden="true" />Retry response</Button>}

        <div className="text-feed-end" />
      </div>

      <div className="sr-only" role="status">{spokenPhase}</div>
      <footer className="text-composer-area">
        {showScrollButton && <IconButton shape="circle" className="text-scroll-latest" aria-label="Jump to latest message" title="Jump to latest message" onClick={() => { pinnedToBottom.current = true; setShowScrollButton(false); const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: reduce ? "instant" : "smooth" }); }}><ArrowDown size={16} aria-hidden="true" /></IconButton>}
        {visibleError ? <div className="text-error" role="alert">{visibleError}<Button variant="secondary" onClick={() => { void studio.refresh(); }}>Refresh status</Button></div> : null}
        {selectedModel && !modelAvailable ? <div className="text-error" role="alert">{models.find((model) => model.id === selectedModel)?.error ?? "This thread’s model was removed. Add its folder again or select another model."}</div> : null}
        <form className="text-composer" data-attachment-drop={draggingAttachment || undefined}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? "none" : "copy";
            if (!busy) setDraggingAttachment(true);
          }}
          onDragLeave={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDraggingAttachment(false);
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDraggingAttachment(false);
            if (busy) return;
            const files = Array.from(event.dataTransfer.files);
            if (files.length === 1 && files[0].type.startsWith("image/") && selected?.supportsVision) void studio.attachImage(activeThread.id, files[0]);
            else void studio.attachDocuments(activeThread.id, files);
          }}
          onSubmit={(event) => { event.preventDefault(); submit(); }}>
          {activeThread.draftContextImage ? <div className="text-draft-image text-draft-context">
            {draftContextImage && <img src={resolveAssetUrl(draftContextImage.url, draftContextImage.mtime)} alt="" onError={(event) => { event.currentTarget.hidden = true; }} key={draftContextImage.name} />}
            <span>Selected for next message: {draftContextImage?.prompt || activeThread.draftContextImage}</span>
            <IconButton aria-label="Remove selected conversation image" disabled={busy} onClick={() => studio.updateThread(activeThread.id, { draftContextImage: undefined })}><X size={14} aria-hidden="true" /></IconButton>
          </div> : null}
          {activeThread.draftImage && <div className="text-draft-image">
            <img src={resolveAssetUrl(`/references/${activeThread.draftImage}`)} alt="Image to send" />
            <IconButton aria-label="Remove chat image" disabled={busy} onClick={() => studio.updateThread(activeThread.id, { draftImage: undefined })}><X size={14} aria-hidden="true" /></IconButton>
          </div>}
          {documents.length > 0 && <ChatDocumentAttachments documents={documents} disabled={busy} onRemove={(id) => studio.removeDocument(activeThread.id, id)} />}
          <Textarea
            ref={inputRef}
            aria-label="Message"
            name="message"
            autoComplete="off"
            placeholder={checking ? "Ask anything…" : installedModels.length ? "Ask anything…" : "Download a model to get started"}
            rows={1}
            maxLength={promptLimit}
            value={activeThread.draft}
            onChange={(event) => studio.updateThread(activeThread.id, { draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="text-composer-bottom">
            <div className="text-composer-model-controls">
              <input ref={documentInput} type="file" accept={CHAT_DOCUMENT_ACCEPT} aria-label="Chat document files" hidden multiple
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  void studio.attachDocuments(activeThread.id, files);
                }} />
              <IconButton aria-label="Attach documents" title={documents.length >= MAX_CHAT_DOCUMENTS ? "This chat has eight documents" : "Attach documents for this chat"}
                disabled={busy || documents.length >= MAX_CHAT_DOCUMENTS} onClick={() => documentInput.current?.click()}><Paperclip size={16} aria-hidden="true" /></IconButton>
              {selected?.supportsVision && <>
                <input ref={attachmentInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Chat image file" hidden onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void studio.attachImage(activeThread.id, file);
                }} />
                <IconButton aria-label="Attach chat image" title={activeThread.draftContextImage ? "Remove the selected conversation image to attach a new file" : "Attach chat image"} disabled={busy || !!activeThread.draftContextImage} onClick={() => attachmentInput.current?.click()}><ImagePlus size={16} aria-hidden="true" /></IconButton>
              </>}
              {selected?.supportsReasoning && <Select className="text-response-mode" aria-label="Response mode" value={activeThread.mode} disabled={busy} onChange={(event) => {
                const mode = event.target.value === "reasoning" ? "reasoning" : "instant";
                studio.updateThread(activeThread.id, { mode, ...(mode === "reasoning" && activeThread.maxNewTokens === 512 ? { maxNewTokens: 1024 } : {}) });
              }}><option value="instant">Instant</option><option value="reasoning">Reasoning</option></Select>}
            </div>
            <div className="composer-send-tools">
              <TextMenu label="Text model" value={selectedModel} disabled={busy} options={modelOptions} onSelect={(id) => studio.selectModel(activeThread.id, id)}>
                <MenuItem role="menuitem" onClick={openModels}>Manage models</MenuItem>
              </TextMenu>
            {runningHere ? <IconButton variant="danger" shape="circle" className="composer-submit is-stop" disabled={status.job.status !== "running"} onClick={() => void studio.stop(activeThread.id)} aria-label="Stop generation" title="Stop generation"><Square size={14} fill="currentColor" aria-hidden="true" /></IconButton> : <IconButton type="submit" variant="primary" shape="circle" className="composer-submit" disabled={busy || !activeThread.draft.trim() || !modelAvailable || !!runtimeIssue || needsRetry || incompatibleImages} aria-label="Send message" title={activity || unavailableReason || "Send message"}>{pendingHere ? <LoaderCircle className="spinner" size={16} aria-hidden="true" /> : <Send size={20} aria-hidden="true" />}</IconButton>}
            </div>
          </div>
        </form>
        <div className="text-composer-hint"><span role="status">{activity || unavailableReason || "Your conversations stay on this device"}</span><span className="text-keyboard-hint">{promptLimit && activeThread.draft.length > promptLimit * 0.9 ? `${activeThread.draft.length.toLocaleString()} / ${promptLimit.toLocaleString()}` : "Enter to send · Shift + Enter for newline"}</span></div>
        {empty && <div className="text-empty-actions" role="group" aria-label="Creation workspaces">
          <Button variant="ghost" onClick={onCreateImage}><ImagePlus size={15} aria-hidden="true" /> Create image</Button>
          <Button variant="ghost" onClick={onCreateSpeech}><AudioLines size={15} aria-hidden="true" /> Create speech</Button>
        </div>}
      </footer>
      </div>
      {panel && <aside id={inspectorId} className="generation-inspector text-inspector" ref={panelRef} tabIndex={-1} aria-label="Chat settings panel" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closePanel(); } }}>
        <div className="inspector-heading">
          <div className="inspector-tabs" role="group" aria-label="Chat inspector views">
            <Button variant="ghost" aria-pressed={panel === "settings"} onClick={() => showPanel("settings")}>Model</Button>
            <Button variant="ghost" aria-pressed={panel === "image"} onClick={() => showPanel("image")}>Image</Button>
          </div>
          <IconButton aria-label="Close chat settings" onClick={closePanel}><X size={16} aria-hidden="true" /></IconButton>
        </div>
        {panel === "settings" && <div className="text-inspector-body">
          <p className="text-panel-description">Settings for this conversation. Changes apply to your next response.</p>
          {busy && <p className="text-panel-description" role="status">{activity || "Settings are locked while a response is generating."}</p>}
          <div className="text-settings-grid">
            <label>Model<Select aria-label="Settings model" value={selectedModel} disabled={busy} onChange={event => studio.selectModel(activeThread.id, event.target.value)}>{!selectedModel && <option value="">Choose a model</option>}{models.map(model => <option key={model.id} value={model.id} disabled={!model.installed}>{model.name}{model.installed ? "" : " - Unavailable"}</option>)}</Select></label>
            <Button variant="ghost" className="text-compute-link" onClick={openModels}>Manage models</Button>
            {selected?.format === "gguf" && <TokenField key={`context-${activeThread.id}-${selected.id}`}
              label="Context length (tokens)" value={tokenLimits.contextSize} min={tokenLimits.contextMinimum}
              max={tokenLimits.contextMaximum} disabled={busy}
              help={selected.maxContextSize ? `Model limit ${tokenLimits.contextMaximum.toLocaleString()} tokens.` : "Larger contexts use more memory."}
              onChange={(contextSize) => studio.updateThread(activeThread.id, { contextSize })}
            />}
            {selected?.format === "gguf" && <details className="chat-advanced-settings">
              <summary>Advanced model loading</summary>
              <div className="text-settings-grid">
                <label>Flash Attention
                  <Select aria-label="Flash Attention" value={loadOptions.flashAttention ?? "auto"} disabled={busy}
                    onChange={(event) => updateLoadOptions({ flashAttention: event.currentTarget.value as GgufLoadOptions["flashAttention"] })}>
                    <option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option>
                  </Select>
                </label>
                <SamplingNumberField key={`prompt-batch-${activeThread.id}`}
                  field={{ label: "Prompt batch size", min: 1, max: tokenLimits.contextSize, step: 1, placeholder: "Runtime default" }}
                  value={loadOptions.promptBatch} disabled={busy} onChange={(promptBatch) => updateLoadOptions({ promptBatch })} />
                <SamplingNumberField key={`micro-batch-${activeThread.id}`}
                  field={{ label: "Microbatch size", min: 1, max: loadOptions.promptBatch ?? Math.min(2048, tokenLimits.contextSize), step: 1, placeholder: "Runtime default" }}
                  value={loadOptions.microBatch} disabled={busy} onChange={(microBatch) => updateLoadOptions({ microBatch })} />
                {([{ key: "keyCacheType", label: "KV key precision" }, { key: "valueCacheType", label: "KV value precision" }] as const)
                  .map(({ key, label }) => <label key={key}>{label}
                    <Select aria-label={label} value={loadOptions[key] ?? ""} disabled={busy}
                      onChange={(event) => updateLoadOptions({ [key]: event.currentTarget.value || undefined })}>
                      <option value="">Runtime default</option>
                      {KV_CACHE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                    </Select>
                  </label>)}
                <Button variant="ghost" className="text-compute-link" disabled={busy}
                  onClick={() => studio.updateThread(activeThread.id, { loadOptions: undefined })}>Reset model loading</Button>
              </div>
            </details>}
            <div className="field">
              <label htmlFor={fieldPrefix + "system-prompt"}>System prompt</label>
              <Textarea id={fieldPrefix + "system-prompt"} rows={3} maxLength={10_000} placeholder="Optional instructions for the model" value={activeThread.systemPrompt} disabled={busy} onChange={(event) => studio.updateThread(activeThread.id, { systemPrompt: event.target.value })} />
            </div>
            <ChatPresets presets={studio.chatPresets ?? []} disabled={busy}
              onApply={(id) => studio.applyChatPreset(activeThread.id, id)}
              onSave={(name, id) => studio.saveChatPreset(activeThread.id, name, id)} onDelete={studio.deleteChatPreset} />
            <TokenField key={`output-${activeThread.id}-${selectedModel}`}
              label="Maximum output (tokens)" value={tokenLimits.maxNewTokens} min={1} max={tokenLimits.outputMaximum}
              disabled={busy} onChange={(maxNewTokens) => studio.updateThread(activeThread.id, { maxNewTokens })}
              help={selected?.format === "gguf" ? "The prompt and response share the context window." : undefined}
            />
            <SamplingRangeField key={activeThread.id + "-temperature"} label="Temperature" value={activeThread.temperature}
              help="Lower for focused answers, higher for variety." min={0} max={2} disabled={busy}
              onChange={(temperature) => studio.updateThread(activeThread.id, { temperature })} />
            <SamplingRangeField key={activeThread.id + "-top-p"} label="Top P" value={activeThread.topP}
              help="Limits the range of words the model considers." min={0.01} max={1} disabled={busy}
              onChange={(topP) => studio.updateThread(activeThread.id, { topP })} />
            <details className="chat-advanced-settings">
              <summary>Advanced sampling</summary>
              <div className="text-settings-grid">
                {samplerNumberFields.map((field) => <SamplingNumberField key={`${activeThread.id}-${field.key}`}
                  field={field} value={activeThread.sampling?.[field.key]} disabled={busy}
                  onChange={(value) => updateSampling({ [field.key]: value })} />)}
                <label>Stop sequences
                  <Textarea rows={2} maxLength={8192} placeholder="One sequence per line" value={activeThread.sampling?.stopText ?? ""}
                    disabled={busy} onChange={(event) => updateSampling({ stopText: event.target.value })} />
                </label>
                <Button variant="ghost" className="text-compute-link" disabled={busy} onClick={() => studio.updateThread(activeThread.id, {
                  temperature: 0.7, topP: 0.9, maxNewTokens: 512, sampling: undefined,
                })}>Reset sampling</Button>
              </div>
            </details>
            {selected && <div className="chat-model-defaults">
              <Button variant="secondary" disabled={busy} onClick={() => {
                studio.saveModelDefaults(activeThread.id, selected.id);
                notify(`Saved defaults for ${selected.name}.`);
              }}>Save model defaults</Button>
              {studio.modelDefaults?.[selected.id] && <Button variant="ghost" className="text-compute-link" disabled={busy}
                onClick={() => studio.clearModelDefaults(selected.id)}>Clear defaults</Button>}
            </div>}
          </div>
        </div>}
        {panel === "image" && <div className="text-inspector-body">
          {!selected?.supportsTools || !selected.supportsVision ? <p className="text-panel-description">Choose a chat model with vision and tool calling to create images here.</p> : <div className="text-settings-grid">
            <label>Image generation model
              <Select aria-label="Image generation model" value={activeThread.imageModel} disabled={busy || !canUseImageSetup} onChange={(event) => studio.updateThread(activeThread.id, { imageModel: event.target.value })}>
                <option value="auto">{imageModels.length ? `Auto · ${imageModels[0].label}` : "Auto"}</option>
                {imageModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                {activeThread.imageModel !== "auto" && activeThread.imageModel !== "off" && !imageModel && <option value={activeThread.imageModel} disabled>Model unavailable</option>}
                <option value="off">Off</option>
              </Select>
            </label>
            {!canUseImageSetup ? <Button variant="ghost" className="text-compute-link" onClick={onOpenCompute}>Open compute settings</Button>
              : !imageModels.length ? <Button variant="ghost" className="text-compute-link" onClick={openImageSetup}>Browse image models</Button>
              : imageModel && imageSettings ? <>
                <ImageCanvasFields key={imageModel.id} model={imageModel.id} modelStatus={imageModel} settings={imageSettings} errors={imageErrors}
                  disabled={busy} idPrefix={fieldPrefix + "image-"} onChange={updateImageSettings} />
                <ImageBatchField model={imageModel.id} value={imageSettings.batchSize} disabled={busy} id={fieldPrefix + "image-batch-size"}
                  onChange={(batchSize) => updateImageSettings({ batchSize })} />
                <ImageSamplingFields model={imageModel.id} settings={imageSettings} errors={imageErrors}
                  disabled={busy} idPrefix={fieldPrefix + "image-"} onChange={updateImageSettings} />
                <details className="chat-advanced-settings">
                  <summary>Image style</summary>
                  <div className="text-settings-grid">
                    <div className="field">
                      <label htmlFor={fieldPrefix + "image-prompt-suffix"}>Image prompt additions</label>
                      <Textarea id={fieldPrefix + "image-prompt-suffix"} rows={3} maxLength={MAX_IMAGE_PROMPT_SUFFIX} value={imageSettings.promptSuffix} disabled={busy}
                        onChange={(event) => updateImageSettings({ promptSuffix: event.currentTarget.value })} />
                    </div>
                    <ImageStyleFields value={imageSettings.promptSuffix} disabled={busy} maxLength={MAX_IMAGE_PROMPT_SUFFIX}
                      onChange={(promptSuffix) => updateImageSettings({ promptSuffix })} />
                  </div>
                </details>
                {isKleinLoraModel(imageModel.id) && <ImageLoraFields key={`loras-${imageModel.id}`} loras={imageSettings.loras ?? []}
                  error={imageErrors?.loras} disabled={busy} onChange={(loras) => updateImageSettings({ loras })} />}
                {maxReferenceImages(imageModel.id) > 0 && <ChatImageReferenceFields key={`refs-${imageModel.id}`} settings={imageSettings}
                  limit={maxReferenceImages(imageModel.id)} disabled={busy} onChange={updateImageSettings} />}
              </> : null}
          </div>}
        </div>}
      </aside>}
      </div>
    </section>
  );
}
