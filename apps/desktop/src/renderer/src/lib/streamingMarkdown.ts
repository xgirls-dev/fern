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
  return remend(content, inlineOptions);
}

type BlockContainer = Root | Blockquote | List | ListItem;

// Work on the parser's final block so delimiters elsewhere remain literal.
function trimUnfinishedBlock(container: BlockContainer, source: string): void {
  const last = container.children.at(-1);
  if (last?.type === "blockquote" || last?.type === "list" || last?.type === "listItem") {
    trimUnfinishedBlock(last, source);
    return;
  }
  const start = last?.position?.start.offset;
  if (!last || start === undefined) return;

  const finalLine = source.slice(source.lastIndexOf("\n") + 1);
  if (last.type === "code") {
    const opening = /^(`{3,}|~{3,})/.exec(source.slice(start))?.[0];
    if (!opening) return;
    if (start >= source.length - finalLine.length) {
      container.children.pop();
      return;
    }
    const possibleClose = /([~`]+)[ \t]*$/.exec(finalLine)?.[1];
    const lineStart = last.value.lastIndexOf("\n") + 1;
    const tail = /^ {0,3}([~`]+)[ \t]*$/.exec(last.value.slice(lineStart))?.[1];
    if (tail && tail === possibleClose && tail.length < opening.length && opening.startsWith(tail)) {
      last.value = last.value.slice(0, Math.max(0, lineStart - 1));
    }
    return;
  }

  if (last.type !== "paragraph") return;
  if (source[start] === "|") {
    const [header, separator, nextLine] = source.slice(start).split(/\r?\n/, 3);
    // The GFM parser takes over as soon as this becomes a valid table.
    if (/^\|(?:[ \t]|$)/.test(header) && nextLine === undefined && /^[|:\- \t]*$/.test(separator ?? "")) {
      container.children.pop();
      return;
    }
  }
  if (!/^ {0,3}(?:`{1,2}|~{1,2})[ \t]*$/.test(finalLine)) return;
  const leaf = last.children.at(-1);
  if (leaf?.type !== "text") return;
  leaf.value = leaf.value.replace(/(?:^|\n) {0,3}(?:`{1,2}|~{1,2})[ \t]*$/, "");
  if (!leaf.value) last.children.pop();
  if (last.children.length === 0) container.children.pop();
}

export function remarkStreamingPreview() {
  return (tree: Root, file: { value: unknown }) => trimUnfinishedBlock(tree, String(file.value));
}
