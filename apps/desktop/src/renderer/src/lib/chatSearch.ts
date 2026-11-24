import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { hasStreamingMarkdown, previewMarkdown, remarkStreamingPreview } from "./streamingMarkdown";
import { chatSearchPattern, isChatSearchBlock } from "./chatSearchRange";
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
const indexed = new WeakMap<TextMessage, ChatSearchEntry["fields"]>();

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
