import { useEffect, useMemo, useState } from "react";
import type { TextMessage } from "../lib/textThreads";
import type { ThreadSearchCancel, ThreadSearchRequest, ThreadSearchResponse } from "../lib/threadSearch.worker";

type ThreadSearchSource = { id: string; messages?: readonly TextMessage[] };
type SearchInput = { threads: readonly ThreadSearchSource[]; query: string };
type SearchMatches = Map<string, string>;
type SearchResult = { input: SearchInput; matches?: SearchMatches };
type SearchRequest = { id: number; input: SearchInput; complete: (matches?: SearchMatches) => void };

const SEARCH_IDLE_MS = 60_000;

export function createThreadSearchSession() {
  let worker: Worker | undefined;
  let indexed = new Map<string, readonly TextMessage[]>();
  let requestId = 0;
  let pending: SearchRequest | undefined;
  let inFlight: { id: number; cancelRequested: boolean } | undefined;
  let idle: number | undefined;

  function clear() {
    window.clearTimeout(idle);
    worker?.terminate();
    worker = undefined;
    indexed.clear();
    pending = undefined;
    inFlight = undefined;
  }

  function fail() {
    const request = pending;
    clear();
    request?.complete();
  }

  function sendLatest() {
    const latest = pending;
    try {
      if (!latest && worker) {
        window.clearTimeout(idle);
        idle = window.setTimeout(clear, SEARCH_IDLE_MS);
      }
      if (inFlight) {
        if (latest?.id !== inFlight.id && !inFlight.cancelRequested) {
          inFlight.cancelRequested = true;
          worker?.postMessage({ cancel: inFlight.id } satisfies ThreadSearchCancel);
        }
        return;
      }
      if (!latest) return;
      const { id, input } = latest;
      if (!worker) {
        const background = new Worker(new URL("../lib/threadSearch.worker.ts", import.meta.url), { type: "module" });
        worker = background;
        background.onmessage = ({ data }: MessageEvent<ThreadSearchResponse>) => {
          if (worker !== background || data.id !== inFlight?.id) return;
          inFlight = undefined;
          if (!data.cancelled && !data.matches) {
            fail();
            return;
          }
          const request = pending;
          if (request?.id === data.id) {
            pending = undefined;
            if (data.matches) request.complete(new Map(data.matches));
          }
          sendLatest();
        };
        const onError = () => {
          if (worker === background) fail();
        };
        background.onerror = onError;
        background.onmessageerror = onError;
      }
      const next = new Map<string, readonly TextMessage[]>();
      const updated: ThreadSearchRequest["updated"] = [];
      for (const thread of input.threads) {
        if (!thread.messages?.length) continue;
        next.set(thread.id, thread.messages);
        if (indexed.get(thread.id) !== thread.messages) updated.push({ id: thread.id, messages: thread.messages });
      }
      const removed = [...indexed.keys()].filter((threadId) => !next.has(threadId));
      // Apply history changes before searching, including after the dialog was closed.
      inFlight = { id, cancelRequested: false };
      worker.postMessage({ id, query: input.query, updated, removed } satisfies ThreadSearchRequest);
      indexed = next;
    } catch {
      fail();
    }
  }

  return {
    clear,
    search(input: SearchInput, complete: SearchRequest["complete"]) {
      window.clearTimeout(idle);
      const id = ++requestId;
      pending = { id, input, complete };
      sendLatest();
      return () => {
        if (pending?.id !== id) return;
        pending = undefined;
        sendLatest();
      };
    },
  };
}

export type ThreadSearchSession = ReturnType<typeof createThreadSearchSession>;

export function useThreadSearch(session: ThreadSearchSession | undefined, threads: readonly ThreadSearchSource[], query: string) {
  const [result, setResult] = useState<SearchResult>();
  const input = useMemo(() => session && query ? { threads, query } : undefined, [session, threads, query]);

  useEffect(() => {
    if (!session || !input) return;
    return session.search(input, (matches) => setResult({ input, matches }));
  }, [session, input]);

  const matches = input && result?.input === input ? result.matches : undefined;
  return { matches, loading: !!input && result?.input !== input, failed: !!input && result?.input === input && !matches };
}
