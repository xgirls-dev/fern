import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { flushChatReadingPositions, getChatReadingPosition, readingLineFingerprint, saveChatReadingPosition,
  type ReadingLine, type ReadingSection, type ScrollPosition } from "../lib/chatReadingPositions";
import type { ChatSearchMatch } from "../lib/chatSearch";
import { isComposingKey } from "../lib/keyboard";
import { chatSearchPattern, findChatSearchRange, isChatSearchBlock } from "../lib/chatSearchRange";

const readingSections: Record<ReadingSection, string> = { answer: ".text-message-content", reasoning: ".text-reasoning > div" };
const findHighlight = "fern-chat-find";
const horizontalScroller = "[data-chat-horizontal-scroll]";
const conversationControl = `a[href], button, summary, input, textarea, select, ${horizontalScroller}[tabindex='0'], [contenteditable=true], [role=button]`;
// Chromium can report a fractional scrollTop against an integer scrollHeight.
const tailTolerance = 2;
// A streaming update can add a line between scrolling down and handling the scroll event.
const resumeTolerance = 24;
const scrollInputWindow = 160;
const findLayoutRetries = 32;
const findLayoutMaxDelay = 96;

function distanceFromTail(feed: HTMLElement) {
  return feed.scrollHeight - feed.clientHeight - feed.scrollTop;
}

function atLatest(feed: HTMLElement) {
  return distanceFromTail(feed) <= tailTolerance;
}

export function chatSelectionIntersects(...nodes: (Node | null)[]) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  return nodes.some((node) => node && range.intersectsNode(node));
}

function renderedMatch(scope: Element, find: Pick<ChatSearchMatch, "query" | "occurrence">): Range | undefined {
  const nodes: { text: Text; start: number }[] = [];
  let content = "";
  function read(node: Node) {
    if (node instanceof Text && node.data) {
      nodes.push({ text: node, start: content.length });
      content += node.data;
    }
    if (!(node instanceof Element) || node.matches('button, [aria-hidden="true"], [hidden], .sr-only, .text-code-toolbar, .text-thinking')) return;
    const block = isChatSearchBlock(node.localName);
    if (block) content += "\n";
    for (const child of node.childNodes) read(child);
    if (block) content += "\n";
  }
  read(scope);
  const match = findChatSearchRange(content, chatSearchPattern(find.query), find.occurrence);
  if (!match) return;
  const start = nodes.find((item) => item.start + item.text.length > match.start);
  const end = nodes.find((item) => item.start + item.text.length >= match.end);
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(start.text, match.start - start.start);
  range.setEnd(end.text, match.end - end.start);
  return range;
}

function replaceFindHighlight(previous: Range | undefined, next: Range | undefined) {
  if (!CSS.highlights || typeof Highlight !== "function") return;
  const ranges = CSS.highlights.get(findHighlight);
  if (previous) ranges?.delete(previous);
  if (next) {
    if (ranges) ranges.add(next);
    else CSS.highlights.set(findHighlight, new Highlight(next));
  } else if (ranges?.size === 0) CSS.highlights.delete(findHighlight);
}

function revealFindRange(feed: HTMLElement, range: Range, image?: HTMLImageElement | null) {
  const line = Array.from(range.getClientRects()).find((rect) => rect.width && rect.height);
  if (!line || !feed.clientHeight) return false;
  const viewport = feed.getBoundingClientRect();
  const top = viewport.top + 8;
  const bottom = viewport.bottom - 12;
  if (image) {
    const visibleImageTop = Math.max(image.getBoundingClientRect().top, line.bottom - (bottom - top));
    if (visibleImageTop < top) feed.scrollTop += visibleImageTop - top;
    else if (line.bottom > bottom) feed.scrollTop += line.bottom - bottom;
  } else if (line.top < top || line.bottom > bottom) {
    feed.scrollTop += line.top - viewport.top - Math.min(40, viewport.height / 4);
  }
  const scroller = range.startContainer.parentElement?.closest(horizontalScroller);
  if (scroller && scroller.scrollWidth > scroller.clientWidth) {
    const bounds = scroller.getBoundingClientRect();
    if (line.left < bounds.left || line.right > bounds.right) scroller.scrollLeft += line.left - bounds.left - 16;
  }
  return true;
}

