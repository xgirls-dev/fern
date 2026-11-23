import { canReuseChatMarkdownPrefix, parsePreparedChatMarkdown, type ChatMarkdownRequest, type ChatMarkdownResponse } from "./chatMarkdown";
import { hasStreamingMarkdown, previewMarkdown } from "./streamingMarkdown";

const prefixes = new Map<string, { source: string; blockCount: number; requestId: number }>();
const PREFIX_LIMIT = 8;

self.addEventListener("message", (event: MessageEvent<ChatMarkdownRequest>) => {
  const { id, content, streaming, view, previousId } = event.data;
  let response: ChatMarkdownResponse;
  try {
    const preview = streaming && hasStreamingMarkdown(content);
    const source = preview ? previewMarkdown(content) : content;
    const independent = canReuseChatMarkdownPrefix(source);
    const candidate = prefixes.get(view);
    // Only omit nodes from a reply the renderer has acknowledged.
    const prefix = independent && candidate && candidate.requestId === previousId && source.startsWith(candidate.source) ? candidate : null;
    const tailOffset = prefix?.source.length ?? 0;
    const { root, boundary, trimmedPreview } = parsePreparedChatMarkdown(source.slice(tailOffset), preview, independent && streaming);
    const blocks = root.children.map((node) => ({ signature: JSON.stringify(node), node }));
    const reusable = boundary ? {
      source: source.slice(0, tailOffset + boundary.offset),
      blockCount: (prefix?.blockCount ?? 0) + boundary.index,
    } : streaming ? prefix : null;
    prefixes.delete(view);
    if (reusable) prefixes.set(view, { ...reusable, requestId: id });
    const oldestView = prefixes.keys().next().value;
    if (prefixes.size > PREFIX_LIMIT && oldestView !== undefined) prefixes.delete(oldestView);
    response = {
      id, blocks,
      retained: prefix ? { requestId: prefix.requestId, blockCount: prefix.blockCount } : undefined,
      stablePrefix: reusable && content.startsWith(reusable.source)
        ? { sourceLength: reusable.source.length, blockCount: reusable.blockCount } : undefined,
      // A retained prefix excludes the blocks that preview trimming can change.
      matchesFinal: streaming && source === content && !trimmedPreview ? true : undefined,
    };
  } catch {
    prefixes.delete(view);
    response = { id };
  }
  self.postMessage(response);
});
