import { common, createLowlight } from "lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import powershell from "highlight.js/lib/languages/powershell";

const highlighter = createLowlight({ ...common, dockerfile, dos, powershell });
type Group = "keyword" | "string" | "value" | "comment" | "name";
const groups = new Map<string, Group>([
  ["hljs-keyword", "keyword"], ["hljs-built_in", "keyword"], ["hljs-type", "keyword"], ["hljs-meta", "keyword"],
  ["hljs-string", "string"], ["hljs-regexp", "string"], ["hljs-addition", "string"],
  ["hljs-number", "value"], ["hljs-literal", "value"], ["hljs-variable", "value"], ["hljs-deletion", "value"],
  ["hljs-comment", "comment"], ["hljs-quote", "comment"],
  ["hljs-title", "name"], ["hljs-attr", "name"], ["hljs-attribute", "name"], ["hljs-selector-tag", "name"],
]);

export function highlightChatCode(text: Text, language: string) {
  if (!highlighter.registered(language)) return;
  const tree = highlighter.highlight(language, text.data);
  const tokens: { group: Group; start: number; end: number }[] = [];
  let offset = 0;

  function collect(nodes: typeof tree.children, inherited?: Group) {
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
  if (offset !== text.length) return;
  const ranges = tokens.map(({ group, start, end }) => {
    const key = `fern-code-${group}`;
    let highlight = CSS.highlights.get(key);
    if (!highlight) {
      highlight = new Highlight();
      highlight.priority = -1; // Chat Find should paint over syntax colors.
      CSS.highlights.set(key, highlight);
    }
    const range = new StaticRange({ startContainer: text, startOffset: start, endContainer: text, endOffset: end });
    highlight.add(range);
    return { key, highlight, range };
  });

  return () => {
    for (const { key, highlight, range } of ranges) {
      highlight.delete(range);
      if (!highlight.size) CSS.highlights.delete(key);
    }
  };
}
