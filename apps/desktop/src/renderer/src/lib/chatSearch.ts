import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { hasStreamingMarkdown, previewMarkdown, remarkStreamingPreview } from "./streamingMarkdown";
import { segmentGraphemes } from "./text";
import { replyVersions, type TextMessage } from "./textThreads";

type MatchSection = "body" | "image" | "reasoning";

export interface ChatSearchMatch {
  messageId: string;
  versionId: string;
  savedPromptId?: string;
  section: MatchSection;
  occurrence: number;
  query: string;
}

interface ChatSearchEntry extends Pick<ChatSearchMatch, "messageId" | "versionId" | "savedPromptId"> {
  fields: Array<[section: MatchSection, value: string | undefined]>;
}

const markdown = unified().use(remarkParse).use(remarkGfm).freeze();
const settledMarkdown = markdown().use(remarkRehype, { allowDangerousHtml: true }).freeze();
const streamingMarkdown = markdown().use(remarkStreamingPreview).use(remarkRehype, { allowDangerousHtml: true }).freeze();
const blockTags = new Set(["blockquote", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul"]);
const indexed = new WeakMap<TextMessage, ChatSearchEntry["fields"]>();

export function isChatSearchBlock(tagName: string) {
  return blockTags.has(tagName);
}

export function chatSearchPattern(query: string) {
  const literal = query.normalize().trim().split(/\s+/).map((part) => part.replace(/[\^$\\.*+?()[\]{}|]/g, "\\$&")).join("\\s+");
  return new RegExp(literal, "giu");
}

export function findChatSearchRange(text: string, pattern: RegExp, occurrence = 0) {
  const normalized = text.normalize();
  const hits = normalized.matchAll(pattern);
  for (let index = 0; index < occurrence; index += 1) hits.next();
  const match = hits.next().value;
  if (!match?.[0]) return;
  const start = match.index;
  const end = start + match[0].length;
  if (normalized === text) return { start, end };

  const graphemes = segmentGraphemes(text);
  function originalBoundary(offset: number, exclusiveEnd: boolean) {
    // Prefix lengths at grapheme boundaries stay ordered after normalization.
    const character = exclusiveEnd ? offset - 1 : offset;
    let low = 0;
    let high = text.length;
    let normalizedLow = 0;
    while (low < high) {
      const { index, segment } = graphemes.containing(Math.floor((low + high) / 2))!;
      const boundary = index + segment.length;
      const normalizedBoundary = normalizedLow + text.slice(low, boundary).normalize().length;
      if (normalizedBoundary <= character) {
        low = boundary;
        normalizedLow = normalizedBoundary;
      } else {
        high = index;
      }
    }
    const { index, segment } = graphemes.containing(low)!;
    if (segment === segment.normalize()) return index + offset - normalizedLow;
    // A remapped endpoint covers the full original character, including its combining marks.
    return exclusiveEnd ? index + segment.length : index;
  }
  return { start: originalBoundary(start, false), end: originalBoundary(end, true) };
}

type RenderedNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: RenderedNode[] };

function readRenderedText(node: RenderedNode): string {
  if (node.type === "text" || node.type === "raw") return node.value ?? "";
  const { tagName, properties } = node;
  if (properties?.ariaHidden === true || properties?.ariaHidden === "true" ||
    Array.isArray(properties?.className) && properties.className.includes("sr-only")) return "";
  // TextMarkdown displays the alt text in place of Markdown images.
  if (tagName === "img") return typeof properties?.alt === "string" ? properties.alt : "";
  const children = node.children?.map(readRenderedText).join("") ?? "";
  return tagName && isChatSearchBlock(tagName) ? `\n${children}\n` : children;
}

function renderedMarkdown(text: string | undefined, streaming: boolean) {
  if (!text) return text;
  const structured = hasStreamingMarkdown(text);
  if (!structured && !text.includes("&")) return text;
  const preview = streaming && structured;
  const processor = preview ? streamingMarkdown : settledMarkdown;
  return readRenderedText(processor.runSync(processor.parse(preview ? previewMarkdown(text) : text)));
}

function searchFields(message: TextMessage, streaming = false): ChatSearchEntry["fields"] {
  const cached = streaming ? undefined : indexed.get(message);
  if (cached) return cached;
  const fields: ChatSearchEntry["fields"] = [
    ["body", message.role === "assistant" ? renderedMarkdown(message.content, streaming) : message.content],
    ["image", message.generatedImage?.prompt],
    ["reasoning", renderedMarkdown(message.reasoning, streaming)],
  ];
  if (!streaming) indexed.set(message, fields);
  return fields;
}

export function liveChatSearchEntry(message: TextMessage): ChatSearchEntry {
  return { messageId: message.id, versionId: message.id, fields: searchFields(message, true) };
}

function searchableVersions(messageId: string, message: TextMessage, savedPromptId?: string): ChatSearchEntry[] {
  const versions = message.alternatives?.length ? replyVersions(message) : [message];
  return versions.map((version) => ({
    messageId, versionId: version.id, savedPromptId,
    fields: searchFields(version.id === message.id ? message : version),
  }));
}

export function chatSearchEntries(messages: readonly TextMessage[]): ChatSearchEntry[] {
  return messages.flatMap((message) => {
    const saved = [...(message.promptAlternatives ?? [])].sort((left, right) => left.createdAt - right.createdAt);
    return [
      ...searchableVersions(message.id, message),
      ...saved.flatMap((version) => [
        { messageId: message.id, versionId: version.id, savedPromptId: version.id, fields: [["body", version.content]] } satisfies ChatSearchEntry,
        ...(version.response ? searchableVersions(message.id, version.response, version.id) : []),
      ]),
    ];
  });
}

export function matchingChatOccurrences(entries: ChatSearchEntry[], query: string): ChatSearchMatch[] {
  if (!query.trim()) return [];
  const pattern = chatSearchPattern(query);
  const matches: ChatSearchMatch[] = [];
  for (const { messageId, versionId, savedPromptId, fields } of entries) {
    for (const [section, text] of fields) {
      if (!text) continue;
      let occurrence = 0;
      for (const _ of text.normalize().matchAll(pattern)) matches.push({ messageId, versionId, savedPromptId, section, occurrence: occurrence++, query });
    }
  }
  return matches;
}

export function chatSearchText(messages: readonly TextMessage[]) {
  return chatSearchEntries(messages).flatMap((entry) => entry.fields.map(([, text]) => text?.replace(/\s+/g, " ").trim()));
}
