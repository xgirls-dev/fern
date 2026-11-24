import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ImageThread } from "../lib/threads";
import { chatSearchExcerpt, chatSearchPattern } from "../lib/chatSearchRange";
import { useThreadSearch, type ThreadSearchSession } from "../hooks/useThreadSearch";
import { isComposingKey } from "../lib/keyboard";
import type { TextMessage, TextVersion } from "../lib/textThreads";
import { Dialog, DialogTitle } from "./ui/Dialog";
import { SearchDialogField } from "./ui/SearchDialogField";
import { Button, Checkbox, SegmentedControl } from "./ui/controls";

const SavedConversationPreview = lazy(() => import("./SavedConversationPreview")
  .then(({ SavedConversationPreview }) => ({ default: SavedConversationPreview })));

const PAGE_SIZE = 60;
const THREAD_TYPES = ["All", "Chat", "Image", "Speech"] as const;
type ThreadKind = Exclude<typeof THREAD_TYPES[number], "All">;
export type ThreadBrowserScope = { kind: ThreadKind; currentId: string };
const threadNouns = { Chat: "chat", Image: "image thread", Speech: "audio thread" };

function threadKind(id: string): ThreadKind {
  return id.startsWith("audio-thread-") ? "Speech" : id.startsWith("text-thread-") ? "Chat" : "Image";
}

