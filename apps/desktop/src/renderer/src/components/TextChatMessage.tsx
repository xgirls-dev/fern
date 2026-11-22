import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { chatSelectionIntersects } from "../hooks/useTextScroll";
import { resolveAssetUrl } from "../lib/api";
import type { ChatSearchMatch } from "../lib/chatSearch";
import { notify } from "../lib/notifications";
import { hasStreamingMarkdown } from "../lib/streamingMarkdown";
import { segmentGraphemes } from "../lib/text";
import { replyVersions, type TextMessage } from "../lib/textThreads";
import { ChatDocumentSources } from "./ChatDocuments";
import { TextMarkdown } from "./TextMarkdown";
import { TextMessageMenu, type MessageAction } from "./TextMessageMenu";
import { Button, IconButton } from "./ui/controls";

export type TextReplyProgress = { kind: "status" | "reasoning" | "answer" | "image-check"; label: string; waiting?: boolean };

function describeContextCount(count: number, subject: string, action: string) {
  return `${count.toLocaleString()} ${subject}${count === 1 ? " was" : "s were"} ${action}.`;
}

// Animate plain prose. Structured batches go straight to the Markdown renderer
// so a single update cannot replay intermediate formatting.
function useStreamedText(text: string, streaming: boolean) {
  const displayed = useRef(text);
  const [visible, setVisible] = useState(text);
  const animate = streaming && text.length <= 16_000 && !hasStreamingMarkdown(text) &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (!animate || !text.startsWith(displayed.current)) {
      displayed.current = text;
      setVisible(text);
      return;
    }
    const step = Math.max(3, Math.ceil((text.length - displayed.current.length) / 4));
    if (text === displayed.current) return;
    const graphemes = segmentGraphemes(text);
    const timer = window.setInterval(() => {
      const next = Math.min(text.length, displayed.current.length + step);
      // A character can include several code points, such as a joined emoji or accented letter.
      const last = graphemes.containing(next - 1);
      displayed.current = last ? text.slice(0, last.index + last.segment.length) : text;
      setVisible(displayed.current);
      if (displayed.current === text) window.clearInterval(timer);
    }, 22);
    return () => window.clearInterval(timer);
  }, [animate, text]);
  return animate && text.startsWith(visible) ? visible : text;
}

function useReplySelection(id: string, content: string, reasoning: string | undefined, streaming: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ replyId: string; pointerId: number } | null>(null);
  const committed = useRef({ content, reasoning, streaming });
  const [heldReply, setHeldReply] = useState<string>();
  const holding = heldReply === id;

  // Native selection offsets refer to the rendered Markdown, including its text nodes.
  useLayoutEffect(() => {
    if (!holding) committed.current = { content, reasoning, streaming };
  }, [content, holding, reasoning, streaming]);

  useLayoutEffect(() => {
    if (!streaming && !holding) return;
    const checkSelection = () => setHeldReply(
      pointer.current?.replyId === id || chatSelectionIntersects(bodyRef.current, reasoningRef.current) ? id : undefined,
    );
    const release = (event: PointerEvent) => {
      if (pointer.current?.pointerId !== event.pointerId) return;
      pointer.current = null;
      checkSelection();
    };
    const blur = () => {
      pointer.current = null;
      checkSelection();
    };
    document.addEventListener("selectionchange", checkSelection);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("selectionchange", checkSelection);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", blur);
    };
  }, [holding, id, streaming]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!streaming || event.defaultPrevented || event.button !== 0 || event.pointerType === "touch"
      || !(event.target instanceof Element) || event.target.closest("button, a, input, textarea")) return;
    pointer.current = { replyId: id, pointerId: event.pointerId };
    setHeldReply(id);
  };
  return { bodyRef, reasoningRef, onPointerDown, shown: holding ? committed.current : { content, reasoning, streaming } };
}

