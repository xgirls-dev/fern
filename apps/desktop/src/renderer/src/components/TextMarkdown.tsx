import { createContext, isValidElement, memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import MoveHorizontal from "lucide-react/dist/esm/icons/move-horizontal.mjs";
import WrapText from "lucide-react/dist/esm/icons/wrap-text.mjs";
import { notify } from "../lib/notifications";
import { hasStreamingMarkdown, previewMarkdown, remarkStreamingPreview } from "../lib/streamingMarkdown";
import { Button } from "./ui/controls";

const StreamingCode = createContext(false);

function useHorizontalOverflow<T extends HTMLElement>(content: unknown, fitted: boolean | null) {
  const ref = useRef<T>(null);
  const [overflowing, setOverflowing] = useState(false);
  const measureOverflow = useCallback(() => {
    const element = ref.current;
    if (element?.clientWidth) setOverflowing(element.scrollWidth > element.clientWidth + 1);
  }, []);
  useLayoutEffect(measureOverflow, [measureOverflow, content, fitted]);
  useLayoutEffect(() => {
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

function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
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
  return <div className="text-code-block" data-wrapped={wrap || undefined}>
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

function MarkdownTable({ children }: ComponentPropsWithoutRef<"table">) {
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
  return <div className="text-table-block" data-fitted={fitted || undefined} data-tight-fit={fitted && tightFit || undefined}>
    <div className="text-table-toolbar">
      {(overflowing || fitted !== null) && <Button variant="ghost" aria-label="Fit table to chat" aria-pressed={!!fitted} onClick={() => {
        if (!fitted && ref.current) ref.current.scrollLeft = 0;
        setFitted(!fitted);
        setTightFit(false);
      }}>
        <MoveHorizontal size={13} aria-hidden="true" />Fit width
      </Button>}
      <Button variant="ghost" onClick={copyRows} aria-label={copied ? "Table copied" : "Copy table"} title="Copy table as tab-separated values">
        <Copy size={13} aria-hidden="true" />{copied ? "Copied" : "Copy table"}
      </Button>
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
const plugins = [remarkGfm];
const streamingPlugins = [remarkGfm, remarkStreamingPreview];
export const TextMarkdown = memo(function TextMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const preview = streaming && hasStreamingMarkdown(content);
  return <StreamingCode.Provider value={streaming}>
    <Markdown remarkPlugins={preview ? streamingPlugins : plugins} components={components}>
      {preview ? previewMarkdown(content) : content}
    </Markdown>
  </StreamingCode.Provider>;
});
