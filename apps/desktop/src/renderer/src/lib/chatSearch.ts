import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { hasStreamingMarkdown, previewMarkdown, remarkStreamingPreview } from "./streamingMarkdown";
import { chatSearchExcerpt, chatSearchPattern, isChatSearchBlock } from "./chatSearchRange";
import { replyVersions, type TextMessage } from "./textThreads";

type MatchSection = "body" | "image" | "reasoning";
type SearchField = [section: MatchSection, source: string | undefined, markdown?: "settled" | "streaming"];

export interface ChatSearchMatch {
  messageId: string;
  versionId: string;
  savedPromptId?: string;
  section: MatchSection;
  occurrence: number;
  query: string;
}

interface ChatSearchEntry extends Pick<ChatSearchMatch, "messageId" | "versionId" | "savedPromptId"> {
  fields: SearchField[];
}

const markdown = unified().use(remarkParse).use(remarkGfm).freeze();
const settledMarkdown = markdown().use(remarkRehype, { allowDangerousHtml: true }).freeze();
const streamingMarkdown = markdown().use(remarkStreamingPreview).use(remarkRehype, { allowDangerousHtml: true }).freeze();
const indexed = new WeakMap<TextMessage, SearchField[]>();
const rendered = new WeakMap<SearchField, string>();

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

function searchFields(message: TextMessage, streaming = false): SearchField[] {
  const cached = streaming ? undefined : indexed.get(message);
  if (cached) return cached;
  const markdown = streaming ? "streaming" : "settled";
  const fields: SearchField[] = [
    ["body", message.content, message.role === "assistant" ? markdown : undefined],
    ["image", message.generatedImage?.prompt],
    ["reasoning", message.reasoning, markdown],
  ];
  if (!streaming) indexed.set(message, fields);
  return fields;
}

function renderedField(field: SearchField) {
  const [, source, mode] = field;
  if (!source || !mode) return source;
  const cached = rendered.get(field);
  if (cached !== undefined) return cached;
  const text = renderedMarkdown(source, mode === "streaming") ?? "";
  rendered.set(field, text);
  return text;
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
    for (const field of fields) {
      const [section] = field;
      const text = renderedField(field);
      if (!text) continue;
      let occurrence = 0;
      for (const _ of text.normalize().matchAll(pattern)) matches.push({ messageId, versionId, savedPromptId, section, occurrence: occurrence++, query });
    }
  }
  return matches;
}

function couldMatchMarkdown(source: string, characters: string) {
  // Markdown keeps these source characters in order. Entities can introduce letters
  // and GFM footnotes move their text. Always parse those fields before matching.
  if (!characters || source.includes("&") || source.includes("[^")) return true;
  // Decomposition retains base letters across accent combinations. Unicode
  // case-insensitive matching also treats the long s as equivalent to ASCII s.
  const folded = source.normalize("NFD").toLowerCase().replaceAll("ſ", "s");
  let offset = 0;
  for (const character of characters) {
    const position = folded.indexOf(character, offset);
    if (position === -1) return false;
    offset = position + 1;
  }
  return true;
}

export function threadSearchMatcher(query: string) {
  const pattern = chatSearchPattern(query);
  // Limit the prefilter to characters with predictable decomposition and case folding.
  const characters = query.normalize().toLowerCase().replace(/[^a-z\p{Unified_Ideograph}]/gu, "");
  return (entries: ChatSearchEntry[]) => {
    for (const { fields } of entries) {
      for (const field of fields) {
        const [, source, mode] = field;
        if (!source || (mode && !rendered.has(field) && !couldMatchMarkdown(source, characters))) continue;
        const excerpt = chatSearchExcerpt(renderedField(field)?.replace(/\s+/g, " ").trim(), pattern);
        if (excerpt) return excerpt;
      }
    }
  };
}