function characterBounds(text: Text, offset: number) {
  const range = document.createRange();
  range.setStart(text, offset);
  range.setEnd(text, offset + 1);
  return range.getBoundingClientRect();
}

function readingLine(row: Element, viewport: DOMRect): ReadingLine | undefined {
  const y = viewport.top + 12;
  for (const section of ["answer", "reasoning"] as const) {
    const scope = row.querySelector(readingSections[section]);
    if (!scope) continue;
    const bounds = scope.getBoundingClientRect();
    const x = Math.max(bounds.left + 8, viewport.left + 2);
    if (y < bounds.top || y >= bounds.bottom || x >= Math.min(bounds.right, viewport.right)) continue;
    const caret = document.caretPositionFromPoint?.(x, y);
    const range = caret ? undefined : document.caretRangeFromPoint?.(x, y);
    const text = caret?.offsetNode ?? range?.startContainer;
    if (!(text instanceof Text) || !text.length || !scope.contains(text)) continue;
    const character = Math.min(caret?.offset ?? range?.startOffset ?? 0, text.length - 1);
    const line = characterBounds(text, character);
    if (!line.height || y < line.top - 2 || y > line.bottom + 2) continue;
    const path: number[] = [];
    for (let child: Node | null = text; child && child !== scope; child = child.parentNode) {
      let index = 0;
      for (let sibling = child.previousSibling; sibling; sibling = sibling.previousSibling) index += 1;
      path.push(index);
    }
    return { section, path: path.reverse(), character, fingerprint: readingLineFingerprint(text.data, character),
      offset: line.top - viewport.top };
  }
}

function restorePosition(feed: HTMLElement, position: ScrollPosition) {
  const viewport = feed.getBoundingClientRect();
  const anchor = position.anchor;
  const row = anchor && feed.querySelector(`[data-chat-message="${CSS.escape(anchor.id)}"]`);
  if (!row || !anchor) {
    feed.scrollTop = position.top;
    return true;
  }
  const line = anchor.line;
  if (line) {
    const section = row.querySelector(readingSections[line.section]);
    if (section?.querySelector("[data-chat-markdown-pending]")) return false;
    let text: Node | undefined = section ?? undefined;
    for (const index of line.path) text = text?.childNodes[index];
    if (text instanceof Text && line.character < text.length && readingLineFingerprint(text.data, line.character) === line.fingerprint) {
      const bounds = characterBounds(text, line.character);
      if (bounds.height) {
        feed.scrollTop += bounds.top - viewport.top - line.offset;
        return true;
      }
    }
  }
  feed.scrollTop += row.getBoundingClientRect().top - viewport.top - anchor.offset;
  return true;
}

function rememberPosition(threadId: string, feed: HTMLElement, following: boolean, preferred?: Element) {
  if (following) {
    saveChatReadingPosition(threadId);
    return;
  }
  const position: ScrollPosition = { top: feed.scrollTop };
  const viewport = feed.getBoundingClientRect();
  for (const row of preferred ? [preferred] : feed.querySelectorAll("[data-chat-message]")) {
    const bounds = row.getBoundingClientRect();
    const id = row.getAttribute("data-chat-message");
    if (id && bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
      position.anchor = { id, offset: bounds.top - viewport.top, line: bounds.top < viewport.top ? readingLine(row, viewport) : undefined };
      break;
    }
  }
  saveChatReadingPosition(threadId, position);
}

