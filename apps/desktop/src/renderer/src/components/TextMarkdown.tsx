import { cloneElement, createContext, Fragment, isValidElement, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { RootContent } from "hast";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import MoveHorizontal from "lucide-react/dist/esm/icons/move-horizontal.mjs";
import WrapText from "lucide-react/dist/esm/icons/wrap-text.mjs";
import { notify } from "../lib/notifications";
import { useChatMarkdown } from "../hooks/useChatMarkdown";
import { Button } from "./ui/controls";
import { Tooltip } from "./ui/Tooltip";

const StreamingCode = createContext(false);
type StreamCursor = "active" | "waiting";
type StreamTailProps = { "data-stream-tail"?: StreamCursor };

function useHorizontalOverflow<T extends HTMLElement>(content: unknown, fitted: boolean | null) {
  const ref = useRef<T>(null);
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
  }, [measureOverflow, content, fitted]);
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

function useCopyFeedback(errorMessage: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (value: string) => {
    try {
      await window.studio.copyText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      notify(errorMessage, "error");
    }
  };
  return { copied, copy };
}

function CodeBlock({ children, "data-stream-tail": streamTail }: ComponentPropsWithoutRef<"pre"> & StreamTailProps) {
  const streaming = useContext(StreamingCode);
  const code = isValidElement<{ className?: string; children?: unknown }>(children) ? children.props : undefined;
  const language = code?.className?.match(/\blanguage-([\w+#.-]+)/)?.[1];
  const source = typeof code?.children === "string" ? code.children : undefined;
  const [wrap, setWrap] = useState<boolean | null>(null);
  const { ref, overflowing } = useHorizontalOverflow<HTMLPreElement>(source, wrap);
  const { copied, copy } = useCopyFeedback("Could not copy the code. Select it and copy manually.");

  useEffect(() => {
    if (streaming || !language || !source || source.length > 32_000 || !CSS.highlights || typeof StaticRange !== "function") return;
    let cancelled = false;
    let clear: (() => void) | undefined;
    void import("../lib/textCodeHighlight").then(({ highlightChatCode }) => {
      const text = ref.current?.querySelector("code")?.firstChild;
      if (!cancelled && text instanceof Text && text.data === source) clear = highlightChatCode(text, language.toLowerCase());
    }).catch(() => { /* The same code stays readable when highlighting is unavailable. */ });
    return () => { cancelled = true; clear?.(); };
  }, [language, ref, source, streaming]);
  const scrollable = overflowing && !wrap;
  return <div className="text-code-block" data-wrapped={wrap || undefined} data-stream-tail={streamTail}>
    <div className="text-code-toolbar">
      <span>{language ?? "Code"}</span>
      <div className="text-code-actions">
        {(overflowing || wrap !== null) && <Button variant="ghost" aria-label="Wrap code" aria-pressed={!!wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={13} aria-hidden="true" />Wrap
        </Button>}
        <Button variant="ghost" onClick={() => void copy(source ?? ref.current?.textContent ?? "")} aria-label={copied ? "Code copied" : "Copy code"}>
          <Copy size={13} aria-hidden="true" />{copied ? "Copied" : "Copy"}
        </Button>
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

function MarkdownTable({ children, "data-stream-tail": streamTail }: ComponentPropsWithoutRef<"table"> & StreamTailProps) {
  const table = useRef<HTMLTableElement>(null);
  const [fitted, setFitted] = useState<boolean | null>(null);
  const [tightFit, setTightFit] = useState(false);
  const { ref, overflowing } = useHorizontalOverflow<HTMLDivElement>(children, fitted);
  const { copied, copy } = useCopyFeedback("Could not copy the table. Select its cells and copy manually.");
  useLayoutEffect(() => {
    if (!fitted || tightFit) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = ref.current;
      if (viewport?.clientWidth && table.current
        && table.current.getBoundingClientRect().width > viewport.clientWidth + 1) {
        setTightFit(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [children, fitted, overflowing, ref, tightFit]);
  const copyRows = () => {
    if (!table.current) return;
    const rows = Array.from(table.current.rows, (row) => Array.from(row.cells, cellText).join("\t"));
    void copy(rows.join("\n"));
  };
  return <div className="text-table-block" data-fitted={fitted || undefined} data-tight-fit={fitted && tightFit || undefined} data-stream-tail={streamTail}>
    <div className="text-table-toolbar">
      {(overflowing || fitted !== null) && <Button variant="ghost" aria-label="Fit table to chat" aria-pressed={!!fitted} onClick={() => {
        if (!fitted && ref.current) ref.current.scrollLeft = 0;
        setFitted(!fitted);
        setTightFit(false);
      }}>
        <MoveHorizontal size={13} aria-hidden="true" />Fit width
      </Button>}
      <Tooltip content={copied ? "Table copied" : "Copy table as tab-separated values"}>
        <Button variant="ghost" onClick={copyRows} aria-label={copied ? "Table copied" : "Copy table"}>
          <Copy size={13} aria-hidden="true" />{copied ? "Copied" : "Copy table"}
        </Button>
      </Tooltip>
    </div>
    <div className="text-table-scroll" ref={ref} data-chat-horizontal-scroll tabIndex={overflowing ? 0 : undefined}
      role={overflowing ? "region" : undefined} aria-label={overflowing ? "Scrollable table" : undefined}>
      <table ref={table}>{children}</table>
    </div>
  </div>;
}

const components = {
  pre: CodeBlock,
  table: MarkdownTable,
  // Model output cannot load remote images or invoke local URL schemes.
  img: ({ alt }: ComponentPropsWithoutRef<"img">) => <span>{alt}</span>,
  a: ({ href, children }: ComponentPropsWithoutRef<"a">) => /^https?:\/\//i.test(href ?? "")
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
};
const MarkdownBlock = memo(function MarkdownBlock({ node, cursor }: { node: RootContent; cursor?: StreamCursor }) {
  const element = useMemo(() => node.type === "text" ? node.value : toJsxRuntime(node, {
    components, Fragment, jsx, jsxs, ignoreInvalidStyle: true, passKeys: true,
  }), [node]);
  return cursor && isValidElement<StreamTailProps>(element) ? cloneElement(element, { "data-stream-tail": cursor }) : element;
}, (previous, next) => previous.cursor === next.cursor && (previous.node === next.node || JSON.stringify(previous.node) === JSON.stringify(next.node)));

export const TextMarkdown = memo(function TextMarkdown({ content, streaming = false, receivingReply = streaming, cursor, preserveSelection = false }: {
  content: string; streaming?: boolean; receivingReply?: boolean; cursor?: StreamCursor; preserveSelection?: boolean;
}) {
  const parsed = useChatMarkdown(content, streaming, receivingReply);
  const rendered = useRef(parsed);
  // A pending parse can replace visible nodes even when the reply text is held.
  useLayoutEffect(() => {
    if (!preserveSelection) rendered.current = parsed;
  }, [parsed, preserveSelection]);
  const blocks = preserveSelection ? rendered.current : parsed;
  let tail = cursor && blocks ? blocks.length - 1 : -1;
  while (tail >= 0 && blocks?.[tail].type !== "element") tail -= 1;
  return <StreamingCode.Provider value={streaming}>
    {blocks ? blocks.map((block, index) => <MarkdownBlock key={index} node={block} cursor={index === tail ? cursor : undefined} />)
      : <p data-chat-markdown-pending="" data-stream-tail={cursor}>{content.slice(0, 512)}…</p>}
    {cursor && <span className="text-stream-cursor" data-waiting={cursor === "waiting" || undefined} aria-hidden="true" />}
  </StreamingCode.Provider>;
});
