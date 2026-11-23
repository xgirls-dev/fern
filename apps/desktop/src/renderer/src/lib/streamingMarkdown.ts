import type { Blockquote, List, ListItem, Root } from "mdast";
import remend from "remend";

const inlineOptions = {
  linkMode: "text-only",
  katex: false,
  singleTilde: false,
  comparisonOperators: false,
  setextHeadings: false,
  htmlTags: false,
} as const;

export function hasStreamingMarkdown(content: string) {
  return /[*_`~#[\]<>|\\]|(?:^|\n)(?:\t| {4}| {0,3}(?:[-+][ \t]|-{3}|\d+[.)][ \t]))|https?:\/\//.test(content);
}

export function previewMarkdown(content: string) {
  // Headings and tables still use the streaming parser. Skip inline repair
  // when there are no emphasis, code, link, or escape delimiters to complete.
  if (/[*_`~\[\]\\]/.test(content)) return remend(content, inlineOptions);
  return content.endsWith(" ") && !content.endsWith("  ") ? content.slice(0, -1) : content;
}

type BlockContainer = Root | Blockquote | List | ListItem;

// Work on the parser's final block so delimiters elsewhere remain literal.
export function trimUnfinishedBlock(container: BlockContainer, source: string): boolean {
  const last = container.children.at(-1);
  if (last?.type === "blockquote" || last?.type === "list" || last?.type === "listItem") {
    return trimUnfinishedBlock(last, source);
  }
  const start = last?.position?.start.offset;
  if (!last || start === undefined) return false;

  const finalLine = source.slice(source.lastIndexOf("\n") + 1);
  if (last.type === "code") {
    const opening = /^(`{3,}|~{3,})/.exec(source.slice(start))?.[0];
    if (!opening) return false;
    if (start >= source.length - finalLine.length) {
      container.children.pop();
      return true;
    }
    const possibleClose = /([~`]+)[ \t]*$/.exec(finalLine)?.[1];
    const lineStart = last.value.lastIndexOf("\n") + 1;
    const tail = /^ {0,3}([~`]+)[ \t]*$/.exec(last.value.slice(lineStart))?.[1];
    if (tail && tail === possibleClose && tail.length < opening.length && opening.startsWith(tail)) {
      last.value = last.value.slice(0, Math.max(0, lineStart - 1));
      return true;
    }
    return false;
  }

  if (last.type !== "paragraph") return false;
  if (source[start] === "|") {
    const [header, separator, nextLine] = source.slice(start).split(/\r?\n/, 3);
    // The GFM parser takes over as soon as this becomes a valid table.
    if (/^\|(?:[ \t]|$)/.test(header) && nextLine === undefined && /^[|:\- \t]*$/.test(separator ?? "")) {
      container.children.pop();
      return true;
    }
  }
  if (!/^ {0,3}(?:`{1,2}|~{1,2})[ \t]*$/.test(finalLine)) return false;
  const leaf = last.children.at(-1);
  if (leaf?.type !== "text") return false;
  const value = leaf.value.replace(/(?:^|\n) {0,3}(?:`{1,2}|~{1,2})[ \t]*$/, "");
  if (value && value === leaf.value) return false;
  if (value) leaf.value = value;
  else last.children.pop();
  if (last.children.length === 0) container.children.pop();
  return true;
}

export function remarkStreamingPreview() {
  return (tree: Root, file: { value: unknown }) => { trimUnfinishedBlock(tree, String(file.value)); };
}
