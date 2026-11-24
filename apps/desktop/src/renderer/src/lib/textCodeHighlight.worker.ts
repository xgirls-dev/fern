import { common, createLowlight } from "lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import powershell from "highlight.js/lib/languages/powershell";
import type { CodeHighlightGroup, CodeHighlightRequest, CodeHighlightToken } from "./textCodeHighlight";

const highlighter = createLowlight({ ...common, dockerfile, dos, powershell });
const groups = new Map<string, CodeHighlightGroup>([
  ["hljs-keyword", "keyword"], ["hljs-built_in", "keyword"], ["hljs-type", "keyword"], ["hljs-meta", "keyword"],
  ["hljs-string", "string"], ["hljs-regexp", "string"], ["hljs-addition", "string"],
  ["hljs-number", "value"], ["hljs-literal", "value"], ["hljs-variable", "value"], ["hljs-deletion", "value"],
  ["hljs-comment", "comment"], ["hljs-quote", "comment"],
  ["hljs-title", "name"], ["hljs-attr", "name"], ["hljs-attribute", "name"], ["hljs-selector-tag", "name"],
]);

function tokenize(source: string, language: string): CodeHighlightToken[] {
  if (!highlighter.registered(language)) return [];
  const tree = highlighter.highlight(language, source);
  const tokens: CodeHighlightToken[] = [];
  let offset = 0;

  function collect(nodes: typeof tree.children, inherited?: CodeHighlightGroup) {
    for (const node of nodes) {
      if (node.type === "text") {
        const end = offset + node.value.length;
        if (inherited && end > offset) tokens.push({ group: inherited, start: offset, end });
        offset = end;
      } else if (node.type === "element") {
        const classes = node.properties.className;
        const own = Array.isArray(classes) ? classes.map((name) => groups.get(String(name))).find(Boolean) : undefined;
        const interpolated = Array.isArray(classes) && classes.includes("hljs-subst");
        collect(node.children, own ?? (interpolated ? undefined : inherited));
      }
    }
  }

  collect(tree.children);
  return offset === source.length ? tokens : [];
}

self.addEventListener("message", ({ data }: MessageEvent<CodeHighlightRequest>) => {
  const { id, source, language } = data;
  try {
    self.postMessage({ id, tokens: tokenize(source, language) });
  } catch {
    self.postMessage({ id, tokens: [] });
  }
});