export function useTextScroll(threadId: string, { persistPosition = true, paneFocused = false } = {}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const lastGap = useRef(0);
  const downwardScrollUntil = useRef(0);
  const cancelFindReveal = useRef<(() => void) | undefined>(undefined);
  const layout = useRef({ width: 0, hidden: false });
  const [historyVisible, setHistoryVisible] = useState(true);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [canScroll, setCanScroll] = useState(false);
  const [restoredThread, setRestoredThread] = useState<string>();
  const pendingRestore = useRef<ScrollPosition | undefined>(undefined);
  const restoreAnchor = !persistPosition || restoredThread === threadId ? undefined : getChatReadingPosition(threadId)?.anchor;

  const cancelRestore = useCallback(() => {
    if (!pendingRestore.current) return;
    pendingRestore.current = undefined;
    setRestoredThread(threadId);
  }, [threadId]);

  const savePosition = useCallback((feed: HTMLElement, preferred?: Element) => {
    lastTop.current = feed.scrollTop;
    lastGap.current = distanceFromTail(feed);
    if (persistPosition) {
      rememberPosition(threadId, feed, following.current, preferred);
      if (!following.current) setRestoredThread(threadId);
    }
    setFollowingLatest(following.current);
  }, [persistPosition, threadId]);

  const keepFollowingTail = useCallback(() => {
    const feed = feedRef.current;
    if (!feed || !following.current || layout.current.hidden) return;
    feed.scrollTop = feed.scrollHeight;
    lastTop.current = feed.scrollTop;
    lastGap.current = distanceFromTail(feed);
  }, []);

  const pauseFollowing = useCallback((feed: HTMLElement) => {
    if (!following.current) return;
    following.current = false;
    savePosition(feed);
  }, [savePosition]);

  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (event.target.closest(conversationControl)) pauseFollowing(event.currentTarget);
  }, [pauseFollowing]);

  const onScroll = useCallback(() => {
    const feed = feedRef.current;
    if (!feed?.clientHeight || feed.scrollTop === lastTop.current || layout.current.hidden
      || transcriptRef.current?.clientWidth !== layout.current.width) return;
    cancelRestore();
    const top = feed.scrollTop;
    const gap = distanceFromTail(feed);
    const downwardInput = performance.now() < downwardScrollUntil.current;
    downwardScrollUntil.current = 0;
    if (top < lastTop.current && gap > tailTolerance) following.current = false;
    // Scroll anchoring can move scrollTop when an earlier row grows. Resume only
    // after movement toward the tail, allowing for layout rounding near the end.
    const approachedTail = gap < lastGap.current && (gap <= tailTolerance || gap < lastGap.current - tailTolerance);
    if (!following.current && top > lastTop.current && gap <= resumeTolerance && (approachedTail || downwardInput)) {
      const focused = document.activeElement;
      const workingInChat = focused?.matches(conversationControl) && feed.contains(focused);
      if (!workingInChat && !chatSelectionIntersects(feed)) {
        following.current = true;
        feed.scrollTop = feed.scrollHeight;
      }
    }
    savePosition(feed);
  }, [cancelRestore, savePosition]);

  const jumpToLatest = useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    cancelFindReveal.current?.();
    cancelRestore();
    if (chatSelectionIntersects(feed)) window.getSelection()?.removeAllRanges();
    following.current = true;
    feed.scrollTop = feed.scrollHeight;
    savePosition(feed);
  }, [cancelRestore, savePosition]);

  const revealMessage = useCallback((id: string, find?: Pick<ChatSearchMatch, "query" | "occurrence" | "imageIndex">,
    block: ScrollLogicalPosition = "nearest", scroll = true, onFindHandled?: () => void) => {
    const feed = feedRef.current;
    const row = feed?.querySelector(`[data-chat-message="${CSS.escape(id)}"]`);
    if (!feed || !row) return;
    let target = find && row.querySelector("[data-find-target]");
    let range = find && target ? renderedMatch(target, find) : undefined;
    let pendingReveal = scroll;
    let retryTimer: number | undefined;
    let attemptsLeft = findLayoutRetries;
    let retryDelay = 16;
    const cancelRetry = () => {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      if (cancelFindReveal.current === finishReveal) cancelFindReveal.current = undefined;
    };
    const finishReveal = () => {
      pendingReveal = false;
      cancelRetry();
      onFindHandled?.();
    };
    const reveal = () => {
      if (!pendingReveal || !range) return;
      const image = find?.imageIndex === undefined ? undefined : target?.closest("figure")?.querySelector("img");
      if (revealFindRange(feed, range, image)) {
        finishReveal();
        savePosition(feed, row);
      }
    };
    const revealWhenLaidOut = () => {
      reveal();
      if (!pendingReveal || !range || retryTimer !== undefined || attemptsLeft === 0) return;
      // A slow frame can use up a wall-clock deadline before layout produces a box.
      // Back off on repeated misses so we do not read geometry on every frame.
      attemptsLeft -= 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        revealWhenLaidOut();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, findLayoutMaxDelay);
    };
    if (find) replaceFindHighlight(undefined, range);
    if (scroll) {
      if (find) cancelFindReveal.current = finishReveal;
      else cancelFindReveal.current?.();
      cancelRestore();
      following.current = false;
      revealWhenLaidOut();
      if (pendingReveal) {
        (target ?? row).scrollIntoView({ block });
        savePosition(feed, row);
      }
    }
    if (!find) return;

    // Streaming Markdown can replace the text nodes behind a highlight. Refresh the
    // range in place, revealing it once if the selected text has yet to paint.
    const observer = new MutationObserver((changes) => {
      const nextTarget = row.querySelector("[data-find-target]");
      if (target === nextTarget && !changes.some(({ target: changed }) => nextTarget?.contains(changed))) return;
      target = nextTarget;
      const updated = target ? renderedMatch(target, find) : undefined;
      replaceFindHighlight(range, updated);
      range = updated;
      revealWhenLaidOut();
    });
    observer.observe(row, { subtree: true, childList: true, characterData: true });
    return () => {
      cancelRetry();
      observer.disconnect();
      replaceFindHighlight(range, undefined);
    };
  }, [cancelRestore, savePosition]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const targetIsMessage = event.target instanceof HTMLElement && event.target.matches("[data-chat-message]");
    if ((event.target !== event.currentTarget && !targetIsMessage) ||
        isComposingKey(event.nativeEvent) || event.metaKey || event.ctrlKey || event.altKey) return;
    const feed = event.currentTarget;
    const page = Math.max(1, feed.clientHeight - 36);
    let target: number;
    switch (event.key) {
      case "Home": target = 0; break;
      case "End": event.preventDefault(); jumpToLatest(); return;
      case "PageUp": target = feed.scrollTop - page; break;
      case "PageDown":
        target = feed.scrollTop + page;
        downwardScrollUntil.current = performance.now() + scrollInputWindow;
        break;
      default: return;
    }
    event.preventDefault();
    cancelFindReveal.current?.();
    feed.scrollTop = target;
    onScroll();
  }, [jumpToLatest, onScroll]);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    const transcript = transcriptRef.current;
    if (!feed || !transcript) return;
    const saved = persistPosition ? getChatReadingPosition(threadId) : undefined;
    pendingRestore.current = undefined;
    downwardScrollUntil.current = 0;
    const restore = (position: ScrollPosition) => {
      if (!restorePosition(feed, position)) {
        pendingRestore.current = position;
        lastTop.current = feed.scrollTop;
        lastGap.current = distanceFromTail(feed);
        markdownObserver.observe(transcript, { childList: true, subtree: true });
        return;
      }
      pendingRestore.current = undefined;
      markdownObserver.disconnect();
      lastTop.current = feed.scrollTop;
      lastGap.current = distanceFromTail(feed);
      // Reflow refines the pixel fallback while the saved line anchor stays valid.
      position.top = feed.scrollTop;
      setRestoredThread(threadId);
    };
    const markdownObserver = new MutationObserver(() => {
      const position = pendingRestore.current;
      if (position && feed.clientHeight) restore(position);
      else if (!position) markdownObserver.disconnect();
    });
    following.current = !saved;
    layout.current = { width: transcript.clientWidth, hidden: !feed.clientHeight };
    setHistoryVisible(!layout.current.hidden);
    if (!layout.current.hidden) {
      if (!following.current && saved) restore(saved);
      else {
        feed.scrollTop = feed.scrollHeight;
        // Following the latest reply has no saved anchor to release after layout.
        setRestoredThread(undefined);
      }
    } else setRestoredThread(undefined);
    lastTop.current = feed.scrollTop;
    lastGap.current = distanceFromTail(feed);
    setFollowingLatest(following.current);
    const updateOverflow = () => setCanScroll(feed.scrollHeight - feed.clientHeight > tailTolerance);
    updateOverflow();
    const observer = new ResizeObserver(() => {
      if (!feed.clientHeight) {
        if (!layout.current.hidden) {
          setHistoryVisible(false);
          // Keep the reading page available while the compact split pane is hidden.
          if (!following.current) setRestoredThread(undefined);
        }
        layout.current.hidden = true;
        return;
      }
      const width = transcript.clientWidth;
      const wasHidden = layout.current.hidden;
      const reflowed = wasHidden || width !== layout.current.width;
      layout.current = { width, hidden: false };
      if (wasHidden) setHistoryVisible(true);
      updateOverflow();
      if (!following.current) {
        const position = pendingRestore.current ?? (reflowed && persistPosition && getChatReadingPosition(threadId));
        if (position) {
          restore(position);
          return;
        }
        if (wasHidden) setRestoredThread(threadId);
        // Reflow can clamp the viewport to the tail while the reader is paused.
        if (feed.scrollTop !== lastTop.current) savePosition(feed);
        else lastGap.current = distanceFromTail(feed);
        return;
      }
      // Honor upward movement that landed in the same frame as a new chunk.
      if (!reflowed && feed.scrollTop < lastTop.current && !atLatest(feed)) {
        onScroll();
        return;
      }
      keepFollowingTail();
    });
    observer.observe(feed);
    observer.observe(transcript);
    const onSelection = () => {
      if (following.current && chatSelectionIntersects(feed)) pauseFollowing(feed);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      cancelFindReveal.current?.();
      downwardScrollUntil.current = event.deltaY > 0 ? performance.now() + scrollInputWindow : 0;
    };
    const onPointerDown = () => cancelFindReveal.current?.();
    feed.addEventListener("wheel", onWheel, { passive: true });
    feed.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      observer.disconnect();
      markdownObserver.disconnect();
      feed.removeEventListener("wheel", onWheel);
      feed.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [keepFollowingTail, onScroll, pauseFollowing, persistPosition, savePosition, threadId]);

  useLayoutEffect(() => {
    if (!paneFocused || !layout.current.hidden) return;
    const feed = feedRef.current;
    if (!feed?.clientHeight) return;
    if (following.current) {
      feed.scrollTop = feed.scrollHeight;
      return;
    }
    const position = pendingRestore.current ?? (persistPosition ? getChatReadingPosition(threadId) : undefined);
    // Reposition for the first frame. The resize observer finishes restoration
    // after layout, keeping the saved page mounted until the viewport is measured.
    if (position) restorePosition(feed, position);
  }, [paneFocused, persistPosition, threadId]);

  useLayoutEffect(() => {
    if (!persistPosition) return;
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushChatReadingPositions();
    };
    window.addEventListener("pagehide", flushChatReadingPositions);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushChatReadingPositions);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      flushChatReadingPositions();
    };
  }, [persistPosition]);

  return { feedRef, transcriptRef, historyVisible, followingLatest, showScrollButton: canScroll && !followingLatest,
    restoreAnchorId: restoreAnchor?.id, restoreReasoningId: restoreAnchor?.line?.section === "reasoning" ? restoreAnchor.id : undefined,
    jumpToLatest, keepFollowingTail, revealMessage, onScroll, onFocus, onKeyDown };
}
