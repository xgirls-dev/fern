export type CodeHighlightGroup = "keyword" | "string" | "value" | "comment" | "name";
export type CodeHighlightToken = { group: CodeHighlightGroup; start: number; end: number };
export type CodeHighlightRequest = { id: number; source: string; language: string };
type CodeHighlightResponse = { id: number; tokens: CodeHighlightToken[] };

const HIGHLIGHTS_PER_TASK = 128;
let codeWorker: Worker | undefined;
let requestId = 0;
const pending = new Map<number, (tokens: CodeHighlightToken[]) => void>();

function getCodeWorker() {
  if (codeWorker) return codeWorker;
  const worker = new Worker(new URL("./textCodeHighlight.worker.ts", import.meta.url), { type: "module", name: "fern-code-colors" });
  worker.onmessage = ({ data }: MessageEvent<CodeHighlightResponse>) => {
    const receive = pending.get(data.id);
    pending.delete(data.id);
    receive?.(data.tokens);
  };
  const reset = () => {
    if (codeWorker !== worker) return;
    worker.terminate();
    codeWorker = undefined;
    pending.clear();
  };
  worker.onerror = reset;
  worker.onmessageerror = reset;
  codeWorker = worker;
  return worker;
}

function applyCodeHighlights(text: Text, source: string, tokens: CodeHighlightToken[]) {
  const ranges: { key: string; highlight: Highlight; range: StaticRange }[] = [];
  let index = 0;
  let timer: number | undefined;
  const apply = () => {
    if (!text.isConnected || text.data !== source) return;
    const endIndex = Math.min(index + HIGHLIGHTS_PER_TASK, tokens.length);
    for (; index < endIndex; index++) {
      const { group, start, end } = tokens[index];
      const key = `fern-code-${group}`;
      let highlight = CSS.highlights.get(key);
      if (!highlight) {
        highlight = new Highlight();
        highlight.priority = -1; // Chat Find paints over syntax colors.
        CSS.highlights.set(key, highlight);
      }
      const range = new StaticRange({ startContainer: text, startOffset: start, endContainer: text, endOffset: end });
      highlight.add(range);
      ranges.push({ key, highlight, range });
    }
    if (index < tokens.length) timer = window.setTimeout(apply, 0);
  };
  apply();
  return () => {
    window.clearTimeout(timer);
    for (const { key, highlight, range } of ranges) {
      highlight.delete(range);
      if (!highlight.size && CSS.highlights.get(key) === highlight) CSS.highlights.delete(key);
    }
  };
}

export function highlightChatCode(text: Text, language: string) {
  const source = text.data;
  const id = ++requestId;
  let timer: number | undefined;
  let clear: (() => void) | undefined;
  // Let the formatted reply paint before starting optional syntax coloring.
  const frame = window.requestAnimationFrame(() => {
    timer = window.setTimeout(() => {
      if (!text.isConnected || text.data !== source) return;
      try {
        const worker = getCodeWorker();
        pending.set(id, (tokens) => { clear = applyCodeHighlights(text, source, tokens); });
        worker.postMessage({ id, source, language } satisfies CodeHighlightRequest);
      } catch {
        pending.delete(id);
      }
    }, 0);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    pending.delete(id);
    clear?.();
  };
}
