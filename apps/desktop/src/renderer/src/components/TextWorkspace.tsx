import { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ImageOff from "lucide-react/dist/esm/icons/image-off.mjs";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Columns2 from "lucide-react/dist/esm/icons/columns-2.mjs";
import ArrowLeftRight from "lucide-react/dist/esm/icons/arrow-left-right.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import { TextChatMessage, type TextReplyProgress } from "./TextChatMessage";
import { TextComposerControls } from "./TextComposerControls";
import { TextPromptEditor } from "./TextPromptEditor";
import { TextPromptVersions } from "./TextPromptVersions";
import { TextReplyAnnouncement } from "./TextReplyAnnouncement";
import { TEXT_TRANSCRIPT_WINDOW_THRESHOLD, TextTranscriptWindow } from "./TextTranscriptWindow";
import { TextFindBar } from "./TextFindBar";
import { Button, IconButton, SegmentedControl, Select, Textarea } from "./ui/controls";
import { Slider } from "./ui/Slider";
import { NumberField } from "./ui/NumberField";
import { Disclosure } from "./ui/Disclosure";
import { InlineNotice } from "./ui/InlineNotice";
import { ProgressLabel } from "./ui/ProgressLabel";
import { Tooltip, TooltipIconButton } from "./ui/Tooltip";
import { WorkspaceThreadTitle } from "./WorkspaceThreadTitle";
import { ImageBatchField, ImageCanvasFields, ImageSamplingFields } from "./ImageGenerationFields";
import { ImageStyleFields } from "./ImageStyleFields";
import { ChatPresets } from "./ChatPresets";
import { ImageLoraFields } from "./ImageLoraFields";
import { ChatImageReferenceFields } from "./ChatImageReferenceFields";
import { ChatDocumentAttachments } from "./ChatDocuments";

import X from "lucide-react/dist/esm/icons/x.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import type { useTextChat } from "../hooks/useTextChat";
import { useTextScroll } from "../hooks/useTextScroll";
import { useTextDraftField } from "../hooks/useTextDraftField";
import { resolveAssetUrl } from "../lib/api";
import type { ChatSearchMatch } from "../lib/chatSearch";
import { notify } from "../lib/notifications";
import { canContinueTextReply, countTextPromptCharacters, findChatImage, latestTextPrompt, replyVersions, resolveTextModel, savedVersionForDeletedReply, showReplyVersion, TEXT_MESSAGE_CHARACTER_LIMIT, textPromptExceedsLimit, textRuntimeIssue, type GeneratedChatImage, type TextMessage } from "../lib/textThreads";
import { chatImageErrors, chatImageSettings, MAX_IMAGE_PROMPT_SUFFIX, type ChatImageSettings } from "../lib/chatImageSettings";
import { isKleinLoraModel, maxReferenceImages } from "../lib/imageModels";
import { chatTokenLimits, ggufLoadOptions, KV_CACHE_TYPES, type ChatPane, type GgufLoadOptions, type TextMode, type TextSamplingSettings, type TextThread } from "../lib/textThreads";
import type { SetupTask } from "../lib/modelSetup";
import type { ImageRecord } from "../lib/types";

type TextStudio = ReturnType<typeof useTextChat>;
const PROMPT_COUNT_THRESHOLD = TEXT_MESSAGE_CHARACTER_LIMIT - 2_000;
const PROMPT_LIMIT_MESSAGE = `OpenVINO accepts up to ${TEXT_MESSAGE_CHARACTER_LIMIT.toLocaleString()} characters per message.`;

interface TranscriptRow {
  message: TextMessage;
  messageId: string;
  contextChanged: boolean;
  key: string;
  estimatedHeight: number;
}

function TokenField({ label, value, min, max, disabled, help, onChange }: {
  label: string; value: number; min: number; max: number; disabled: boolean; help?: string;
  onChange: (number: number) => void;
}) {
  return <NumberField label={label} value={value} min={min} max={max} integer disabled={disabled} help={help}
    invalidHelp={`Use a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`}
    onChange={(next) => { if (next !== undefined) onChange(next); }} />;
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
  return <NumberField label={field.label} value={value} min={field.min} max={field.max} integer={field.step === 1}
    optional={!compact} hideLabel={compact} disabled={disabled} placeholder={field.placeholder} onChange={onChange} />;
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
      <Slider id={id} min={min} max={max} step={step} value={value} disabled={disabled} aria-describedby={id + "-help"}
        onChange={onChange} />
      <SamplingNumberField compact field={{ label: label + " value", min, max, step, placeholder: "" }}
        value={value} disabled={disabled} onChange={(next) => { if (next !== undefined) onChange(next); }} />
    </div>
  </div>;
}

interface ModelReadiness {
  label: string;
  detail?: string | null;
  tone?: "pending" | "error";
  action?: { label: string; run: () => void };
}

function ChatModelReadiness({ notice, actionRef }: { notice: ModelReadiness; actionRef: (node: HTMLButtonElement | null) => void }) {
  return <div className="text-model-readiness" data-tone={notice.tone}>
    <div className="text-model-readiness-message" role={notice.tone === "error" ? "alert" : "status"} aria-atomic="true">
      {notice.tone === "pending" ? <ProgressLabel>{notice.label}{notice.detail && <small>{notice.detail}</small>}</ProgressLabel>
        : <div><span>{notice.label}</span>{notice.detail && <small>{notice.detail}</small>}</div>}
    </div>
    {notice.action && <Button ref={actionRef} variant="secondary" onClick={notice.action.run}>{notice.action.label}</Button>}
  </div>;
}

function chatImageRecord(image: GeneratedChatImage, mtime: number): ImageRecord {
  return { ...image, url: `/outputs/${encodeURIComponent(image.name)}`, mtime };
}

function messageImages(message: TextMessage): GeneratedChatImage[] {
  return message.generatedImages?.length ? message.generatedImages : message.generatedImage ? [message.generatedImage] : [];
}

function estimateRowHeight(message: TextMessage) {
  const sample = message.content.slice(0, 30_000);
  const lines = sample.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 84)), 0);
  const illustration = message.generatedImage ? 420 : message.image ? 220 : 0;
  return 64 + lines * 25 + illustration + (message.reasoning ? 26 : 0) + (message.error ? 24 : 0);
}