export const TextChatMessage = memo(function TextChatMessage({ message, initialReasoningOpen, contextVersionId, findMatch, progress, generatedImage, includedImageLabel, contextChanged, editor, promptVersions, editingAnother, onEdit, onBranch, onFork, onDelete, onDeleteRequested, confirmDelete, deleteTurn, onRetry, canRetry, onContinue, canContinue, onSelectVersion, busy }: {
  message: TextMessage;
  initialReasoningOpen?: boolean;
  contextVersionId?: string;
  findMatch?: ChatSearchMatch;
  progress?: TextReplyProgress;
  generatedImage?: ReactNode;
  includedImageLabel?: string;
  contextChanged?: boolean;
  editor?: ReactNode;
  promptVersions?: ReactNode;
  editingAnother?: boolean;
  onEdit?: (message: TextMessage) => void;
  onFork?: () => void;
  onBranch?: (message: TextMessage) => void;
  onDelete?: (id: string) => void;
  onDeleteRequested?: (id: string | null) => void;
  confirmDelete?: boolean;
  deleteTurn?: boolean;
  onRetry?: () => void;
  canRetry?: boolean;
  onContinue?: (id: string) => void;
  canContinue?: boolean;
  onSelectVersion?: (messageId: string, versionId: string) => void;
  busy?: boolean;
}) {
  const [detailsFor, setDetailsFor] = useState<{ id: string; placement: "context" | "actions" }>();
  const [reasoningOpen, setReasoningOpen] = useState(!!initialReasoningOpen);
  const [copiedId, setCopiedId] = useState<string>();
  const copyTimer = useRef<number | undefined>(undefined);
  const menuButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const confirmationDescription = useId();
  const detailsId = useId();
  const wasEditing = useRef(false);
  const editing = !!editor;
  const findSection = findMatch?.savedPromptId ? undefined : findMatch?.section;
  const revealReasoning = findSection === "reasoning";
  const reasoningExpanded = revealReasoning || reasoningOpen;
  const streaming = !!progress;
  const assistant = message.role === "assistant";
  const animatedContent = useStreamedText(message.content, progress?.kind === "answer");
  const { bodyRef, reasoningRef, onPointerDown, shown } = useReplySelection(message.id, animatedContent, message.reasoning, streaming);
  const { content, reasoning } = shown;
  const hasAnswer = !!content.trim();
  const showCursor = progress?.kind === "answer" && hasAnswer;
  const reasoningInProgress = progress?.kind === "reasoning" && !!message.reasoning;
  const checkingImageInCaption = progress?.kind === "image-check" && !!generatedImage;
  const indicator = progress && <span className="text-thinking"><LoaderCircle className="spinner" size={15} aria-hidden="true" />{progress.label}</span>;
  const stoppedNote = hasAnswer ? "Stopped · Partial response" : message.generatedImage ? "Stopped · Image saved"
    : message.reasoning ? "Stopped during reasoning" : "Stopped before any text was generated";
  const recoveryNote = message.status === "stopped" ? stoppedNote
    : message.status === "complete" && message.metrics?.finishReason === "length" ? "Reached the output limit" : null;
  const modelName = message.modelName ?? message.metrics?.modelName;
  const versions = onSelectVersion && message.alternatives?.length ? replyVersions(message) : [];
  const version = versions.findIndex((item) => item.id === message.id);
  const contextVersion = versions.findIndex((item) => item.id === contextVersionId);
  const showDetails = detailsFor?.id === message.id;
  const showContextDetails = showDetails && detailsFor?.placement === "context";
  const requestContext = message.requestContext;
  const runtimeContext = message.metrics?.context;
  const contextNotice = contextChanged ? [
    requestContext?.omittedMessages ? "Some earlier messages were left out." : "",
    requestContext?.shortenedMessages ? "Some messages were shortened." : "",
    requestContext?.omittedAttachments ? "Some earlier image attachments were left out." : "",
    runtimeContext?.compactedMessages ? "Earlier messages were summarized to fit this response." : "",
  ].filter(Boolean).join(" ") : "";
  const copied = copiedId === message.id;
  const targetId = contextVersionId ?? message.id;
  const retryLabel = message.status === "failed" || message.status === "stopped" ? "Retry response" : "Regenerate response";
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  useLayoutEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);

  const copy = async () => {
    try {
      await window.studio.copyText(message.content);
      setCopiedId(message.id);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(undefined), 1300);
    } catch {
      notify("Could not copy the message. You can select and copy its text.", "error");
    }
  };
  const cancelDelete = () => {
    onDeleteRequested?.(null);
    menuButton.current?.focus({ preventScroll: true });
  };
  const actions: MessageAction[] = [];
  if (onBranch) actions.push({ label: "Branch from response", icon: GitBranch, run: () => onBranch(message) });
  if (assistant) actions.push({ label: showDetails ? "Hide response details" : "Response details", icon: Info,
    run: () => setDetailsFor(showDetails ? undefined : { id: message.id, placement: "actions" }) });
  if (onDelete && onDeleteRequested) actions.push({ label: assistant ? "Delete reply" : "Delete message", icon: Trash2,
    run: () => onDeleteRequested(targetId), destructive: true });

  const detailPanel = showDetails ? <div className={`text-response-details${showContextDetails ? " text-response-details--context" : ""}`} id={detailsId} role="region" aria-label="Response details">
    <span className="text-message-label">{modelName ?? "Local model"}</span>
    {message.metrics && <span>
      {[message.metrics.backend, message.metrics.device, `${message.metrics.inputTokens} in / ${message.metrics.outputTokens} out`, `${message.metrics.tokensPerSecond.toFixed(1)} tokens/s`, `${message.metrics.generationSeconds.toFixed(1)} s`].filter(Boolean).join(" · ")}
      <br />Temperature {message.metrics.temperature ?? "unknown"} · Top P {message.metrics.topP ?? "unknown"} · Seed {message.metrics.seed ?? "unknown"} · Max tokens {message.metrics.maxNewTokens ?? "unknown"}
      {runtimeContext && <><br />{runtimeContext.size.toLocaleString()} token context · {runtimeContext.images} {runtimeContext.images === 1 ? "image" : "images"}</>}
    </span>}
    {(requestContext || !!runtimeContext?.compactedMessages) && <ul className="text-context-details-list">
      {!!requestContext?.omittedMessages && <li>{describeContextCount(requestContext.omittedMessages, "earlier message", "left out of the request")}</li>}
      {!!requestContext?.shortenedMessages && <li>{describeContextCount(requestContext.shortenedMessages, "long message", "shortened in the request")}</li>}
      {!!requestContext?.unansweredPrompts && <li>{describeContextCount(requestContext.unansweredPrompts, "unanswered prompt", "left out of the request")}</li>}
      {!!requestContext?.omittedAttachments && <li>{describeContextCount(requestContext.omittedAttachments, "earlier image attachment", "left out of the request")}</li>}
      {!!runtimeContext?.compactedMessages && <li>{describeContextCount(runtimeContext.compactedMessages, "earlier message", "summarized by the model")}</li>}
    </ul>}
  </div> : null;

  return (
    <article className={`text-message text-message--${message.role}${streaming ? " text-message--streaming" : ""}${editing ? " text-message--editing" : ""}`} tabIndex={-1} aria-live={streaming || editing ? "off" : undefined} data-chat-message={targetId} data-find-match={!!findMatch || undefined}
      aria-label={streaming ? "Response in progress" : assistant ? "Model response" : "Your message"}>
      {assistant && <div className="text-response-author">{modelName ?? "Assistant"}</div>}
      {contextNotice && <div className="text-context-note text-reply-context-note">
        <span>{contextNotice}</span>
        <Button variant="ghost" aria-expanded={showContextDetails} aria-controls={showContextDetails ? detailsId : undefined}
          onClick={() => setDetailsFor(showContextDetails ? undefined : { id: message.id, placement: "context" })}>Context details</Button>
      </div>}
      {showContextDetails && detailPanel}
      {message.image && <img className="text-message-image" src={resolveAssetUrl(`/references/${message.image}`)} alt="Attached chat image" />}
      {message.includedImage && <p className="text-context-note">Selected image: {includedImageLabel ?? message.includedImage}</p>}
      {generatedImage}
      {reasoning && <details className="text-reasoning" open={reasoningExpanded} onToggle={(event) => {
        if (!revealReasoning && event.currentTarget.open !== reasoningExpanded) setReasoningOpen(event.currentTarget.open);
      }}>
        <summary onClick={revealReasoning ? (event) => event.preventDefault() : undefined}>{reasoningInProgress ? indicator : "Reasoning"}</summary>
        {reasoningExpanded && <div ref={reasoningRef} onPointerDown={onPointerDown} data-find-target={revealReasoning || undefined}><TextMarkdown content={reasoning} streaming={shown.streaming} /></div>}
      </details>}
      {editing && findSection === "body" && <div className="text-find-original"><span>Current prompt</span><p data-find-target>{message.content}</p></div>}
      {editing ? editor : <div ref={bodyRef} onPointerDown={onPointerDown} className="text-message-content" data-find-target={findSection === "body" || undefined}>
        {assistant ? content && <TextMarkdown content={content} streaming={shown.streaming} /> : content}
        {showCursor ? <span className="text-stream-cursor" data-waiting={progress.waiting || undefined} aria-hidden="true" /> : !reasoningInProgress && !checkingImageInCaption && indicator}
      </div>}
      {!!message.metrics?.documentSources?.length && <ChatDocumentSources sources={message.metrics.documentSources} />}
      {message.status === "failed" && <div className="text-error">
        {message.error ?? "Generation failed. Retry the response."}
        {message.errorCode === "intel-vulkan-driver" && window.studio.platform === "win32" && <a href="https://www.intel.com/content/www/us/en/support/detect.html" target="_blank" rel="noreferrer">Get Intel graphics drivers</a>}
      </div>}
      {(recoveryNote || onContinue) && <div className="text-reply-recovery">
        {recoveryNote && <span>{recoveryNote}</span>}
        {onContinue && <Button variant="secondary" disabled={!canContinue} onClick={() => onContinue(message.id)}>Continue response</Button>}
      </div>}
      {!streaming && !editing && <div className="text-message-tools">
        {message.content.trim() && <IconButton className="text-icon-button" aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy message"} onClick={() => void copy()}><Copy size={15} aria-hidden="true" /></IconButton>}
        {onEdit && <IconButton ref={editButton} className="text-icon-button" aria-label="Edit message" title={editingAnother ? "Finish or cancel the open prompt edit first" : "Edit message"} disabled={editingAnother} onClick={() => onEdit(message)}><Pencil size={15} aria-hidden="true" /></IconButton>}
        {onFork && <IconButton className="text-icon-button" aria-label="Fork chat here" title="Fork chat here" onClick={onFork}><GitBranch size={15} aria-hidden="true" /></IconButton>}
        {onRetry && <IconButton className="text-icon-button" aria-label={retryLabel} title={canRetry ? retryLabel : "Select a model that can use the last prompt to retry"} disabled={!canRetry} onClick={onRetry}><RotateCcw size={15} aria-hidden="true" /></IconButton>}
        {actions.length > 0 && <TextMessageMenu actions={actions} trigger={menuButton} />}
        {message.metrics && <span className="text-response-speed">{message.metrics.tokensPerSecond.toFixed(1)} tok/s</span>}
        {versions.length > 1 && <div className="text-response-versions" aria-label="Response versions" role="group">
          <IconButton aria-label="Previous response version" title="Previous response version" disabled={busy || version === 0} onClick={() => onSelectVersion?.(contextVersionId ?? message.id, versions[version - 1].id)}><ChevronLeft size={14} aria-hidden="true" /></IconButton>
          <span aria-live="polite">{version + 1} / {versions.length}</span>
          <IconButton aria-label="Next response version" title="Next response version" disabled={busy || version === versions.length - 1} onClick={() => onSelectVersion?.(contextVersionId ?? message.id, versions[version + 1].id)}><ChevronRight size={14} aria-hidden="true" /></IconButton>
        </div>}
        {contextVersion >= 0 && contextVersion !== version && <span className="text-response-preview" role="status">Chat uses version {contextVersion + 1}</span>}
        {copied && <span className="sr-only" role="status">Copied</span>}
      </div>}
      {promptVersions}
      {!editing && confirmDelete && onDelete && <div className="text-message-delete" role="group" aria-label="Confirm message deletion" aria-describedby={confirmationDescription} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDelete(); }
      }}>
        <p id={confirmationDescription}>{deleteTurn ? "Delete this message and its reply?" : assistant && message.alternatives?.length ? "Delete this reply and its other versions?" : assistant ? "Delete this reply?" : "Delete this message?"}</p>
        <div><Button variant="secondary" autoFocus onClick={cancelDelete}>Cancel</Button><Button variant="danger" onClick={() => onDelete(targetId)}>Delete</Button></div>
      </div>}
      {!showContextDetails && detailPanel}
    </article>
  );
});