export function ThreadBrowser({
  threads,
  searchSession,
  initialQuery,
  onOpen,
  onClose,
  onNewChat,
  scope,
}: {
  threads: Array<Pick<ImageThread, "id" | "title" | "archived"> & { excerpt?: string; folderPath?: string; messages?: TextMessage[]; versions?: TextVersion[] }>;
  searchSession?: ThreadSearchSession;
  initialQuery: string;
  onOpen: (id: string, messageQuery?: string) => void;
  onClose: () => void;
  onNewChat?: () => void;
  scope?: ThreadBrowserScope;
}) {
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const showMore = useRef<HTMLButtonElement>(null);
  const backFromPreview = useRef<HTMLButtonElement>(null);
  const focusAfterLoad = useRef<number | undefined>(undefined);
  const focusDestination = useRef(false);
  const confirmAfterSearch = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<typeof THREAD_TYPES[number]>("All");
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [preview, setPreview] = useState<{ threadId: string; snapshotId: string; query: string }>();
  const previewThread = preview && threads.find(({ id }) => id === preview.threadId);
  const previewVersion = previewThread?.versions?.find(({ id }) => id === preview?.snapshotId);
  const closePreview = useCallback(() => setPreview(undefined), []);
  const wasPreviewOpen = useRef(false);
  const previewOpen = Boolean(previewVersion);
  useLayoutEffect(() => {
    if (previewOpen) backFromPreview.current?.focus({ preventScroll: true });
    else if (wasPreviewOpen.current) search.current?.focus({ preventScroll: true });
    wasPreviewOpen.current = previewOpen;
  }, [previewOpen]);
  const selectedKind = scope?.kind ?? kind;
  const noun = onNewChat ? "chat" : scope ? threadNouns[scope.kind] : "thread";
  const searchLabel = `Find ${scope && scope.kind !== "Chat" ? "an" : "a"} ${noun}`;
  const needle = query.trim();
  const pattern = chatSearchPattern(needle);
  const includesQuery = (value: string | undefined) => value !== undefined && value.normalize().search(pattern) !== -1;
  const canSearchMessages = Boolean(searchSession) && (selectedKind === "All" || selectedKind === "Chat") &&
    threads.some((thread) => thread.messages?.length || thread.versions?.length);
  const { matches, timing, loading, failed } = useThreadSearch(searchSession, threads, canSearchMessages ? needle : "");
  useEffect(() => {
    if (!searchSession || !canSearchMessages) return;
    // Load the search code in an idle interval. Chat history is sent only with a query.
    const callback = window.requestIdleCallback(searchSession.prepare);
    return () => window.cancelIdleCallback(callback);
  }, [canSearchMessages, searchSession]);
  const orderingStarted = timing ? performance.now() : 0;
  const filtered = threads.flatMap((thread) => {
    if (selectedKind !== "All" && threadKind(thread.id) !== selectedKind) return [];
    if (archivedOnly ? !thread.archived : scope && thread.archived && thread.id !== scope.currentId) return [];
    if (!needle) return [{ ...thread, messageQuery: undefined, snapshotId: undefined }];
    const inside = matches?.get(thread.id);
    const messageQuery = inside ? needle : undefined;
    const snapshotId = inside?.snapshotId;
    const excerpt = inside?.excerpt ?? chatSearchExcerpt(thread.excerpt, pattern);
    if (excerpt) return [{ ...thread, messageQuery, snapshotId, excerpt }];
    return includesQuery(thread.title) || includesQuery(thread.folderPath) ? [{ ...thread, messageQuery, snapshotId }] : [];
  });
  const orderedAt = timing ? performance.now() : 0;
  useLayoutEffect(() => {
    if (!timing) return;
    const committedAt = performance.now();
    performance.mark("fern:thread-search-finished", { detail: {
      ...timing, orderMs: orderedAt - orderingStarted, renderCommitMs: committedAt - orderedAt, committedAt,
    } });
  }, [timing, orderingStarted, orderedAt]);
  const hasFilters = Boolean(needle) || kind !== "All" || archivedOnly;
  const visibleCount = Math.min(filtered.length, limit);
  const focusResult = useCallback((index: number) => {
    const target = index < 0 ? search.current : results.current?.querySelectorAll<HTMLButtonElement>(".thread-browser-open")[index];
    target?.focus();
  }, []);
  useLayoutEffect(() => {
    if (focusAfterLoad.current === undefined) return;
    const index = focusAfterLoad.current;
    focusAfterLoad.current = undefined;
    focusResult(index);
  }, [focusResult, limit]);
  const moveResultFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isComposingKey(event.nativeEvent)) return;
    let next: number;
    switch (event.key) {
      case "ArrowUp": next = index - 1; break;
      case "ArrowDown": next = index + 1; break;
      case "Home": next = 0; break;
      case "End": next = visibleCount - 1; break;
      default: return;
    }
    event.preventDefault();
    if (next >= visibleCount) showMore.current?.focus();
    else focusResult(next);
  };
  const open = (thread: (typeof filtered)[number]) => {
    if (thread.snapshotId && thread.messageQuery) {
      setPreview({ threadId: thread.id, snapshotId: thread.snapshotId, query: thread.messageQuery });
      return;
    }
    focusDestination.current = Boolean(onNewChat || thread.messageQuery);
    onOpen(thread.id, thread.messageQuery);
    onClose();
  };
  useEffect(() => {
    if (loading || !confirmAfterSearch.current) return;
    confirmAfterSearch.current = false;
    if (filtered[0]) open(filtered[0]);
  }, [filtered, loading, open]);
  if (preview && previewThread && previewVersion) {
    return <Dialog className="saved-conversation-dialog" onClose={closePreview} initialFocus={backFromPreview} finalFocus={() => !focusDestination.current}>
      <div className="saved-conversation-heading">
        <div>
          <DialogTitle>Saved conversation</DialogTitle>
          <p>{previewThread.title} · {previewVersion.label}</p>
        </div>
        <Button ref={backFromPreview} variant="secondary" onClick={closePreview}>Back to search</Button>
      </div>
      <Suspense fallback={<p role="status">Opening saved conversation…</p>}>
        <SavedConversationPreview key={previewVersion.id} version={previewVersion}
          threadId={previewThread.id} initialQuery={preview.query} onClose={closePreview} />
      </Suspense>
    </Dialog>;
  }
  return (
    <Dialog variant="search" className="thread-browser" onClose={onClose} initialFocus={search} finalFocus={() => !focusDestination.current}>
      <DialogTitle className="sr-only">{onNewChat ? "Choose a chat" : `Search ${noun}s`}</DialogTitle>
      <SearchDialogField
          closeLabel={onNewChat ? "Close chat picker" : `Close ${noun} search`}
          ref={search}
          type="search"
          aria-label={searchLabel}
          placeholder={`Search ${noun}s…`}
          value={query}
          onChange={(event) => {
            confirmAfterSearch.current = false;
            setQuery(event.target.value);
            setLimit(PAGE_SIZE);
          }}
          onBlur={() => { confirmAfterSearch.current = false; }}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              if (loading) confirmAfterSearch.current = true;
              else if (filtered[0]) open(filtered[0]);
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && filtered.length &&
                !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
              event.preventDefault();
              focusResult(event.key === "ArrowDown" ? 0 : visibleCount - 1);
            }
          }}
      />
      {onNewChat ? <div className="thread-browser-filters">
        <Button variant="secondary" onClick={() => {
          focusDestination.current = true;
          onNewChat();
          onClose();
        }}>New chat in this pane</Button>
      </div> : <div className="thread-browser-filters">
        {!scope && <SegmentedControl label="Thread type" value={kind} options={THREAD_TYPES.map(value => ({ value, label: value }))} onChange={value => { setKind(value); setLimit(PAGE_SIZE); }} />}
        <label><Checkbox checked={archivedOnly} onChange={event => { setArchivedOnly(event.target.checked); setLimit(PAGE_SIZE); }} />Archived only</label>
      </div>}
      <div ref={results} className="thread-browser-list">
        {filtered.slice(0, limit).map((thread, index) => {
          const current = thread.id === scope?.currentId;
          const status = [scope ? undefined : threadKind(thread.id), current ? "Current" : undefined,
            thread.archived ? "Archived" : undefined, thread.snapshotId ? "Saved version" : undefined].filter(Boolean).join(" · ");
          return (
            <article key={thread.id}>
              <button type="button" className="thread-browser-open" title={thread.title} aria-current={current || undefined}
                onKeyDown={(event) => moveResultFocus(event, index)} onClick={() => open(thread)}>
                <span className="thread-browser-result"><strong>{thread.title}</strong>
                  {thread.folderPath && <span title={thread.folderPath}>{thread.folderPath}</span>}
                  {thread.excerpt?.trim() && thread.excerpt.trim() !== thread.title && <span>{thread.excerpt.trim()}</span>}
                </span>
                {status && <small>{status}</small>}
              </button>
            </article>
          );
        })}
        {filtered.length > limit && <Button ref={showMore} variant="secondary"
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" && !isComposingKey(event.nativeEvent)) { event.preventDefault(); focusResult(visibleCount - 1); }
          }}
          onClick={(event) => {
            if (event.detail === 0) focusAfterLoad.current = visibleCount;
            setLimit((value) => value + PAGE_SIZE);
          }}>Show more threads</Button>}
        {loading || failed ? <div className="thread-browser-empty" role="status">
          <p>{loading ? "Searching chat messages…" : "Chat messages couldn’t be searched."}</p>
        </div> : !filtered.length ? <div className="thread-browser-empty">
          <p role="status">{hasFilters ? `No matching ${noun}s` : onNewChat ? "No other chats" : `No ${noun}s yet`}</p>
          {hasFilters ? <><small>Try a different search or clear the filters.</small><Button variant="ghost" onClick={() => { setQuery(""); setKind("All"); setArchivedOnly(false); setLimit(PAGE_SIZE); search.current?.focus(); }}>Clear filters</Button></> : null}
        </div> : null}
      </div>
    </Dialog>
  );
}
