import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const PAGE_SIZE = 24;
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

function TranscriptPage({ index, first, last, estimate, mounted, cache, children }: {
  index: number;
  first: string;
  last: string;
  estimate: number;
  mounted: boolean;
  cache: Map<number, Measurement>;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const cached = cache.get(index);
  const rememberedHeight = cached?.first === first && cached.last === last ? cached.height : estimate;

  useLayoutEffect(() => {
    const page = element.current;
    if (!mounted || !page) return;
    const measure = () => {
      const height = page.getBoundingClientRect().height;
      if (height > 0) cache.set(index, { first, last, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, [cache, first, index, last, mounted]);

  return <div ref={element} className="text-transcript-page" data-chat-page={index} data-deferred={!mounted || undefined}
    aria-hidden={mounted ? undefined : true}
    style={mounted ? undefined : { height: rememberedHeight }}>{children}</div>;
}

export function TextTranscriptWindow({ threadId, items, revealIndex, restoreIndex, renderItem }: {
  threadId: string;
  items: readonly TextTranscriptItem[];
  revealIndex: number;
  restoreIndex: number;
  renderItem: (index: number) => ReactNode;
}) {
  const windowed = items.length > TEXT_TRANSCRIPT_WINDOW_THRESHOLD;
  const pageCount = Math.ceil(items.length / PAGE_SIZE);
  const restorePage = Math.floor(restoreIndex / PAGE_SIZE);
  const root = useRef<HTMLDivElement>(null);
  const [cache] = useState(() => measurementsFor(threadId));
  const [nearby, setNearby] = useState(() => restorePage < 0 ? cache.nearby
    : new Set([...cache.nearby, restorePage - 1, restorePage, restorePage + 1].filter((index) => index >= 0 && index < pageCount)));
  const [focused, setFocused] = useState<number | null>(null);
  const [selection, setSelection] = useState<[number, number] | null>(null);

  useLayoutEffect(() => {
    const container = root.current;
    const feed = container?.closest(".text-conversation");
    if (!windowed || !container || !feed) return;
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
    }, { root: feed, rootMargin: OVERSCAN });
    for (const page of container.children) observer.observe(page);
    return () => observer.disconnect();
  }, [pageCount, windowed]);

  useLayoutEffect(() => { cache.nearby = nearby; }, [cache, nearby]);

  useEffect(() => {
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
    document.addEventListener("selectionchange", trackSelection);
    return () => document.removeEventListener("selectionchange", trackSelection);
  }, [windowed]);

  if (!windowed) return <>{items.map((_, index) => renderItem(index))}</>;

  const revealPage = Math.floor(revealIndex / PAGE_SIZE);
  return <div ref={root} className="text-transcript-pages" onFocusCapture={(event) => setFocused(pageOf(event.target, root.current))}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null); }}>
    {Array.from({ length: pageCount }, (_, index) => {
      const firstIndex = index * PAGE_SIZE;
      const page = items.slice(firstIndex, firstIndex + PAGE_SIZE);
      const mounted = index >= pageCount - 2 || nearby.has(index) || nearTarget(index, revealPage) || nearTarget(index, restorePage) || index === focused ||
        !!selection && index >= selection[0] && index <= selection[1];
      return <TranscriptPage key={index} index={index} first={page[0].key} last={page[page.length - 1].key}
        estimate={mounted ? 0 : page.reduce((total, item) => total + item.estimatedHeight, 0)}
        cache={cache.pages} mounted={mounted}>
        {mounted ? page.map((_, offset) => renderItem(firstIndex + offset)) : null}
      </TranscriptPage>;
    })}
  </div>;
}
