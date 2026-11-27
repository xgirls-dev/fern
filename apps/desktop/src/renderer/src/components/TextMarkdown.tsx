import { createContext, Fragment, isValidElement, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { Element, ElementContent, RootContent, Text } from "hast";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import MoveHorizontal from "lucide-react/dist/esm/icons/move-horizontal.mjs";
import WrapText from "lucide-react/dist/esm/icons/wrap-text.mjs";
import { useChatMarkdown } from "../hooks/useChatMarkdown";
import { useClipboardCopy } from "../hooks/useClipboardCopy";
import type { ChatDocumentSource } from "../lib/chatDocuments";
import { highlightChatCode } from "../lib/textCodeHighlight";
import type { OpenDocumentSource } from "./ChatDocuments";
import { Button } from "./ui/controls";
import { Tooltip } from "./ui/Tooltip";

const StreamingCode = createContext(false);
const DocumentCitations = createContext<{
  sources: ReadonlyMap<number, ChatDocumentSource>;
  onOpen: OpenDocumentSource;
} | undefined>(undefined);

function useCodeOverflow(source: string | undefined, wrap: boolean | null) {
  const ref = useRef<HTMLPreElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const measureOverflow = useCallback(() => {
    const element = ref.current;
    if (element?.clientWidth) setOverflowing(element.scrollWidth > element.clientWidth + 1);
  }, []);
  useEffect(() => {
    // A new chunk can change scrollWidth while leaving both observed boxes the
    // same size. Check after the frame so React commits do not force layout.
    let timer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(measureOverflow, 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [measureOverflow, source, wrap]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [measureOverflow]);
  return { ref, overflowing };
}

function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const streaming = useContext(StreamingCode);
  const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : undefined;
  const language = code?.className?.match(/\blanguage-([\w+#.-]+)/)?.[1];
  const source = typeof code?.children === "string" ? code.children : undefined;
  const [wrap, setWrap] = useState<boolean | null>(null);
  const { ref, overflowing } = useCodeOverflow(source, wrap);
  const { copied, copy } = useClipboardCopy(source ?? children, "Could not copy the code. Select it and copy manually.");

  useEffect(() => {
    if (streaming || !language || !source || source.length > 32_000 || !CSS.highlights || typeof StaticRange !== "function") return;
    const text = ref.current?.querySelector("code")?.firstChild;
    if (text instanceof Text && text.data === source) return highlightChatCode(text, language.toLowerCase());
  }, [language, ref, source, streaming]);
  const scrollable = overflowing && !wrap;
  return <div className="text-code-block" data-wrapped={wrap || undefined}>
    <div className="text-code-toolbar">
      <span>{language ?? "Code"}</span>
      <div className="text-code-actions">
        {(overflowing || wrap !== null) && <Button variant="ghost" aria-label="Wrap code" aria-pressed={!!wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={13} aria-hidden="true" />Wrap
        </Button>}
        <Button variant="ghost" onClick={() => void copy(source ?? ref.current?.textContent ?? "")} aria-label={copied ? "Code copied" : "Copy code"}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "Copied" : "Copy"}
        </Button>
        <span className="sr-only" role="status">{copied ? "Code copied" : ""}</span>
      </div>
    </div>
    <pre ref={ref} data-chat-horizontal-scroll tabIndex={scrollable ? 0 : undefined} role={scrollable ? "region" : undefined}
      aria-label={scrollable ? language ? `${language} code` : "Code block" : undefined}>{children}</pre>
  </div>;
}

function cellText(cell: HTMLTableCellElement) {
  const value = (cell.textContent ?? "").replace(/[\t\r\n]+/g, " ").trim();
  const normalized = value.normalize("NFKC");
  const signedNumber = /^[+-](?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?%?$/i.test(normalized);
  // Model-generated formula-like cells are copied as text. Signed numbers remain numbers.
  return /^[=+@-]/.test(normalized) && !signedNumber ? `'${value}` : value;
}

function MarkdownTable({ children }: ComponentPropsWithoutRef<"table">) {
  const table = useRef<HTMLTableElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [fitted, setFitted] = useState<boolean | null>(null);
  const [tightFit, setTightFit] = useState(false);
  const { copied, copy } = useClipboardCopy(children, "Could not copy the table. Select its cells and copy manually.");
  useEffect(() => {
    const viewport = scroller.current;
    const element = table.current;
    if (!viewport || !element) return;
    let availableWidth = 0;
    let renderedWidth = 0;
    const observer = new ResizeObserver((entries) => {
      // The table owns its intrinsic width. Use the boxes from this layout
      // pass so an appended chunk doesn't schedule another geometry read.
      for (const entry of entries) {
        if (entry.target === viewport) availableWidth = entry.contentRect.width;
        else renderedWidth = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
      }
      if (!availableWidth || !renderedWidth) return;
      const needsScroll = renderedWidth > availableWidth + 1;
      setOverflowing(needsScroll);
      if (fitted && needsScroll) setTightFit(true);
    });
    observer.observe(viewport);
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [fitted]);
  const copyRows = () => {
    if (!table.current) return;
    const rows = Array.from(table.current.rows, (row) => Array.from(row.cells, cellText).join("\t"));
    void copy(rows.join("\n"));
  };
  return <div className="text-table-block" data-fitted={fitted || undefined} data-tight-fit={fitted && tightFit || undefined}>
    <div className="text-table-toolbar">
      {(overflowing || fitted !== null) && <Button variant="ghost" aria-label="Fit table to chat" aria-pressed={!!fitted} onClick={() => {
        if (!fitted && scroller.current) scroller.current.scrollLeft = 0;
        setFitted(!fitted);
        setTightFit(false);
      }}>
        <MoveHorizontal size={13} aria-hidden="true" />Fit width
      </Button>}
      <Tooltip content={copied ? "Table copied" : "Copy table as tab-separated values"}>
        <Button variant="ghost" onClick={copyRows} aria-label={copied ? "Table copied" : "Copy table"}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "Copied" : "Copy table"}
        </Button>
      </Tooltip>
      <span className="sr-only" role="status">{copied ? "Table copied" : ""}</span>
    </div>
    <div className="text-table-scroll" ref={scroller} data-chat-horizontal-scroll tabIndex={overflowing ? 0 : undefined}
      role={overflowing ? "region" : undefined} aria-label={overflowing ? "Scrollable table" : undefined}>
      <table ref={table}>{children}</table>
    </div>
  </div>;
}

function CitationButton({ children, "data-document-source": number }: ComponentPropsWithoutRef<"button"> & {
  "data-document-source"?: number;
}) {
  const citations = useContext(DocumentCitations);
  const source = typeof number === "number" ? citations?.sources.get(number) : undefined;
  if (!source || !citations) return <>{children}</>;
  return <button type="button" className="text-source-link text-source-link--inline"
    aria-label={`Open source [${source.number}], ${source.name}, ${source.location}`}
    onClick={(event) => citations.onOpen(source, event.currentTarget)}>{children}</button>;
}

const components = {
  pre: CodeBlock,
  table: MarkdownTable,
  button: CitationButton,
  // Model output cannot load remote images or invoke local URL schemes.
  img: ({ alt }: ComponentPropsWithoutRef<"img">) => <span>{alt}</span>,
  a: ({ href, children }: ComponentPropsWithoutRef<"a">) => /^https?:\/\//i.test(href ?? "")
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
};

function citeText(node: Text, sources: ReadonlyMap<number, ChatDocumentSource>): ElementContent[] {
  if (!node.value.includes("[")) return [node];
  const children: ElementContent[] = [];
  let start = 0;
  for (const match of node.value.matchAll(/\[([1-9]\d?)\]/g)) {
    const number = Number(match[1]);
    if (!sources.has(number)) continue;
    if (start < match.index) children.push({ type: "text", value: node.value.slice(start, match.index) });
    children.push({ type: "element", tagName: "button", properties: { "data-document-source": number },
      children: [{ type: "text", value: match[0] }] });
    start = match.index + match[0].length;
  }
  if (!children.length) return [node];
  if (start < node.value.length) children.push({ type: "text", value: node.value.slice(start) });
  return children;
}

function skipsCitations(node: Element) {
  return node.tagName === "a" || node.tagName === "code" || node.tagName === "pre";
}

function citationHeaderText(node: RootContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element" || skipsCitations(node)) return "";
  if (node.tagName === "br") return "\n";
  const contents = node.children.map(citationHeaderText).join("");
  return node.tagName === "li" || node.tagName === "p" ? `${contents}\n` : contents;
}

function inlineDocumentSources(blocks: readonly RootContent[], documents: readonly ChatDocumentSource[]) {
  const sources = new Map(documents.map((source) => [source.number, source]));
  for (const block of blocks) {
    // A model can copy the numbered source headers and renumber them. Keep
    // conflicting numbers as text so they cannot point at a different page.
    const headers = citationHeaderText(block).matchAll(/^[ \t]*\[([1-9]\d?)\][ \t]+([^\n]+?)[ \t]+·[ \t]+((?:Page|Section) \d+)\b/gm);
    for (const [, number, name, location] of headers) {
      const source = sources.get(Number(number));
      if (source && (source.name !== name || source.location !== location)) sources.delete(Number(number));
    }
  }
  return sources;
}

function citeElement(node: Element, sources: ReadonlyMap<number, ChatDocumentSource>): Element {
  if (skipsCitations(node)) return node;
  return { ...node, children: node.children.flatMap((child) => child.type === "text" ? citeText(child, sources)
    : child.type === "element" ? [citeElement(child, sources)] : [child]) };
}

function markdownElement(node: RootContent, sources?: ReadonlyMap<number, ChatDocumentSource>) {
  return node.type === "text" ? node.value : toJsxRuntime(sources && node.type === "element" ? citeElement(node, sources) : node, {
    components, Fragment, jsx, jsxs, ignoreInvalidStyle: true, passKeys: true,
  });
}

const MarkdownTableRow = memo(function MarkdownTableRow({ node }: { node: Element }) {
  const citations = useContext(DocumentCitations);
  return markdownElement(node, citations?.sources);
});

const MarkdownTableSection = memo(function MarkdownTableSection({ node }: { node: Element }) {
  const Section = node.tagName === "thead" ? "thead" : "tbody";
  return <Section>{node.children.map((row, index) => row.type === "element"
    ? <MarkdownTableRow key={index} node={row} /> : null)}</Section>;
});

function isTable(node: RootContent): node is Element {
  return node.type === "element" && node.tagName === "table";
}

const MarkdownBlock = memo(function MarkdownBlock({ node }: { node: RootContent }) {
  const citations = useContext(DocumentCitations);
  return isTable(node)
    ? <MarkdownTable>{node.children.map((section, index) => section.type === "element"
      ? <MarkdownTableSection key={index} node={section} /> : null)}</MarkdownTable>
    : markdownElement(node, citations?.sources);
}, (previous, next) => previous.node === next.node ||
  (!isTable(next.node) && !isTable(previous.node) && JSON.stringify(previous.node) === JSON.stringify(next.node)));

export const TextMarkdown = memo(function TextMarkdown({ content, streaming = false, receivingReply = streaming, stopped = false, preserveSelection = false,
  documentSources, onOpenSource }: {
  content: string; streaming?: boolean; receivingReply?: boolean; stopped?: boolean; preserveSelection?: boolean;
  documentSources?: readonly ChatDocumentSource[]; onOpenSource?: OpenDocumentSource;
}) {
  const { blocks: parsed, pending } = useChatMarkdown(content, streaming, receivingReply, stopped);
  const rendered = useRef(parsed);
  // A pending parse can replace visible nodes even when the reply text is held.
  useLayoutEffect(() => {
    if (!preserveSelection) rendered.current = parsed;
  }, [parsed, preserveSelection]);
  const blocks = preserveSelection ? rendered.current : parsed;
  // Incoming text can outpace the Markdown worker. Reuse the rendered list
  // until the worker publishes different blocks.
  const elements = useMemo(() => blocks?.map((block, index) => <MarkdownBlock key={index} node={block} />), [blocks]);
  const citations = useMemo(() => {
    if (!blocks || pending || !documentSources?.length || !onOpenSource || receivingReply || preserveSelection) return;
    const sources = inlineDocumentSources(blocks, documentSources);
    return sources.size ? { sources, onOpen: onOpenSource } : undefined;
  }, [blocks, documentSources, onOpenSource, pending, preserveSelection, receivingReply]);
  const hasBlocks = !!elements?.length;
  const formatting = !elements || (pending && (!hasBlocks || !receivingReply));
  const waitingWithPreview = formatting && hasBlocks;
  const [formattingDelayElapsed, setFormattingDelayElapsed] = useState(false);
  useEffect(() => {
    if (!waitingWithPreview) {
      setFormattingDelayElapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setFormattingDelayElapsed(true), 250);
    return () => window.clearTimeout(timer);
  }, [waitingWithPreview]);
  return <StreamingCode.Provider value={streaming}>
    <DocumentCitations.Provider value={citations}>{elements}</DocumentCitations.Provider>
    {formatting && <div data-chat-markdown-formatting="" data-chat-markdown-pending={!hasBlocks || undefined}
      hidden={waitingWithPreview && !formattingDelayElapsed}>
      <span className="text-thinking">Formatting response…</span>
    </div>}
  </StreamingCode.Provider>;
});
