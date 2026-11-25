import { cloneElement, memo, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { TextMessage } from "../lib/textThreads";

const rowHeights = new WeakMap<TextMessage, number>();

export function estimateTextRowHeight(message: TextMessage) {
  const remembered = rowHeights.get(message);
  if (remembered !== undefined) return remembered;
  const sample = message.content.slice(0, 30_000);
  const lines = sample.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 84)), 0);
  const illustration = message.generatedImage ? 420 : message.image ? 220 : 0;
  const estimate = 64 + lines * 25 + illustration + (message.reasoning ? 26 : 0) + (message.error ? 24 : 0);
  rowHeights.set(message, estimate);
  return estimate;
}

const PAGE_SIZE = 12;
export const TEXT_TRANSCRIPT_WINDOW_THRESHOLD = 72;
const OVERSCAN = "640px 0px";
const CACHED_CHATS = 20;

export interface TextTranscriptItem {
  key: string;
  estimatedHeight: number;
}

interface Measurement {
  first: string;
  last: string;
  height: number;
}

interface ChatWindowCache {
  pages: Map<number, Measurement>;
  nearby: Set<number>;
}

// Reuse measured heights when the user returns to the same scroll position.
const measurements = new Map<string, ChatWindowCache>();

function measurementsFor(threadId: string) {
  const cached = measurements.get(threadId) ?? { pages: new Map(), nearby: new Set<number>() };
  measurements.delete(threadId);
  measurements.set(threadId, cached);
  if (measurements.size > CACHED_CHATS) {
    const oldest = measurements.keys().next().value;
    if (oldest !== undefined) measurements.delete(oldest);
  }
  return cached;
}

// Include the neighboring pages so their estimates cannot move a jump target.
function nearTarget(index: number, target: number) {
  return target >= 0 && Math.abs(target - index) <= 1;
}

function pageOf(node: Node | null, container: HTMLElement | null): number | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const page = element?.closest<HTMLElement>("[data-chat-page]");
  return page && container?.contains(page) ? Number(page.dataset.chatPage) : null;
}

const TranscriptPage = memo(function TranscriptPage({ index, first, last, estimate, windowed, cache, renderItem, storedCount, liveReply }: {
  index: number;
  first: string;
  last: string;
  estimate: number;
  windowed: boolean;
  cache: Map<number, Measurement>;
  renderItem?: (index: number) => ReactElement;
  storedCount: number;
  liveReply?: ReactElement;
}) {
  const element = useRef<HTMLDivElement>(null);
  const mounted = !!renderItem;
  const cached = cache.get(index);
  const rememberedHeight = cached?.first === first && cached.last === last ? cached.height : estimate;
  const rows = useMemo(() => renderItem ? Array.from({ length: storedCount }, (_, offset) => renderItem(index * PAGE_SIZE + offset)) : [],
    [index, renderItem, storedCount]);

  useLayoutEffect(() => {
    const page = element.current;
    if (!windowed || !mounted || !page) return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
      if (height > 0) cache.set(index, { first, last, height });
    });
    observer.observe(page);
    return () => observer.disconnect();
  }, [cache, first, index, last, mounted, windowed]);

  return <div ref={element} className="text-transcript-page" data-chat-page={index} data-deferred={!mounted || undefined}
    aria-hidden={mounted ? undefined : true}
    style={mounted ? undefined : { height: rememberedHeight }}>{liveReply ? [...rows, liveReply] : rows}</div>;
});

