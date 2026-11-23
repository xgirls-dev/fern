import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
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
import { TooltipIconButton } from "./ui/Tooltip";
import { Disclosure } from "./ui/Disclosure";
import { InlineNotice } from "./ui/InlineNotice";
import { ProgressLabel } from "./ui/ProgressLabel";
import { VersionStepper } from "./ui/VersionStepper";
import { Button, InlineConfirmation } from "./ui/controls";

export type TextReplyProgress = { kind: "status" | "reasoning" | "answer" | "image-check"; label: string; waiting?: boolean };

function describeContextCount(count: number, subject: string, action: string) {
  return `${count.toLocaleString()} ${subject}${count === 1 ? " was" : "s were"} ${action}.`;
}

const reducedTextMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const SMALL_PROSE_UPDATE = 8;

function useStreamedText(text: string, streaming: boolean) {
  const displayed = useRef(text);
  const [visible, setVisible] = useState(text);
  const frame = useRef<number | undefined>(undefined);
  const latest = useRef(text);
  const animate = streaming && !reducedTextMotion.matches && text.length <= 16_000 && !hasStreamingMarkdown(text);
  useLayoutEffect(() => () => {
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
    frame.current = undefined;
  }, []);
  useLayoutEffect(() => {
    latest.current = text;
    const show = (next: string) => {
      if (next === displayed.current) return;
      displayed.current = next;
      setVisible(next);
    };

    const appended = text.length - displayed.current.length;
    if (!animate || appended <= SMALL_PROSE_UPDATE || !text.startsWith(displayed.current)) {
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
      frame.current = undefined;
      show(text);
      return;
    }
    if (frame.current !== undefined) return;

    // Start revealing a burst immediately. The next frame clears its entire
    // remaining backlog, including chunks that arrive before that frame.
    const midpoint = displayed.current.length + Math.ceil(appended / 2);
    const grapheme = segmentGraphemes(text).containing(midpoint - 1);
    const firstPart = grapheme ? text.slice(0, grapheme.index + grapheme.segment.length) : text;
    show(firstPart);
    if (firstPart === text) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = undefined;
      show(latest.current);
    });
  }, [animate, text]);
  return animate && text.startsWith(visible) ? visible : text;
}

function useReplySelection(id: string, content: string, reasoning: string | undefined, streaming: boolean, preview: boolean) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ replyId: string; pointerId: number } | null>(null);
  const renderAsStream = streaming && !preview;
  const committed = useRef({ content, reasoning, streaming: renderAsStream });
  const [heldReply, setHeldReply] = useState<string>();
  const holding = heldReply === id;

  // Native selection offsets refer to the rendered Markdown, including its text nodes.
  useLayoutEffect(() => {
    if (!holding) committed.current = { content, reasoning, streaming: renderAsStream };
  }, [content, holding, reasoning, renderAsStream]);

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
  const releaseSelection = () => {
    pointer.current = null;
    if (chatSelectionIntersects(bodyRef.current, reasoningRef.current)) window.getSelection()?.removeAllRanges();
    setHeldReply(undefined);
  };
  return { bodyRef, reasoningRef, onPointerDown, releaseSelection, holding,
    shown: holding ? committed.current : { content, reasoning, streaming: renderAsStream } };
}

