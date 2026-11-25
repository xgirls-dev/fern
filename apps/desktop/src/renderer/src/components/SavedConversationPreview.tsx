import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolveAssetUrl } from "../lib/api";
import type { ChatSearchMatch } from "../lib/chatSearch";
import { findChatImage, showReplyVersion, type TextMessage, type TextVersion } from "../lib/textThreads";
import { useTextScroll } from "../hooks/useTextScroll";
import { TextChatMessage } from "./TextChatMessage";
import { TextFindBar } from "./TextFindBar";
import { TextPromptVersions } from "./TextPromptVersions";
import { TextTranscriptWindow, estimateTextRowHeight } from "./TextTranscriptWindow";

function savedImages(message: TextMessage, matchCaption = false) {
  const images = message.generatedImages?.length ? message.generatedImages : message.generatedImage ? [message.generatedImage] : [];
  return images.map((image, index) => <figure key={image.name} className="saved-conversation-image">
    <img src={resolveAssetUrl(`/outputs/${encodeURIComponent(image.name)}`)} alt="Generated image"
      width={image.width} height={image.height} loading="lazy" />
    <figcaption data-find-target={matchCaption && index === 0 || undefined}>{image.prompt}</figcaption>
  </figure>);
}

export function SavedConversationPreview({ threadId, version, initialQuery, onClose }: {
  threadId: string;
  version: TextVersion;
  initialQuery: string;
  onClose: () => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const [match, setMatch] = useState<ChatSearchMatch | null>(null);
  const { messages } = version;
  const viewId = `saved:${threadId}:${version.id}`;
  const items = useMemo(() => messages.map((message) => ({
    key: message.id, estimatedHeight: estimateTextRowHeight(message),
  })), [messages]);
  const revealIndex = match ? messages.findIndex(({ id }) => id === match.messageId) : -1;
  const { feedRef, transcriptRef, historyVisible, keepFollowingTail, revealMessage, onScroll, onKeyDown, onFocus } = useTextScroll(viewId, { persistPosition: false });

  useLayoutEffect(() => {
    if (match && historyVisible && revealIndex >= 0) return revealMessage(match.messageId, match, "start");
  }, [historyVisible, match, revealIndex, revealMessage]);

  const renderItem = useCallback((index: number) => {
    const stored = messages[index];
    const found = match?.messageId === stored.id ? match : undefined;
    const savedPrompt = found?.savedPromptId ? found : undefined;
    const message = showReplyVersion(stored, savedPrompt ? undefined : found?.versionId);
    return <TextChatMessage key={stored.id} message={message} contextVersionId={stored.id}
      latest={index === messages.length - 1} canDelete={false} canFork={false} findMatch={found}
      generatedImage={savedImages(message, !savedPrompt && found?.section === "image")}
      includedImageLabel={findChatImage({ messages }, message.includedImage)?.prompt}
      promptVersions={!!message.promptAlternatives?.length && <TextPromptVersions alternatives={message.promptAlternatives}
        searchMatch={savedPrompt} onCloseSearch={onClose} busy={false} renderImage={savedImages} />} />;
  }, [match, messages, onClose]);

  return <>
    <TextFindBar input={search} initialQuery={initialQuery} messages={messages}
      liveMessage={null} onMatch={setMatch} onClose={onClose} showClose={false} />
    <div ref={feedRef} className="text-conversation saved-conversation-feed" role="log" aria-label="Saved conversation messages"
      aria-live="off" tabIndex={0} onScroll={onScroll} onFocusCapture={onFocus} onKeyDown={onKeyDown}>
      <div ref={transcriptRef} className="text-transcript">
        <TextTranscriptWindow threadId={viewId} items={items} revealIndex={revealIndex}
          restoreIndex={-1} renderItem={renderItem} keepFollowingTail={keepFollowingTail} />
      </div>
    </div>
  </>;
}
