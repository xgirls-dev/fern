import type { Root, RootContent } from "hast";
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

export function parseChatMarkdown(content: string, streaming: boolean): Root {
  // A single line without Markdown syntax or autolinks renders as a plain
  // paragraph during animation and after the reply has settled.
  if (!/[\0\r\n\t\uFEFF*_`~#[\]<>|\\&:/@]|www\./i.test(content) &&
      !/^(?: {4}| {0,3}(?:[-+](?: |$)|\d+[.)](?: |$)|-+ *$))/.test(content)) {
    const value = content.replace(/^ +| +$/g, "");
    return { type: "root", children: value ? [{ type: "element", tagName: "p", properties: {},
      children: [{ type: "text", value }] }] : [] };
  }
  const preview = streaming && hasStreamingMarkdown(content);
  return parsePreparedChatMarkdown(preview ? previewMarkdown(content) : content, preview).root;
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
  return { root: renderable, boundary, trimmedPreview };
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

export interface ChatMarkdownResponse {
  id: number;
  blocks?: ChatMarkdownBlock[];
  retained?: { requestId: number; blockCount: number };
  stablePrefix?: { sourceLength: number; blockCount: number };
  matchesFinal?: true;
}