export const TextTranscriptWindow = memo(function TextTranscriptWindow({ threadId, items, revealIndex, restoreIndex, renderItem, liveReply }: {
  threadId: string;
  items: readonly TextTranscriptItem[];
  revealIndex: number;
  restoreIndex: number;
  renderItem: (index: number) => ReactElement;
  liveReply?: ReactElement;
}) {
  const windowed = items.length > TEXT_TRANSCRIPT_WINDOW_THRESHOLD;
  const pageCount = Math.ceil(items.length / PAGE_SIZE);
  const restorePage = Math.floor(restoreIndex / PAGE_SIZE);
  const root = useRef<HTMLDivElement>(null);
  const pageObserver = useRef<IntersectionObserver | null>(null);
  const observedPages = useRef<Element[]>([]);
  const [cache] = useState(() => measurementsFor(threadId));
  const [nearby, setNearby] = useState(() => restorePage < 0 ? cache.nearby
    : new Set([...cache.nearby, restorePage - 1, restorePage, restorePage + 1].filter((index) => index >= 0 && index < pageCount)));
  const [canDeferPages, setCanDeferPages] = useState(windowed);
  const [focused, setFocused] = useState<number | null>(null);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const pages = useMemo(() => Array.from({ length: pageCount }, (_, index) => {
    const start = index * PAGE_SIZE;
    const page = items.slice(start, start + PAGE_SIZE);
    return { first: page[0].key, last: page[page.length - 1].key, count: page.length,
      estimatedHeight: page.reduce((height, item) => height + item.estimatedHeight, 0) };
  }), [items, pageCount]);

  useLayoutEffect(() => {
    if (!windowed) {
      setCanDeferPages(false);
      return;
    }
    const container = root.current;
    const feed = container?.closest(".text-conversation");
    if (!container || !feed) return;
    const observer = new IntersectionObserver((entries) => {
      setNearby((current) => {
        let next = current;
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.chatPage);
          if (next.has(page) === entry.isIntersecting) continue;
          if (next === current) next = new Set(current);
          if (entry.isIntersecting) next.add(page);
          else next.delete(page);
        }
        return next;
      });
      setCanDeferPages(true);
    }, { root: feed, rootMargin: OVERSCAN });
    pageObserver.current = observer;
    return () => {
      observer.disconnect();
      pageObserver.current = null;
      observedPages.current = [];
    };
  }, [windowed]);

  useLayoutEffect(() => {
    const observer = pageObserver.current;
    const pages = root.current?.children;
    if (!observer || !pages) return;
    // Page elements keep their index keys when the transcript grows or shrinks.
    const observed = observedPages.current;
    for (const page of observed.splice(pageCount)) observer.unobserve(page);
    for (let index = observed.length; index < pageCount; index += 1) {
      const page = pages[index];
      observer.observe(page);
      observed.push(page);
    }
  }, [pageCount, windowed]);

  useLayoutEffect(() => { cache.nearby = nearby; }, [cache, nearby]);

  useLayoutEffect(() => {
    if (!windowed) return;
    const trackSelection = () => {
      const selected = window.getSelection();
      const from = selected && !selected.isCollapsed ? pageOf(selected.anchorNode, root.current) : null;
      const to = selected && !selected.isCollapsed ? pageOf(selected.focusNode, root.current) : null;
      setSelection((current) => {
        if (from === null || to === null) return null;
        const first = Math.min(from, to);
        const last = Math.max(from, to);
        return current?.[0] === first && current[1] === last ? current : [first, last];
      });
    };
    trackSelection();
    document.addEventListener("selectionchange", trackSelection);
    return () => document.removeEventListener("selectionchange", trackSelection);
  }, [windowed]);

  const revealPage = Math.floor(revealIndex / PAGE_SIZE);
  const hasLiveReply = Boolean(liveReply);
  // A token only changes the tail. Reuse page elements until their inputs change.
  const pageElements = useMemo(() => pages.map((page, index) => {
    const mounted = !windowed || !canDeferPages || index >= pageCount - 2 || nearby.has(index) || nearTarget(index, revealPage) ||
      nearTarget(index, restorePage) || index === focused || !!selection && index >= selection[0] && index <= selection[1];
    const hasTail = hasLiveReply && index === pageCount - 1;
    return <TranscriptPage key={index} index={index} first={page.first} last={page.last}
      estimate={page.estimatedHeight} cache={cache.pages} windowed={windowed} renderItem={mounted ? renderItem : undefined}
      storedCount={page.count - (hasTail ? 1 : 0)} />;
  }), [cache, canDeferPages, focused, hasLiveReply, nearby, pageCount, pages, renderItem, restorePage, revealPage, selection, windowed]);
  if (!pageCount) return null;

  // Keep every page in the same keyed list when a new tail page is added.
  const children = liveReply ? pageElements.slice() : pageElements;
  if (liveReply) children[pageCount - 1] = cloneElement(pageElements[pageCount - 1], { liveReply });
  return <div ref={root} className="text-transcript-pages" onFocusCapture={(event) => setFocused(pageOf(event.target, root.current))}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null); }}>
    {children}
  </div>;
});