export const TextChatMessage = memo(function TextChatMessage({ message, selectionId, initialReasoningOpen, contextVersionId, findMatch, progress, previewWhileStreaming = false, generatedImage, includedImageLabel, contextChanged, editor, promptVersions, editingAnother, onEdit, onBranch, onFork, canFork, onDelete, onDeleteRequested, canDelete, confirmDelete, deleteTurn, onRetry, canRetry, onContinue, canContinue, onSelectVersion, busy, latest }: {
  message: TextMessage;
  selectionId?: string;
  initialReasoningOpen?: boolean;
  contextVersionId?: string;
  findMatch?: ChatSearchMatch;
  progress?: TextReplyProgress;
  previewWhileStreaming?: boolean;
  generatedImage?: ReactNode;
  includedImageLabel?: string;
  contextChanged?: boolean;
  editor?: ReactNode;
  promptVersions?: ReactNode;
  editingAnother?: boolean;
  onEdit?: (message: TextMessage) => void;
  onFork?: (message: TextMessage) => void;
  canFork: boolean;
  onBranch?: (message: TextMessage) => void;
  onDelete?: (id: string) => void;
  onDeleteRequested?: (id: string | null) => void;
  canDelete: boolean;
  confirmDelete?: boolean;
  deleteTurn?: boolean;
  onRetry?: () => void;
  canRetry?: boolean;
  onContinue?: (id: string) => void;
  canContinue?: boolean;
  onSelectVersion?: (messageId: string, versionId: string) => void;
  busy?: boolean;
  latest: boolean;
}) {
  const [detailsFor, setDetailsFor] = useState<{ id: string; placement: "context" | "actions" }>();
  const [reasoningOpen, setReasoningOpen] = useState(!!initialReasoningOpen);
  const [copiedId, setCopiedId] = useState<string>();
  const copyTimer = useRef<number | undefined>(undefined);
  const menuButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
  const wasEditing = useRef(false);
  const editing = !!editor;
  const findSection = findMatch?.savedPromptId ? undefined : findMatch?.section;
  const revealReasoning = findSection === "reasoning";
  const reasoningExpanded = revealReasoning || reasoningOpen;
  const streaming = !!progress;
  const assistant = message.role === "assistant";
  const animatedContent = useStreamedText(message.content, progress?.kind === "answer" && !previewWhileStreaming);
  const { bodyRef, reasoningRef, onPointerDown, releaseSelection, holding, shown } = useReplySelection(selectionId ?? message.id, animatedContent, message.reasoning, streaming, previewWhileStreaming);
  const { content, reasoning } = shown;
  const hasAnswer = !!content.trim();
  const showCursor = progress?.kind === "answer" && hasAnswer && shown.streaming;
  const cursorState = progress?.kind === "answer" && progress.waiting ? "waiting" : "active";
  const reasoningInProgress = progress?.kind === "reasoning" && !!message.reasoning && !previewWhileStreaming;
  const checkingImageInCaption = progress?.kind === "image-check" && !!generatedImage;
  const indicator = progress && <ProgressLabel className="text-thinking">{progress.label}</ProgressLabel>;
  const stoppedNote = hasAnswer ? "Stopped · Partial response" : message.generatedImage ? "Stopped · Image saved"
    : message.reasoning ? "Stopped during reasoning" : "Stopped before any text was generated";
  const failed = message.status === "failed";
  const showRetry = !!onRetry && (failed || message.status === "stopped");
  const recoveryNote = failed ? message.error || "Generation failed."
    : message.status === "stopped" ? stoppedNote
    : message.status === "complete" && message.metrics?.finishReason === "length" ? "Reached the output limit" : null;
  const modelName = message.modelName ?? message.metrics?.modelName;
  const versions = onSelectVersion && message.alternatives?.length ? replyVersions(message) : [];
  const version = versions.findIndex((item) => item.id === message.id);
  const contextVersion = versions.findIndex((item) => item.id === contextVersionId);
  const showDetails = !streaming && detailsFor?.id === message.id;
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
    run: () => onDeleteRequested(targetId), destructive: true, disabled: !canDelete });

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

  const body = <>
    {message.image && <img className="text-message-image" src={resolveAssetUrl(`/references/${message.image}`)} alt="Attached chat image" />}
    {message.includedImage && <p className="text-context-note">Selected image: {includedImageLabel ?? message.includedImage}</p>}
    {generatedImage}
    {reasoning && <Disclosure className="text-reasoning" label={reasoningInProgress ? indicator : "Reasoning"}
      open={reasoningOpen} lockOpen={revealReasoning} onOpenChange={setReasoningOpen}>
      {reasoningExpanded && <div ref={reasoningRef} onPointerDown={onPointerDown} data-find-target={revealReasoning || undefined}>
        <TextMarkdown content={reasoning} streaming={shown.streaming} preserveSelection={holding} />
      </div>}
    </Disclosure>}
    {editing && findSection === "body" && <div className="text-find-original"><span>Current prompt</span><p data-find-target>{message.content}</p></div>}
    {editing ? editor : <div ref={bodyRef} onPointerDown={onPointerDown} className="text-message-content" data-find-target={findSection === "body" || undefined}>
      {assistant ? (streaming || content) && <TextMarkdown content={content} streaming={shown.streaming} receivingReply={streaming}
        cursor={showCursor ? cursorState : undefined} preserveSelection={holding} /> : content}
      {!showCursor && !reasoningInProgress && !checkingImageInCaption && indicator}
    </div>}
  </>;

  return (
    <article className={`text-message text-message--${message.role}${streaming ? " text-message--streaming" : ""}${editing ? " text-message--editing" : ""}`} tabIndex={-1} aria-live={streaming || editing ? "off" : undefined} data-chat-message={targetId} data-find-match={!!findMatch || undefined}
      data-actions-persistent={latest || showDetails || copied || confirmDelete || undefined}
      aria-label={streaming ? "Response in progress" : assistant ? "Model response" : "Your message"}>
      {assistant && <div className="text-response-author">{previewWhileStreaming ? "Previous reply" : modelName ?? "Assistant"}</div>}
      {contextNotice && <div className="text-context-note text-reply-context-note">
        <span>{contextNotice}</span>
        <Button variant="ghost" aria-expanded={showContextDetails} aria-controls={showContextDetails ? detailsId : undefined}
          onClick={() => setDetailsFor(showContextDetails ? undefined : { id: message.id, placement: "context" })}>Context details</Button>
      </div>}
      {showContextDetails && detailPanel}
      {assistant ? body : <div className="text-user-bubble">{body}</div>}
      {!!message.metrics?.documentSources?.length && <ChatDocumentSources sources={message.metrics.documentSources} />}
      {!streaming && recoveryNote && <InlineNotice className="text-reply-recovery" tone={failed ? "error" : "neutral"}
        actions={(onContinue || showRetry) && <>
          {onContinue && <Button variant="secondary" disabled={!canContinue} onClick={() => onContinue(message.id)}>Continue response</Button>}
          {showRetry && <Button variant={onContinue ? "ghost" : "secondary"} disabled={!canRetry} onClick={onRetry}>Retry response</Button>}
        </>}>
        <span>{recoveryNote}</span>
        {failed && message.errorCode === "intel-vulkan-driver" && window.studio.platform === "win32" && <>
          {" "}<a className="ui-link" href="https://www.intel.com/content/www/us/en/support/detect.html" target="_blank" rel="noreferrer">Get Intel graphics drivers</a>
        </>}
      </InlineNotice>}
      {!streaming && !editing && <div className="text-message-tools">
        {message.content.trim() && <TooltipIconButton className="text-icon-button" aria-label={copied ? "Copied" : "Copy message"}
          tooltip={copied ? "Copied" : "Copy message"} tooltipSide="bottom" onClick={() => void copy()}><Copy size={15} aria-hidden="true" /></TooltipIconButton>}
        {onEdit && <TooltipIconButton ref={editButton} className="text-icon-button" aria-label="Edit message"
          tooltip={editingAnother ? "Finish or cancel the open prompt edit first" : "Edit message"} tooltipSide="bottom"
          disabled={editingAnother} onClick={() => onEdit(message)}><Pencil size={15} aria-hidden="true" /></TooltipIconButton>}
        {onFork && <TooltipIconButton className="text-icon-button" aria-label="Fork chat here"
          tooltip="Fork chat here" tooltipSide="bottom" disabled={!canFork} onClick={() => onFork(message)}><GitBranch size={15} aria-hidden="true" /></TooltipIconButton>}
        {onRetry && !showRetry && <TooltipIconButton className="text-icon-button" aria-label="Regenerate response"
          tooltip={canRetry ? "Regenerate response" : "Select a model that can use the last prompt to retry"} tooltipSide="bottom"
          disabled={!canRetry} onClick={onRetry}><RotateCcw size={15} aria-hidden="true" /></TooltipIconButton>}
        {actions.length > 0 && <TextMessageMenu actions={actions} trigger={menuButton} align={assistant ? "start" : "end"} />}
        {message.metrics && <span className="text-response-speed">{message.metrics.tokensPerSecond.toFixed(1)} tok/s</span>}
        {versions.length > 1 && <VersionStepper label="Response versions" previousLabel="Previous response version"
          nextLabel="Next response version" index={version} count={versions.length} disabled={busy}
          onChange={(index) => {
            releaseSelection();
            onSelectVersion?.(contextVersionId ?? message.id, versions[index].id);
          }} />}
        {contextVersion >= 0 && contextVersion !== version && <span className="text-response-preview" role="status">Chat uses version {contextVersion + 1}</span>}
        {copied && <span className="sr-only" role="status">Copied</span>}
      </div>}
      {promptVersions}
      {!editing && confirmDelete && onDelete && <InlineConfirmation className="text-message-delete"
        label="Confirm message deletion" confirmLabel="Delete" onCancel={cancelDelete} onConfirm={() => onDelete(targetId)}>
        {deleteTurn ? "Delete this message and its reply?" : assistant && message.alternatives?.length
          ? "Delete this reply and its other versions?" : assistant ? "Delete this reply?" : "Delete this message?"}
      </InlineConfirmation>}
      {!showContextDetails && detailPanel}
    </article>
  );
});