function ChatImage({ image, ordinal, checked, checkStatus, onOpen, onRetryCheck, canRetryCheck, contextLabel, onInclude, showFindCaption }: {
  image: GeneratedChatImage;
  ordinal: number;
  checked?: boolean;
  checkStatus?: string;
  onOpen: () => void;
  onRetryCheck?: () => void;
  canRetryCheck?: boolean;
  contextLabel?: string;
  onInclude?: () => void;
  showFindCaption?: boolean;
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
      {(checked || checkStatus || onRetryCheck || contextLabel) && <span className="text-artifact-status">
        {checked && <span><Check size={14} aria-hidden="true" /> Image checked</span>}
        {checkStatus && <ProgressLabel className="text-artifact-progress">{checkStatus}</ProgressLabel>}
        {onRetryCheck && !checkStatus && <span>Image check incomplete</span>}
        {contextLabel && <span className="text-artifact-context">{contextLabel}</span>}
      </span>}
      <span className="text-artifact-metadata">{[image.modelLabel, `${image.width} × ${image.height}`].filter(Boolean).join(" · ")}</span>
    </figcaption>}
    {showFindCaption && <p className="text-find-image-caption" data-find-target>{image.prompt}</p>}
    {!failed && !checkStatus && (onRetryCheck || onInclude) ? <div className="text-artifact-actions">
      {onRetryCheck ? <Button variant="secondary" disabled={!canRetryCheck} onClick={(event) => {
        event.currentTarget.closest<HTMLElement>("[data-chat-message]")?.focus({ preventScroll: true });
        onRetryCheck();
      }}>Retry image check</Button> : null}
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
  onOpenThreadSearch: () => void;
  onClosePane: () => void;
  sidebarCollapsed?: boolean;
  onSetupModels: (task: SetupTask, threadId: string) => void;
  focusRequest?: number;
  findRequest?: { threadId: string; query: string } | null;
  onFindRequestHandled: () => void;
  imageGpuAvailable?: boolean;
  onOpenImage: (image: ImageRecord, images: ImageRecord[]) => void;
  onNewChat: () => void;
  onCreateImage: () => void;
  onCreateSpeech: () => void;
  onOpenCompute: () => void;
}

export function TextWorkspace({ studio, thread: activeThread, pane, focused, split, onChooseChat, onOpenThreadSearch, onClosePane,
  sidebarCollapsed = false, onSetupModels, focusRequest = 0, findRequest, onFindRequestHandled, imageGpuAvailable,
  onOpenImage, onNewChat, onCreateImage, onCreateSpeech, onOpenCompute }: TextWorkspaceProps) {
  const { status, statusError, actionError, busy } = studio;
  const { id: threadId, messages, draftImage, draftContextImage: draftContextName } = activeThread;
  const fieldPrefix = useId() + "-";
  const inspectorId = fieldPrefix + "chat-inspector";
  const deletionStatusId = fieldPrefix + "deletion-status";
  const draftLimitId = fieldPrefix + "draft-limit";
  const stopping = studio.isStopping(activeThread);
  const pendingReplyOutput = studio.pendingReplyOutput(activeThread);
  const documents = activeThread.documents ?? [];
  const [panel, setPanel] = useState<"settings" | "image" | null>(null);
  const inspectorOpen = panel !== null;
  const openModels = useCallback(() => { setPanel(null); onSetupModels("chat", threadId); }, [onSetupModels, threadId]);
  const openImageSetup = () => { setPanel(null); onSetupModels("chat-image", activeThread.id); };
  const panelRef = useRef<HTMLElement>(null);
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const findTrigger = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [findThreadId, setFindThreadId] = useState<string | null>(null);
  const [findInitialQuery, setFindInitialQuery] = useState("");
  const [findRevision, setFindRevision] = useState(0);
  const [findMatch, setFindMatch] = useState<ChatSearchMatch | null>(null);
  const [replyPreviews, setReplyPreviews] = useState<Record<string, string>>({});
  const findOpen = findThreadId === activeThread.id;
  const activeMatch = findOpen ? findMatch : null;
  const previousFind = useRef<ChatSearchMatch | null>(null);
  const previousFindPreview = useRef<{ threadId: string; messageId: string } | undefined>(undefined);
  const closeFind = useCallback(() => {
    setFindThreadId(null);
    findTrigger.current?.focus({ preventScroll: true });
  }, []);
  const { feedRef, transcriptRef, historyVisible, followingLatest, showScrollButton, restoreAnchorId, restoreReasoningId, jumpToLatest, revealMessage,
    onScroll, onFocus: onHistoryFocus, onKeyDown: onHistoryKeyDown } = useTextScroll(activeThread.id);
  const { fieldRef: inputRef, bindField: bindDraftField } = useTextDraftField(`composer:${activeThread.id}`, activeThread.draft, 200);
  const modelActionControl = useRef<HTMLButtonElement | null>(null);
  const bindModelAction = useCallback((button: HTMLButtonElement | null) => {
    if (!button && modelActionControl.current === document.activeElement) inputRef.current?.focus({ preventScroll: true });
    modelActionControl.current = button;
  }, []);
  const stopControl = useRef<HTMLButtonElement | null>(null);
  const bindStopControl = useCallback((button: HTMLButtonElement | null) => {
    // React detaches the ref before removing the focused Stop button.
    if (!button && stopControl.current === document.activeElement) inputRef.current?.focus({ preventScroll: true });
    stopControl.current = button;
  }, []);
  const undoButton = useRef<HTMLButtonElement>(null);
  const focusUndoFor = useRef<string | undefined>(undefined);
  const [focusJump, setFocusJump] = useState<{ threadId: string; messageId: string; block?: "start" } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ threadId: string; messageId: string } | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const dragDepth = useRef(0);
  const focusBranchId = useRef<string | undefined>(undefined);
  const focusAfterRevision = useRef<string | undefined>(undefined);
  const [editJump, setEditJump] = useState<{ threadId: string; messageId: string } | null>(null);
  const handledFocusRequest = useRef(0);
  useLayoutEffect(() => {
    if (!focused || focusRequest === handledFocusRequest.current) return;
    if (findRequest || document.activeElement?.closest('[role="menu"], [aria-haspopup="menu"][aria-expanded="true"], [aria-modal="true"]')) {
      handledFocusRequest.current = focusRequest;
      return;
    }
    if (panel) { setPanel(null); return; }
    handledFocusRequest.current = focusRequest;
    setFindThreadId(null);
    inputRef.current?.focus({ preventScroll: true });
  }, [findRequest, focusRequest, focused, panel]);
  useEffect(() => {
    if (findRequest?.threadId !== activeThread.id) return;
    setPanel(null);
    setFindInitialQuery(findRequest.query);
    setFindThreadId(activeThread.id);
    setFindRevision((value) => value + 1);
    onFindRequestHandled();
  }, [activeThread.id, findRequest, onFindRequestHandled]);
  const runningHere = status.job.status === "running" && status.job.threadId === activeThread?.id;
  const canFind = activeThread.messages.length > 0 || runningHere;
  useEffect(() => {
    if (!canFind || !focused) return;
    const onFind = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f"
        || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (findOpen) {
        findInput.current?.focus({ preventScroll: true });
        findInput.current?.select();
      } else {
        setPanel(null);
        setFindInitialQuery("");
        setFindThreadId(activeThread.id);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, [activeThread.id, canFind, findOpen, focused]);
  const sourceChat = activeThread.sourceThreadId ? studio.threads.find((thread) => thread.id === activeThread.sourceThreadId) : undefined;
  const promptEdit = activeThread.promptEdit;
  const deletions = studio.messageDeletions.get(activeThread.id);
  const deletion = deletions?.at(-1);
  const deletionCount = deletions?.length ?? 0;
  const dismissDeletionLabel = deletionCount > 1 ? "Dismiss undo for all deletions" : "Dismiss deletion notice";
  const { models, recommendedModels, ggufAvailable, ggufUnavailableReason, runtimeAvailable, runtimeError } = status;
  const modelOptions = useMemo(() => {
    const runtime = { ggufAvailable, ggufUnavailableReason, runtimeAvailable, runtimeError };
    const catalogIds = new Set(models.map((model) => model.id));
    return [
      ...models.map((model) => {
        const description = !model.installed ? "Unavailable" : textRuntimeIssue(runtime, model) ? "Runtime unavailable" : undefined;
        return { value: model.id, label: model.name, description, disabled: !!description };
      }),
      ...(recommendedModels ?? []).filter((model) => !model.installed && !catalogIds.has(model.id))
        .map((model) => ({ value: model.id, label: model.name, description: "Not installed", disabled: true })),
    ];
  }, [models, recommendedModels, ggufAvailable, ggufUnavailableReason, runtimeAvailable, runtimeError]);
  const installedModels = useMemo(() => models.filter((model) => model.installed), [models]);
  const selectedModel = resolveTextModel(status, activeThread) ?? "";
  const modelRecord = models.find((model) => model.id === selectedModel);
  const selected = modelRecord?.installed ? modelRecord : undefined;
  const modelAvailable = !!selected;
  const runtimeIssue = selected ? textRuntimeIssue(status, selected) : null;
  const attachment = studio.draftAttachments.get(activeThread.id);
  const attachingImage = attachment?.status === "saving";
  const attachmentRetry = attachment?.status === "failed" ? attachment.retryFile : undefined;
  const hasDraftImage = !!(activeThread.draftImage || activeThread.draftContextImage);
  const incompatibleImages = !selected?.supportsVision && hasDraftImage;
  const lastMessage = activeThread?.messages.at(-1);
  const replaceablePrompt = latestTextPrompt(activeThread.messages);
  const lastPrompt = useMemo(() => messages[messages.map((message) => message.role).lastIndexOf("user")], [messages]);
  const canRetry = modelAvailable && !runtimeIssue && (selected.supportsVision || !(lastPrompt?.image || lastPrompt?.includedImage));
  const hasPromptLimit = !!selected && selected.format !== "gguf";
  const draftCharacters = useMemo(() => hasPromptLimit && activeThread.draft.length >= PROMPT_COUNT_THRESHOLD
    ? countTextPromptCharacters(activeThread.draft, TEXT_MESSAGE_CHARACTER_LIMIT + 1) : undefined,
  [activeThread.draft, hasPromptLimit]);
  const draftTooLong = (draftCharacters ?? 0) > TEXT_MESSAGE_CHARACTER_LIMIT;
  const revisionTooLong = useMemo(() => hasPromptLimit && textPromptExceedsLimit(promptEdit?.content ?? ""),
    [hasPromptLimit, promptEdit?.content]);
  const canSend = !busy && !attachingImage && modelAvailable && !runtimeIssue && !incompatibleImages && !draftTooLong && (!!activeThread.draft.trim() || hasDraftImage);
  const canAttach = studio.attachmentReady && !attachingImage && !activeThread.draftContextImage;
  useEffect(() => { dragDepth.current = 0; setFileOver(false); }, [activeThread.id]);
  const imageModels = status.imageToolModels ?? [];
  const imageModelAvailable = imageModels.some((model) => activeThread?.imageModel === "auto" || activeThread?.imageModel === model.id);
  const canUseImageSetup = studio.computeDevice === "GPU" && imageGpuAvailable !== false;
  const canCreateImage = canUseImageSetup && !runtimeIssue && selected?.supportsVision && selected.supportsTools && imageModelAvailable;
  const phase = runningHere ? status.job.phase ?? "" : "";
  const empty = !activeThread?.messages.length && !runningHere;
  const checking = !studio.statusLoaded && !statusError;
  const catalogError = statusError ?? status.registryError;
  const install = status.modelInstall;
  const installing = install?.status === "downloading" || install?.status === "preparing";
  const installName = status.recommendedModels?.find((model) => model.id === install?.modelId)?.name
    ?? models.find((model) => model.id === install?.modelId)?.name;
  const modelSetupAction = { label: installedModels.some((model) => model.id !== selectedModel && !textRuntimeIssue(status, model))
    ? "Choose another model" : "Browse models", run: openModels };
  const pendingHere = !!activeThread?.pendingJobId && !runningHere;
  const responseHere = runningHere || pendingHere;
  const deferredBusy = useDeferredValue(busy);
  const deferredResponseHere = useDeferredValue(responseHere);
  // Disable these actions immediately. Re-enabling history controls can wait
  // until the final reply and composer have updated.
  const canForkReplies = !busy && !deferredBusy;
  const canDeleteMessages = !responseHere && !deferredResponseHere;
  const displayJobId = activeThread.pendingJobId ?? (runningHere ? status.job.id : null);
  const inspectionMessageId = displayJobId ? activeThread.messages.find((message) => message.inspectionJobId === displayJobId)?.id : undefined;
  const liveJob = displayJobId && status.job.id === displayJobId && status.job.threadId === activeThread.id ? status.job : null;
  const restoringReply = pendingHere && !liveJob && !studio.submitting;
  const restorationLabel = studio.statusLoaded ? inspectionMessageId ? "Recovering image check…" : "Recovering response…"
    : "Checking for the previous response…";
  const replyContent = pendingReplyOutput?.content || liveJob?.partialText || "";
  const replyReasoning = pendingReplyOutput?.reasoning ?? liveJob?.partialReasoning;
  const replyImages = liveJob?.images ?? pendingReplyOutput?.generatedImages;
  const replyImage = liveJob?.image ?? replyImages?.[0] ?? pendingReplyOutput?.generatedImage;
  useEffect(() => { setDeleteTarget(null); }, [activeThread.id, responseHere]);
  const runningThread = status.job.status === "running" ? studio.threads.find((thread) => thread.id === status.job.threadId) : undefined;
  const otherResponseThread = responseHere ? undefined : runningThread ?? studio.threads.find((thread) => thread.pendingJobId);
  const reconnecting = !!statusError && (responseHere || !!otherResponseThread);
  const creatingImage = phase.startsWith("Generating image") || phase.startsWith("Generating an image");
  // Image batches publish previews before generation finishes. An existing
  // preview only implies review after the image generation phase ends.
  const checkingImage = responseHere && !restoringReply && !reconnecting && !stopping && !creatingImage &&
    (!!inspectionMessageId || runningHere && (phase.startsWith("Checking") || !!liveJob?.inspection || !!replyImage));
  const inspectionCaption = reconnecting ? (stopping ? "Reconnecting to stop…" : "Reconnecting to check the image…")
    : stopping ? "Stopping image check…" : restoringReply ? restorationLabel : "Checking image…";
  const modelNotice: ModelReadiness | null = responseHere || otherResponseThread ? null
    : installing ? { label: `Installing ${installName ?? "a chat model"}`, detail: install.phase, tone: "pending", action: { label: "View model download", run: openModels } }
    : studio.modelAction ? { label: studio.modelAction, tone: "pending" }
    : checking ? { label: "Checking local models…", tone: "pending" }
    : catalogError && !modelAvailable ? { label: "Could not check local models.", detail: catalogError, tone: "error",
        action: { label: "Retry checking models", run: () => { void studio.refresh(); } } }
    : install?.status === "failed" && !modelAvailable && (!selectedModel || selectedModel === install.modelId)
      ? { label: "Model download failed.", detail: install.error, tone: "error", action: { label: "Open model setup", run: openModels } }
    : selectedModel && !modelAvailable ? { label: modelRecord ? `${modelRecord.name} is unavailable.` : "This chat’s model is unavailable.",
        detail: modelRecord?.error, tone: "error", action: modelSetupAction }
    : !modelAvailable ? { label: "Download a local model to start chatting.", action: { label: "Browse models", run: openModels } }
    : runtimeIssue ? { label: "The selected model can’t run right now.", detail: runtimeIssue, tone: "error", action: modelSetupAction }
    : null;
  const localError = actionError && (actionError.threadId ? actionError.threadId === threadId : focused) ? actionError : null;
  const catalogNotice = reconnecting || modelNotice?.tone === "error" ? null : catalogError;
  const undoBlocked = responseHere;
  const replyPaused = runningHere && studio.replyPaused;
  const statusLabel = reconnecting ? stopping ? "Reconnecting to stop…" : "Reconnecting to the text runtime…"
    : stopping ? "Stopping…"
    : restoringReply ? restorationLabel
    : pendingHere ? liveJob && liveJob.status !== "idle" ? "Finishing response…" : "Starting response…"
    : creatingImage ? "Creating an image…"
    : phase.startsWith("Finding document") ? phase
    : phase.includes("Compacting") ? "Summarizing earlier messages…"
    : /download/i.test(phase) ? "Downloading the text runtime…"
    : /^(loading|starting the text worker)/i.test(phase) ? "Loading model…" : null;
  const hasReplyContent = !!replyContent.trim();
  const hasReplyReasoning = !!replyReasoning?.trim();
  const waitingForToken = phase.startsWith("Waiting for");
  const replyProgress = useMemo<TextReplyProgress>(() => checkingImage ? { kind: "image-check", label: "Checking the image…" }
    : statusLabel ? { kind: "status", label: statusLabel }
    : hasReplyContent ? { kind: "answer", label: replyPaused ? "Waiting for more text…" : "Responding…", waiting: replyPaused }
    : hasReplyReasoning ? { kind: "reasoning", label: replyPaused ? "Still reasoning…" : "Reasoning…" }
    : { kind: "status", label: waitingForToken
      ? replyPaused ? "Still waiting for the first token…" : "Waiting for the first token…" : "Preparing conversation…" },
  [checkingImage, hasReplyContent, hasReplyReasoning, replyPaused, statusLabel, waitingForToken]);
  const unavailableReason = modelNotice?.label ?? (!modelAvailable ? "Choose an installed model to send" : incompatibleImages ? "Choose a vision model or remove the attachment" : "");
  const activity = responseHere ? replyProgress.label
    : reconnecting ? "Reconnecting to the running chat…"
    : studio.attachingDocument ? "Reading documents…"
    : otherResponseThread ? runningThread ? "A response is running in another chat" : "A response is starting in another chat" : "";
  const streamId = displayJobId && !liveJob?.inspection && !inspectionMessageId ? `response-${displayJobId}` : null;
  const replyStartedAt = (liveJob?.startedAt ?? 0) * 1000;
  const replyModelName = models.find((model) => model.id === liveJob?.modelId)?.name ?? selected?.name;
  const streamingMessage = useMemo<TextMessage | null>(() => streamId ? {
    id: streamId, role: "assistant", createdAt: replyStartedAt,
    modelName: replyModelName,
    content: replyContent,
    reasoning: replyReasoning,
    generatedImage: replyImage,
    generatedImages: replyImages,
  } : null, [replyContent, replyImage, replyImages, replyModelName, replyReasoning, replyStartedAt, streamId]);
  const foundMessageId = activeMatch?.savedPromptId ? undefined : activeMatch?.messageId;
  const foundVersionId = foundMessageId ? activeMatch?.versionId : undefined;
  const displayMessages = useMemo(() => activeThread.messages.map((message) => {
    const previewId = foundMessageId === message.id ? foundVersionId : replyPreviews[`${activeThread.id}:${message.id}`];
    return showReplyVersion(message, previewId);
  }), [activeThread.id, activeThread.messages, foundMessageId, foundVersionId, replyPreviews]);
  const storedRows = useMemo<TranscriptRow[]>(() => {
    let previouslyTrimmed = false;
    let previouslySummarized = false;
    return displayMessages.map((message, index) => {
      const stored = activeThread.messages[index];
      const context = stored.requestContext;
      const trimmed = !!(context?.omittedMessages || context?.shortenedMessages || context?.omittedAttachments);
      const summarized = (stored.metrics?.context?.compactedMessages ?? 0) > 0;
      const contextChanged = (trimmed && !previouslyTrimmed) || (summarized && !previouslySummarized);
      if (stored.role === "assistant") {
        previouslyTrimmed = trimmed;
        previouslySummarized = summarized;
      }
      const versionAnchor = message.alternatives?.length ? replyVersions(message)[0].id : message.id;
      return { message, messageId: stored.id, contextChanged, key: `${activeThread.id}:${versionAnchor}`, estimatedHeight: estimateRowHeight(message) };
    });
  }, [activeThread.id, activeThread.messages, displayMessages]);
  // Retry leaves the selected answer in history until its replacement settles.
  // Keep that answer's row mounted across the wait, stream, and final version.
  const retryRow = streamId && lastMessage?.role === "assistant" ? storedRows.at(-1) : undefined;
  const showPreviousReply = !!retryRow && (
    (!hasReplyContent && !hasReplyReasoning && !replyImage) || activeMatch?.messageId === retryRow.messageId
  );
  const liveKey = streamId ? retryRow?.key ?? `${threadId}:${streamId}` : undefined;
  const liveMessageId = showPreviousReply ? retryRow?.messageId : streamId;
  const latestReplyId = liveMessageId ?? (lastMessage?.role === "assistant" ? lastMessage.id : undefined);
  const transcript = useMemo(() => {
    if (!liveKey || !liveMessageId) return storedRows;
    return [...(retryRow ? storedRows.slice(0, -1) : storedRows), { key: liveKey, messageId: liveMessageId, estimatedHeight: 0 }];
  }, [liveKey, liveMessageId, retryRow, storedRows]);
  const windowed = transcript.length > TEXT_TRANSCRIPT_WINDOW_THRESHOLD;
  const requestedEdit = editJump?.threadId === activeThread.id && editJump.messageId === promptEdit?.messageId ? editJump.messageId : undefined;
  const requestedFocus = focusJump?.threadId === activeThread.id ? focusJump : null;
  const requestedMessageId = requestedFocus?.messageId;
  const focusedMessageId = requestedMessageId && (requestedMessageId === liveMessageId ? liveMessageId : messages.find((message) =>
    message.id === requestedMessageId || message.alternatives?.some((version) => version.id === requestedMessageId))?.id);
  const revealId = focusedMessageId ?? requestedEdit ?? activeMatch?.messageId;
  const revealIndex = revealId ? transcript.findIndex(({ messageId }) => messageId === revealId) : -1;
  const revealKey = transcript[revealIndex]?.key;
  const restoreIndex = restoreAnchorId ? transcript.findIndex(({ messageId }, index) =>
    messageId === restoreAnchorId || activeThread.messages[index]?.id === restoreAnchorId,
  ) : -1;

  useLayoutEffect(() => {
    const previous = previousFindPreview.current;
    const find = !focusedMessageId && !requestedEdit ? activeMatch : null;
    if (find && (!historyVisible || !feedRef.current?.clientHeight)) return;
    const shouldScroll = !find || previousFind.current !== find;
    previousFind.current = find;
    const preview = find && (find.savedPromptId || find.versionId !== find.messageId || find.section !== "body" || promptEdit?.messageId === find.messageId);
    previousFindPreview.current = preview && revealId ? { threadId: activeThread.id, messageId: revealId } : undefined;
    const stopWatching = revealId ? revealMessage(revealId, find ?? undefined, requestedFocus?.block, shouldScroll) : undefined;
    if (!revealId && previous?.threadId === activeThread.id) revealMessage(previous.messageId);
    if (focusedMessageId) {
      feedRef.current?.querySelector<HTMLElement>(`[data-chat-message="${CSS.escape(focusedMessageId)}"]`)?.focus({ preventScroll: true });
      setFocusJump(null);
    }
    return stopWatching;
  }, [activeMatch, activeThread.id, feedRef, focusedMessageId, historyVisible, promptEdit?.messageId, requestedEdit, requestedFocus?.block, revealId, revealIndex, revealKey, revealMessage, windowed]);

  useLayoutEffect(() => {
    if (!deletion || focusUndoFor.current !== activeThread.id) return;
    focusUndoFor.current = undefined;
    undoButton.current?.focus({ preventScroll: true });
  }, [activeThread.id, deletion]);

  useLayoutEffect(() => {
    const openedBranch = focusBranchId.current === activeThread.id;
    const sentRevision = focusAfterRevision.current === activeThread.id && !promptEdit;
    if (!openedBranch && !sentRevision) return;
    if (openedBranch) focusBranchId.current = undefined;
    if (sentRevision) focusAfterRevision.current = undefined;
    inputRef.current?.focus({ preventScroll: true });
  }, [activeThread.id, promptEdit]);

  const closePanel = () => {
    setPanel(null);
    panelTrigger.current?.focus();
  };

  useEffect(() => {
    if (inspectorOpen && focused) panelRef.current?.focus();
  }, [focused, inspectorOpen]);

  const submit = () => {
    if (!canSend) return;
    jumpToLatest();
    inputRef.current?.focus({ preventScroll: true });
    void studio.send(activeThread.id, activeThread.draft);
  };

  const stageAttachment = useCallback((files: File[]) => {
    if (!files.length) return;
    inputRef.current?.focus({ preventScroll: true });
    void studio.attachImages(threadId, files);
  }, [inputRef, studio.attachImages, threadId]);
  const stageDocuments = useCallback((files: File[]) => {
    void studio.attachDocuments(threadId, files);
  }, [studio.attachDocuments, threadId]);
  const changeMode = useCallback((mode: TextMode) => {
    studio.updateThread(threadId, { mode, ...(mode === "reasoning" && activeThread.maxNewTokens === 512 ? { maxNewTokens: 1024 } : {}) });
  }, [activeThread.maxNewTokens, studio.updateThread, threadId]);
  const changeModel = useCallback((id: string) => studio.selectModel(threadId, id), [studio.selectModel, threadId]);

  const retry = useCallback(() => {
    jumpToLatest();
    inputRef.current?.focus({ preventScroll: true });
    void studio.retry(activeThread.id);
  }, [activeThread.id, inputRef, jumpToLatest, studio.retry]);
  const continueReply = useCallback((id: string) => {
    jumpToLatest();
    inputRef.current?.focus({ preventScroll: true });
    void studio.continueReply(activeThread.id, id);
  }, [activeThread.id, inputRef, jumpToLatest, studio.continueReply]);
  const stopFromComposer = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true });
    studio.stop(threadId);
  }, [inputRef, studio.stop, threadId]);

  const selectVersion = useCallback((messageId: string, versionId: string) => {
    if (messageId === lastMessage?.id) {
      studio.selectReply(activeThread.id, messageId, versionId);
      return;
    }
    setReplyPreviews((current) => ({ ...current, [`${activeThread.id}:${messageId}`]: versionId }));
  }, [activeThread.id, lastMessage?.id, studio.selectReply]);

  const branchReply = useCallback((message: TextMessage) => {
    setPanel(null);
    focusBranchId.current = studio.copyThread(activeThread.id, message.id);
  }, [activeThread.id, studio.copyThread]);
  const forkReply = useCallback((message: TextMessage) => {
    studio.copyThread(activeThread.id, message.id, true);
  }, [activeThread.id, studio.copyThread]);
  const editMessage = useCallback((message: TextMessage) => {
    setDeleteTarget(null);
    revealMessage(message.id);
    setEditJump({ threadId: activeThread.id, messageId: message.id });
    studio.updateThread(activeThread.id, { promptEdit: { messageId: message.id, content: message.content } });
  }, [activeThread.id, revealMessage, studio.updateThread]);
  const clearEditFocus = useCallback(() => setEditJump(null), []);
  const applyRevision = useCallback((sendNow: boolean) => {
    if (!promptEdit) return;
    setPanel(null);
    const action = !sendNow ? "draft" : promptEdit.messageId === replaceablePrompt?.id ? "replace" : "branch";
    const chatId = studio.revisePrompt(activeThread.id, promptEdit.messageId, promptEdit.content, action);
    if (action === "replace" && chatId) {
      focusAfterRevision.current = chatId;
      setFindThreadId(null);
      jumpToLatest();
    } else if (chatId) focusBranchId.current = chatId;
  }, [activeThread.id, jumpToLatest, promptEdit, replaceablePrompt?.id, studio.revisePrompt]);
  const requestDelete = useCallback((messageId: string | null) => {
    setDeleteTarget(messageId ? { threadId: activeThread.id, messageId } : null);
  }, [activeThread.id]);
  const deleteMessage = useCallback((id: string) => {
    setDeleteTarget(null);
    focusUndoFor.current = activeThread.id;
    studio.deleteMessage(activeThread.id, id);
  }, [activeThread.id, studio.deleteMessage]);
  const undoDeletion = () => {
    if (!deletion || undoBlocked) return;
    const prompt = activeThread.messages.find((message) => message.id === deletion.beforeId);
    const savedPrompt = prompt && savedVersionForDeletedReply(prompt, deletion) ? prompt : undefined;
    studio.undoMessageDeletion(activeThread.id);
    setFindThreadId(null);
    setFocusJump({ threadId: activeThread.id, messageId: savedPrompt?.id ?? deletion.messages[0].id });
    if (savedPrompt) notify("Reply restored to Prompt versions.");
  };
  const dismissDeletion = () => {
    if (!deletion) return;
    studio.dismissMessageDeletion(activeThread.id);
    const feed = feedRef.current;
    if (!showScrollButton || !feed) {
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    const viewport = feed.getBoundingClientRect();
    const visible = [...feed.querySelectorAll<HTMLElement>("[data-chat-message]")].filter((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
    for (const id of [deletion.afterId, deletion.beforeId]) {
      if (!id) continue;
      const message = activeThread.messages.find((item) => item.id === id || item.alternatives?.some((reply) => reply.id === id));
      const neighbor = visible.find((row) => row.dataset.chatMessage === message?.id);
      if (neighbor) { neighbor.focus({ preventScroll: true }); return; }
    }
    (visible[0] ?? feed).focus({ preventScroll: true });
  };

  const savedImages = useMemo(() => displayMessages.flatMap((message) => messageImages(message).map((image) => chatImageRecord(image, message.createdAt))), [displayMessages]);
  const imageCollection = useMemo(() => {
    if (!streamId || (!replyImage && !replyImages?.length)) return savedImages;
    const liveImages = replyImages?.length ? replyImages : replyImage ? [replyImage] : [];
    return [...savedImages, ...liveImages.filter((image) => !savedImages.some((saved) => saved.name === image.name))
      .map((image) => chatImageRecord(image, replyStartedAt))];
  }, [replyImage, replyImages, replyStartedAt, savedImages, streamId]);
  const draftArtifact = findChatImage(activeThread, activeThread.draftContextImage);
  const draftContextImage = imageCollection.find((image) => image.name === activeThread.draftContextImage) ?? (draftArtifact && chatImageRecord(draftArtifact, 0));
  const latestContext = useMemo(() => [...messages].reverse().find((message) => message.status === "complete")?.metrics?.context, [messages]);
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
  const showPanel = (view: "settings" | "image") => setPanel(view);
  const renderChatImage = useCallback((image: GeneratedChatImage, message?: TextMessage, { preview = false, reviewOnly = false, showFindCaption = false }: {
    preview?: boolean; reviewOnly?: boolean; showFindCaption?: boolean;
  } = {}) => {
    const existing = imageCollection.findIndex((item) => item.name === image.name);
    const collection = existing < 0 ? [...imageCollection, chatImageRecord(image, message?.createdAt ?? 0)] : imageCollection;
    const index = existing < 0 ? collection.length - 1 : existing;
    const firstImage = image.name === (message ? messageImages(message)[0]?.name : replyImage?.name);
    const canRecover = message && firstImage && !preview && (message.status === "failed" || message.status === "stopped") && !message.metrics?.visionChecked;
    const checkStatus = !firstImage ? undefined : message
      ? message.inspectionJobId && message.inspectionJobId === displayJobId ? inspectionCaption : undefined
      : checkingImage ? "Checking image…" : undefined;
    return <ChatImage key={image.name} image={image} ordinal={index + 1} showFindCaption={showFindCaption}
      checked={firstImage && message?.metrics?.visionChecked} checkStatus={checkStatus}
      onRetryCheck={canRecover ? () => void studio.retryInspection(threadId, message.id) : undefined}
      canRetryCheck={!busy && !!selected?.supportsVision && !runtimeIssue}
      contextLabel={draftContextName === image.name
        ? "Selected for next message"
        : message && latestContext?.imageNames?.includes(image.name) ? "Used in the latest response" : undefined}
      onInclude={message && !reviewOnly && !attachingImage && !draftImage && draftContextName !== image.name ? () => {
        studio.clearAttachment(threadId);
        studio.updateThread(threadId, { draftContextImage: image.name, draftContextImageThreadId: image.originThreadId ?? message.imageThreadId });
        inputRef.current?.focus();
      } : undefined}
      onOpen={() => onOpenImage(collection[index], collection)} />;
  }, [attachingImage, busy, checkingImage, displayJobId, draftContextName, draftImage, imageCollection, inputRef, inspectionCaption, latestContext, onOpenImage, replyImage?.name,
    runtimeIssue, selected?.supportsVision, studio.clearAttachment, studio.retryInspection, studio.updateThread, threadId]);

  const renderRow = useCallback((row: TranscriptRow, index: number, live?: { progress: TextReplyProgress; previous: boolean }) => {
    const { message } = row;
    const contextMessage = messages[index];
    const preview = !!contextMessage && row.messageId === contextMessage.id && contextMessage.id !== message.id;
    const match = activeMatch?.messageId === row.messageId ? activeMatch : undefined;
    const savedMatch = match?.savedPromptId ? match : undefined;
    const latest = contextMessage === lastMessage;
    const user = message.role === "user";
    const editing = user && promptEdit?.messageId === message.id;
    const replaceLatest = user && message.id === replaceablePrompt?.id;
    const hasImage = !!(message.image || message.includedImage);
    const editUnavailable = busy ? "Finish the current response before sending this revision."
      : !modelAvailable ? "Choose an installed model to send this revision."
      : runtimeIssue ? "The text runtime is unavailable."
      : hasImage && !selected?.supportsVision ? "Choose a vision model to send this image."
      : revisionTooLong ? PROMPT_LIMIT_MESSAGE : "";
    return <TextChatMessage
      key={row.key}
      selectionId={row.key}
      message={message}
      latest={latest}
      initialReasoningOpen={!!restoreReasoningId && row.messageId === restoreReasoningId}
      contextVersionId={row.messageId}
      findMatch={match}
      progress={live?.progress}
      previewWhileStreaming={live?.previous}
      contextChanged={row.contextChanged && !preview}
      generatedImage={message.generatedImage || message.generatedImages?.length ? messageImages(message).map((image, index) => renderChatImage(image, live && !live.previous ? undefined : message, { preview, showFindCaption: index === 0 && !savedMatch && match?.section === "image" })) : undefined}
      includedImageLabel={findChatImage({ messages }, message.includedImage)?.prompt}
      editor={editing && <TextPromptEditor draftKey={`revision:${threadId}:${message.id}`} content={promptEdit.content} original={message.content} replaceLatest={replaceLatest}
        focusRequested={requestedEdit === message.id}
        onFocusHandled={clearEditFocus} hasImage={hasImage} sendUnavailable={editUnavailable} invalid={revisionTooLong}
        onChange={(content) => studio.updateThread(threadId, { promptEdit: { messageId: message.id, content } })}
        onCancel={() => studio.updateThread(threadId, { promptEdit: undefined })} onApply={applyRevision}
        onResend={!replaceLatest ? () => { jumpToLatest(); void studio.send(threadId, promptEdit.content, message.id); } : undefined} />}
      promptVersions={user && (!editing || savedMatch) && !!message.promptAlternatives?.length && <TextPromptVersions alternatives={message.promptAlternatives}
        searchMatch={savedMatch} onCloseSearch={closeFind}
        busy={busy} onRestore={replaceLatest ? (id) => studio.restorePromptVersion(threadId, message.id, id) : undefined}
        renderImage={(reply) => reply.generatedImage && renderChatImage(reply.generatedImage, reply, { preview: true, reviewOnly: !!savedMatch })} />}
      onEdit={!live && user ? editMessage : undefined}
      editingAnother={user && !!promptEdit && !editing}
      onFork={!live && !user ? forkReply : undefined}
      canFork={canForkReplies}
      onBranch={!live && !user && (message.content.trim() || message.generatedImage) ? branchReply : undefined}
      onDelete={!live ? deleteMessage : undefined}
      onDeleteRequested={!live ? requestDelete : undefined}
      canDelete={canDeleteMessages}
      confirmDelete={canDeleteMessages && deleteTarget?.threadId === threadId && deleteTarget.messageId === contextMessage?.id}
      deleteTurn={user && messages[index + 1]?.role === "assistant"}
      onRetry={latest && !preview && !live && !user && !busy && (!message.generatedImage || message.status === "complete") ? retry : undefined}
      canRetry={latest && canRetry}
      onContinue={latest && !preview && !live && canContinueTextReply(message) ? continueReply : undefined}
      canContinue={latest && !busy && modelAvailable && !runtimeIssue}
      onSelectVersion={!user && !live && message.alternatives?.length ? selectVersion : undefined}
      busy={(latest && busy) || !!match}
    />;
  }, [activeMatch, applyRevision, branchReply, busy, canDeleteMessages, canForkReplies, canRetry, clearEditFocus, closeFind, continueReply,
    deleteMessage, deleteTarget, editMessage, forkReply, jumpToLatest, lastMessage, messages, modelAvailable, promptEdit, revisionTooLong, renderChatImage,
    replaceablePrompt?.id, requestDelete, requestedEdit, restoreReasoningId, retry, runtimeIssue, selectVersion, selected?.supportsVision,
    studio.restorePromptVersion, studio.send, studio.updateThread, threadId]);
  const renderStoredRow = useCallback((index: number) => renderRow(storedRows[index], index), [renderRow, storedRows]);
  const liveReply = useMemo(() => {
    if (!streamingMessage || !liveKey || !liveMessageId) return;
    const row = showPreviousReply && retryRow ? retryRow : {
      key: liveKey, messageId: liveMessageId, message: streamingMessage, contextChanged: false, estimatedHeight: 0,
    };
    return renderRow(row, transcript.length - 1, { progress: replyProgress, previous: showPreviousReply });
  }, [liveKey, liveMessageId, renderRow, replyProgress, retryRow, showPreviousReply, streamingMessage, transcript.length]);

  return (
    <section className={`text-workspace${empty ? " text-workspace--empty" : ""}`} aria-label={split ? pane === "primary" ? "Left chat" : "Right chat" : "Text conversation"}>
      <header className="workspace-header text-header">
        <div className="workspace-heading">
          <WorkspaceThreadTitle
            title={activeThread.title}
            switchLabel="Open text thread"
            sidebarCollapsed={sidebarCollapsed && !split}
            onOpen={split ? undefined : onOpenThreadSearch}
          />
          {sourceChat && <Tooltip content={`Open original chat · ${sourceChat.title}`} side="bottom"><Button variant="ghost" className="text-branch-source" aria-label="Open original chat" onClick={() => {
            focusBranchId.current = sourceChat.id;
            studio.selectThread(sourceChat.id);
          }}><GitBranch size={14} aria-hidden="true" /><span>Original chat</span></Button></Tooltip>}
        </div>
        <div className="text-header-actions">
          {activeThread.messages.length > 0 && <TooltipIconButton tooltip="Duplicate chat" tooltipSide="bottom" aria-label="Duplicate chat" disabled={busy}
            onClick={() => { studio.copyThread(activeThread.id); }}><Copy size={15} aria-hidden="true" /></TooltipIconButton>}
          {!!activeThread.versions?.length && <Select className="chat-version-select" aria-label="Conversation versions"
            value={null} placeholder="Versions" disabled={busy}
            options={activeThread.versions.map(({ id, label }) => ({ value: id, label }))}
            onChange={(id) => {
              jumpToLatest();
              studio.restoreVersion(activeThread.id, id);
            }} />}
          <Tooltip content={split ? "Choose another chat for this pane" : "Open split chat"} side="bottom">
            <IconButton aria-label={split ? "Choose another chat for this pane" : "Open split chat"} onClick={onChooseChat}>
              {split ? <ArrowLeftRight size={15} aria-hidden="true" /> : <Columns2 size={15} aria-hidden="true" />}
            </IconButton>
          </Tooltip>
          {promptEdit && windowed && <TooltipIconButton aria-label="Resume prompt edit" tooltip="Resume prompt edit" tooltipSide="bottom" onClick={() => {
            setPanel(null);
            setFindThreadId(null);
            setEditJump({ threadId: activeThread.id, messageId: promptEdit.messageId });
          }}><Pencil size={16} aria-hidden="true" /></TooltipIconButton>}
          {canFind && <Tooltip content="Find in chat" side="bottom">
            <IconButton ref={findTrigger} aria-label="Find in chat" aria-expanded={findOpen} onClick={() => { setPanel(null); setFindInitialQuery(""); setFindThreadId(findOpen ? null : activeThread.id); }}><Search size={16} aria-hidden="true" /></IconButton>
          </Tooltip>}
          <Tooltip content="New chat" side="bottom"><IconButton aria-label="New chat" onClick={onNewChat}><Plus size={18} aria-hidden="true" /></IconButton></Tooltip>
          <Button ref={panelTrigger} variant="secondary" className="workspace-settings-button" aria-label="Chat settings" aria-expanded={panel !== null} aria-controls={panel ? inspectorId : undefined} onClick={() => { if (panel) closePanel(); else { setFindThreadId(null); setPanel("settings"); } }}><Settings2 size={15} aria-hidden="true" /><span>Chat settings</span></Button>
          {split && <TooltipIconButton tooltip="Close pane" tooltipSide="bottom" aria-label="Close pane" onClick={onClosePane}><X size={16} aria-hidden="true" /></TooltipIconButton>}
        </div>
      </header>

      <div className={`text-layout${panel ? " text-layout--inspecting" : ""}`}>
      <div className="text-main">
      {findOpen && <TextFindBar key={`${activeThread.id}:${findRevision}`} input={findInput} initialQuery={findInitialQuery}
        messages={activeThread.messages} liveMessage={streamingMessage} onMatch={setFindMatch} onClose={closeFind} />}
      <div className="text-conversation" ref={feedRef} onScroll={onScroll} onFocusCapture={onHistoryFocus} onKeyDown={onHistoryKeyDown} data-following={followingLatest || undefined} tabIndex={0} role="log" aria-label="Conversation" aria-live="off">
        <div className="text-transcript" ref={transcriptRef}>
        {!activeThread.messages.length && !runningHere ? (
          <div className="text-empty-state">
            <h3>What can I help with?</h3>
            {modelNotice && <ChatModelReadiness notice={modelNotice} actionRef={bindModelAction} />}
            {studio.statusLoaded && !catalogError && !installing && !studio.modelAction && modelNotice?.tone !== "error" && canUseImageSetup && status.ggufAvailable === true && !canCreateImage &&
              <Button variant="ghost" onClick={openImageSetup}>Set up images in chat</Button>}
            {canCreateImage && <Button variant="ghost" onClick={() => {
              if (!activeThread.draft.trim()) studio.updateThread(activeThread.id, { draft: "Create a small poster with a red circle on cream, then describe what you see." });
              inputRef.current?.focus();
            }}>Try creating a poster</Button>}
          </div>
        ) : null}

        <TextTranscriptWindow key={threadId} threadId={threadId} items={transcript} revealIndex={revealIndex} restoreIndex={restoreIndex}
          renderItem={renderStoredRow} liveReply={liveReply} />
        {lastMessage?.role === "user" && !busy && <Button variant="secondary" className="text-retry" disabled={!canRetry} onClick={retry}><RotateCcw size={15} aria-hidden="true" />Retry response</Button>}

        </div>
      </div>

      <footer className="text-composer-area">
        {showScrollButton && <TooltipIconButton shape="circle" className="text-scroll-latest" aria-label="Jump to latest message" tooltip="Jump to latest message" onClick={() => { jumpToLatest(); inputRef.current?.focus({ preventScroll: true }); }}><ArrowDown size={16} aria-hidden="true" /></TooltipIconButton>}
        {studio.storageError && <InlineNotice tone="error" announce
          actions={<Button variant="secondary" onClick={studio.retryStorage}>Retry saving chats</Button>}>
          {studio.storageError}
        </InlineNotice>}
        {localError ? <InlineNotice tone="error" announce actions={<>
          {localError.recovery === "image-settings" && <Button variant="secondary" onClick={() => {
            setFindThreadId(null);
            setPanel("image");
            panelRef.current?.focus({ preventScroll: true });
            studio.dismissActionError(localError);
          }}>Open image settings</Button>}
          <Button variant="ghost" onClick={() => {
            inputRef.current?.focus({ preventScroll: true });
            studio.dismissActionError(localError);
          }}>Dismiss error</Button>
        </>}>{localError.message}</InlineNotice>
          : catalogNotice && <InlineNotice tone="error" announce
            actions={<Button variant="secondary" onClick={() => { void studio.refresh(); }}>Refresh status</Button>}>
            {catalogNotice}
          </InlineNotice>}
        {!empty && modelNotice && <ChatModelReadiness notice={modelNotice} actionRef={bindModelAction} />}
        {deletion && <div className="text-deletion-notice">
          <span id={deletionStatusId} role="status">{deletion.messages.length > 1 ? "Message and reply deleted." : deletion.messages[0].role === "assistant" ? "Reply deleted." : "Message deleted."}
            {deletionCount > 1 && ` ${deletionCount} deletions to undo.`}
            {undoBlocked && " Undo is available after the response."}</span>
          <Button ref={undoButton} variant="ghost" aria-describedby={deletionStatusId} disabled={undoBlocked} onClick={undoDeletion}>Undo deletion</Button>
          <TooltipIconButton aria-label={dismissDeletionLabel} tooltip={dismissDeletionLabel}
            onClick={dismissDeletion}><X size={14} aria-hidden="true" /></TooltipIconButton>
        </div>}
        <form className={`text-composer${fileOver ? " is-file-over" : ""}`} onSubmit={(event) => { event.preventDefault(); submit(); }}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            dragDepth.current += 1;
            setFileOver(canAttach);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = canAttach ? "copy" : "none";
          }}
          onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setFileOver(false); } }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            dragDepth.current = 0;
            setFileOver(false);
            const files = Array.from(event.dataTransfer.files);
            if (files.every((file) => file.type.startsWith("image/"))) stageAttachment(files);
            else void studio.attachDocuments(activeThread.id, files);
          }}>
          {attachment?.status === "saving" && <div className="text-attachment-notice">
            <LoaderCircle className="spinner" size={15} aria-hidden="true" />
            <span className="text-attachment-status" role="status"><span title={attachment.filename}>{attachment.filename}</span><small>Attaching image…</small></span>
            <TooltipIconButton aria-label="Cancel image attachment" tooltip="Cancel image attachment" onClick={() => {
              studio.clearAttachment(activeThread.id);
              inputRef.current?.focus({ preventScroll: true });
            }}><X size={14} aria-hidden="true" /></TooltipIconButton>
          </div>}
          {attachment?.status === "failed" && <div className="text-attachment-notice text-attachment-notice--error">
            <span role="alert">{attachment.message}</span>
            {attachmentRetry && <Button variant="ghost" aria-label="Retry image attachment" onClick={() => stageAttachment([attachmentRetry])}>Retry</Button>}
            <TooltipIconButton aria-label="Dismiss attachment message" tooltip="Dismiss attachment message" onClick={() => {
              studio.clearAttachment(activeThread.id);
              inputRef.current?.focus({ preventScroll: true });
            }}><X size={14} aria-hidden="true" /></TooltipIconButton>
          </div>}
          {activeThread.draftContextImage ? <div className="text-draft-image text-draft-context">
            {draftContextImage && <img src={resolveAssetUrl(draftContextImage.url, draftContextImage.mtime)} alt="" onError={(event) => { event.currentTarget.hidden = true; }} key={draftContextImage.name} />}
            <span>Selected for next message: {draftContextImage?.prompt || activeThread.draftContextImage}</span>
            <IconButton aria-label="Remove selected conversation image" onClick={() => {
              studio.updateThread(activeThread.id, { draftContextImage: undefined, draftContextImageThreadId: undefined });
              inputRef.current?.focus({ preventScroll: true });
            }}><X size={14} aria-hidden="true" /></IconButton>
          </div> : null}
          {activeThread.draftImage && <div className="text-draft-image">
            <img src={resolveAssetUrl(`/references/${activeThread.draftImage}`)} alt="Image to send" />
            <IconButton aria-label="Remove chat image" disabled={attachingImage} onClick={() => {
              studio.updateThread(activeThread.id, { draftImage: undefined });
              inputRef.current?.focus({ preventScroll: true });
            }}><X size={14} aria-hidden="true" /></IconButton>
          </div>}
          {latestReplyId && <Button className="text-latest-reply-link" onClick={() => {
            setFindThreadId(null);
            setFocusJump({ threadId, messageId: latestReplyId, block: "start" });
          }}>Go to latest reply</Button>}
          {documents.length > 0 && <ChatDocumentAttachments documents={documents} disabled={busy} onRemove={(id) => studio.removeDocument(activeThread.id, id)} />}
          <Textarea
            key={activeThread.id}
            ref={bindDraftField}
            autosize
            aria-label="Message"
            aria-invalid={draftTooLong || undefined}
            aria-describedby={draftTooLong ? draftLimitId : undefined}
            name="message"
            autoComplete="off"
            placeholder={hasDraftImage ? "Ask about this image…" : "Write a message…"}
            rows={1}
            value={activeThread.draft}
            onChange={(event) => studio.updateThread(activeThread.id, { draft: event.target.value })}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.files).filter((item) => item.type.startsWith("image/"));
              if (!images.length) return;
              if (!event.clipboardData.getData("text/plain")) event.preventDefault();
              void studio.attachImages(activeThread.id, images);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && (runningHere || pendingHere) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void studio.stop(activeThread.id);
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                if (!event.repeat) submit();
              }
            }}
          />
          <TextComposerControls busy={busy} canAttach={canAttach} canSend={canSend} documentCount={documents.length}
            imageTooltip={activeThread.draftContextImage ? "Remove the selected conversation image to attach a new file"
              : attachingImage ? "Attaching image…" : "Attach chat image · Paste or drop an image"}
            mode={selected?.supportsReasoning ? activeThread.mode : undefined} model={selectedModel} models={modelOptions}
            responding={responseHere} stopping={stopping} stopRef={bindStopControl}
            sendTooltip={responseHere ? "" : attachingImage ? "Attaching image…"
              : activity || unavailableReason || (draftTooLong ? PROMPT_LIMIT_MESSAGE : "Send message")}
            onAttachDocuments={stageDocuments} onAttachImage={stageAttachment} onChangeMode={changeMode}
            onChangeModel={changeModel} onManageModels={openModels} onStop={stopFromComposer} />
        </form>
        {draftTooLong && <p id={draftLimitId} role="status" className="text-composer-limit">{PROMPT_LIMIT_MESSAGE} Shorten the draft or choose a GGUF model.</p>}
        <div className="text-composer-hint"><span role="status" aria-atomic="true">{modelNotice ? "" : activity || unavailableReason}</span>{otherResponseThread && <Button variant="ghost" className="text-open-running" onClick={() => studio.selectThread(otherResponseThread.id)}>Open running chat</Button>}<span className="text-keyboard-hint">{!draftTooLong && draftCharacters !== undefined && draftCharacters >= PROMPT_COUNT_THRESHOLD
          ? `${draftCharacters.toLocaleString()} / ${TEXT_MESSAGE_CHARACTER_LIMIT.toLocaleString()}` : "Enter to send · Shift + Enter for newline"}</span></div>
        <TextReplyAnnouncement key={activeThread.id} jobId={displayJobId} inspectionMessageId={inspectionMessageId} messages={activeThread.messages} conversation={feedRef} />
        {empty && <div className="text-empty-actions" role="group" aria-label="Creation workspaces">
          <Button variant="ghost" onClick={onCreateImage}><ImagePlus size={15} aria-hidden="true" /> Create image</Button>
          <Button variant="ghost" onClick={onCreateSpeech}><AudioLines size={15} aria-hidden="true" /> Create speech</Button>
        </div>}
      </footer>
      </div>
      {panel && <aside id={inspectorId} className="generation-inspector text-inspector" ref={panelRef} tabIndex={-1} aria-label="Chat settings panel" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closePanel(); } }}>
        <div className="inspector-heading">
          <SegmentedControl label="Chat inspector views" value={panel}
            options={[{ value: "settings", label: "Model" }, { value: "image", label: "Image" }]} onChange={showPanel} />
          <TooltipIconButton aria-label="Close chat settings" tooltip="Close chat settings" tooltipSide="bottom" onClick={closePanel}><X size={16} aria-hidden="true" /></TooltipIconButton>
        </div>
        {panel === "settings" && <div className="text-inspector-body">
          <p className="text-panel-description">Settings for this conversation. Changes apply to your next response.</p>
          {busy && <p className="text-panel-description" role="status">{activity || "Settings are locked while a response is generating."}</p>}
          <div className="text-settings-grid">
            <label>Model<Select aria-label="Settings model" value={selectedModel || null} placeholder="Choose a model" disabled={busy}
              options={models.map((model) => ({ value: model.id, label: model.installed ? model.name : `${model.name} · Unavailable`, disabled: !model.installed }))}
              onChange={(id) => studio.selectModel(activeThread.id, id)} /></label>
            <Button variant="ghost" className="text-compute-link" onClick={openModels}>Manage models</Button>
            {selected?.format === "gguf" && <TokenField key={`context-${activeThread.id}-${selected.id}`}
              label="Context length (tokens)" value={tokenLimits.contextSize} min={tokenLimits.contextMinimum}
              max={tokenLimits.contextMaximum} disabled={busy}
              help={selected.maxContextSize ? `Model limit ${tokenLimits.contextMaximum.toLocaleString()} tokens.` : "Larger contexts use more memory."}
              onChange={(contextSize) => studio.updateThread(activeThread.id, { contextSize })}
            />}
            {selected?.format === "gguf" && <Disclosure className="chat-advanced-settings" appearance="section" label="Advanced model loading">
              <div className="text-settings-grid">
                <label>Flash Attention
                  <Select<NonNullable<GgufLoadOptions["flashAttention"]>> aria-label="Flash Attention" value={loadOptions.flashAttention ?? "auto"} disabled={busy}
                    options={[{ value: "auto", label: "Auto" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]}
                    onChange={(flashAttention) => updateLoadOptions({ flashAttention })} />
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
                      options={[{ value: "", label: "Runtime default" }, ...KV_CACHE_TYPES.map((type) => ({ value: type, label: type }))]}
                      onChange={(value) => updateLoadOptions({ [key]: value || undefined })} />
                  </label>)}
                <Button variant="ghost" className="text-compute-link" disabled={busy}
                  onClick={() => studio.updateThread(activeThread.id, { loadOptions: undefined })}>Reset model loading</Button>
              </div>
            </Disclosure>}
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
            <Disclosure className="chat-advanced-settings" appearance="section" label="Advanced sampling">
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
            </Disclosure>
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
              <Select aria-label="Image generation model" value={activeThread.imageModel} disabled={busy || !canUseImageSetup}
                options={[
                  { value: "auto", label: imageModels.length ? `Auto · ${imageModels[0].label}` : "Auto" },
                  ...imageModels.map((model) => ({ value: model.id, label: model.label })),
                  ...(activeThread.imageModel !== "auto" && activeThread.imageModel !== "off" && !imageModel
                    ? [{ value: activeThread.imageModel, label: "Model unavailable", disabled: true }] : []),
                  { value: "off", label: "Off" },
                ]}
                onChange={(imageModel) => studio.updateThread(activeThread.id, { imageModel })} />
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
                <Disclosure className="chat-advanced-settings" appearance="section" label="Image style">
                  <div className="text-settings-grid">
                    <div className="field">
                      <label htmlFor={fieldPrefix + "image-prompt-suffix"}>Image prompt additions</label>
                      <Textarea id={fieldPrefix + "image-prompt-suffix"} rows={3} maxLength={MAX_IMAGE_PROMPT_SUFFIX} value={imageSettings.promptSuffix} disabled={busy}
                        onChange={(event) => updateImageSettings({ promptSuffix: event.currentTarget.value })} />
                    </div>
                    <ImageStyleFields value={imageSettings.promptSuffix} disabled={busy} maxLength={MAX_IMAGE_PROMPT_SUFFIX}
                      onChange={(promptSuffix) => updateImageSettings({ promptSuffix })} />
                  </div>
                </Disclosure>
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
