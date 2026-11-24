import type { ElementContent, Root, RootContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { hasStreamingMarkdown, previewMarkdown, trimUnfinishedBlock } from "./streamingMarkdown";

const markdown = unified().use(remarkParse).use(remarkGfm).freeze();
const finalMarkdown = markdown().use(remarkRehype, { allowDangerousHtml: true }).freeze();

function renderableNode(node: RootContent): RootContent {
  // Treat generated HTML as literal text, like the original Markdown renderer.
  if (node.type === "raw") return { type: "text", value: node.value };
  if (node.type === "element") node.children = node.children.map(renderableNode) as typeof node.children;
  delete node.position;
  return node;
}

export function parsePlainChatMarkdown(content: string): Root | null {
  // Leave ambiguous lines, hard breaks, and possible GFM autolinks to the parser.
  if (/[\0\r\t\uFEFF*_`~#[\]<>|\\&:/@]|www\./i.test(content) ||
      /(?:^|\n)(?: {4}| {0,3}(?:[-+](?= |\n|$)|\d+[.)](?= |\n|$)|[-=]+ *(?=\n|$)))| \n|\n /.test(content)) {
    return null;
  }
  const value = content.replace(/^[ \n]+|[ \n]+$/g, "");
  if (!value) return { type: "root", children: [] };
  const children: RootContent[] = [];
  for (const paragraph of value.split(/\n{2,}/)) {
    if (children.length) children.push({ type: "text", value: "\n" });
    children.push({ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: paragraph }] });
  }
  return { type: "root", children };
}

export function prepareChatMarkdown(content: string, streaming: boolean) {
  const preview = streaming && hasStreamingMarkdown(content);
  return { source: preview ? previewMarkdown(content) : content, preview };
}

export function parseChatMarkdown(content: string, streaming: boolean): Root {
  const plain = parsePlainChatMarkdown(content);
  if (plain) return plain;
  const { source, preview } = prepareChatMarkdown(content, streaming);
  return parsePreparedChatMarkdown(source, preview).root;
}

export function canReuseChatMarkdownPrefix(source: string) {
  // Link and footnote definitions can change earlier blocks.
  return !source.includes("]:");
}

export function parsePreparedChatMarkdown(source: string, preview: boolean, findBoundary = false) {
  const tree = finalMarkdown.parse(source);
  const trimmedPreview = preview && trimUnfinishedBlock(tree, source);
  const root = finalMarkdown.runSync(tree, source);
  let boundary: { offset: number; index: number } | undefined;
  // Keep the last two top-level blocks revisable. A blank line preceding the
  // retained tail protects against merging a list, table, or continuation.
  if (findBoundary && tree.children.length >= 3) {
    const offset = tree.children.at(-2)?.position?.start.offset;
    if (offset) {
      const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
      if (lineStart > 0 && /\n[ \t]*\r?\n$/.test(source.slice(0, lineStart))) {
        const index = root.children.findIndex((node) => (node.position?.start.offset ?? -1) >= lineStart);
        if (index > 0) boundary = { offset: lineStart, index };
      }
    }
  }
  const renderable: Root = { type: "root", children: root.children.map(renderableNode) };
  const last = tree.children.at(-1);
  let openTable: { header: string; completedThrough: number; rowCount: number } | undefined;
  const start = last?.position?.start.offset;
  const end = last?.position?.end.offset;
  if (findBoundary && last?.type === "table" && start !== undefined && end !== undefined && last.children.length > 1) {
    const remainder = source.slice(end);
    const rowCount = last.children.length - (remainder.endsWith("\n") ? 1 : 2);
    const firstRow = last.children[1].position?.start.offset;
    const completedEnd = last.children[rowCount]?.position?.end.offset;
    if (rowCount > 0 && firstRow !== undefined && completedEnd !== undefined && /^[ \t]*(?:\r?\n)?$/.test(remainder)) {
      const firstRowLine = source.lastIndexOf("\n", firstRow - 1) + 1;
      const completedThrough = source.indexOf("\n", completedEnd) + 1;
      if (firstRowLine > start && completedThrough > firstRowLine) openTable = {
        header: source.slice(source.lastIndexOf("\n", start - 1) + 1, firstRowLine),
        completedThrough,
        rowCount,
      };
    }
  }
  return { root: renderable, boundary, trimmedPreview, openTable };
}

interface ParsedStreamingMarkdown {
  content: string;
  nodes: RootContent[];
  prefix?: { source: string; blockCount: number };
}

export function parseStreamingChatMarkdown(content: string, previous?: ParsedStreamingMarkdown): ParsedStreamingMarkdown {
  const plain = parsePlainChatMarkdown(content);
  if (plain) return { content, nodes: plain.children };

  const { source, preview } = prepareChatMarkdown(content, true);
  const independent = canReuseChatMarkdownPrefix(source);
  // A revised snapshot may remove a whole block or reinterpret an earlier one.
  const priorPrefix = independent && previous && content.startsWith(previous.content) ? previous.prefix : undefined;
  const prefix = priorPrefix && source.startsWith(priorPrefix.source) ? priorPrefix : undefined;
  const offset = prefix?.source.length ?? 0;
  const count = prefix?.blockCount ?? 0;
  const { root, boundary } = parsePreparedChatMarkdown(source.slice(offset), preview, independent);
  return {
    content,
    nodes: prefix && previous ? [...previous.nodes.slice(0, count), ...root.children] : root.children,
    prefix: boundary ? { source: source.slice(0, offset + boundary.offset), blockCount: count + boundary.index } : prefix,
  };
}

export function appendChatMarkdownTableRows(table: RootContent | undefined, update: ChatMarkdownTableRows): RootContent | undefined {
  if (table?.type !== "element" || table.tagName !== "table") return;
  const bodyIndex = table.children.findIndex((child) => child.type === "element" && child.tagName === "tbody");
  const body = table.children[bodyIndex];
  // GFM wraps body rows with newlines before, between, and after them.
  const keep = update.rowCount * 2 + 1;
  if (body?.type !== "element" || body.children.length < keep) return;
  const children = table.children.slice();
  children[bodyIndex] = { ...body, children: [...body.children.slice(0, keep), ...update.tail] };
  return { ...table, children };
}

export interface ChatMarkdownRequest {
  id: number;
  view: string;
  content: string;
  streaming: boolean;
  previousId?: number;
}

export interface ChatMarkdownBlock {
  signature: string;
  node: RootContent;
}

export interface ChatMarkdownTableRows {
  rowCount: number;
  tail: ElementContent[];
}

export interface ChatMarkdownResponse {
  id: number;
  blocks?: ChatMarkdownBlock[];
  retained?: { requestId: number; blockCount: number };
  tableRows?: ChatMarkdownTableRows;
  stablePrefix?: { sourceLength: number; blockCount: number };
  matchesFinal?: true;
}
