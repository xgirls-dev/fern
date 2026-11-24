import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextMessage } from "../lib/textThreads";
import type { ThreadSearchCancel, ThreadSearchRequest, ThreadSearchResponse } from "../lib/threadSearch.worker";

type ThreadSearchSource = { id: string; messages?: readonly TextMessage[] };
type SearchInput = { threads: readonly ThreadSearchSource[]; query: string };
type SearchResult = { input: SearchInput; matches?: Map<string, string> };

export function useThreadSearch(threads: readonly ThreadSearchSource[], query: string) {
  const [result, setResult] = useState<SearchResult>();
  const worker = useRef<Worker | undefined>(undefined);
  const indexed = useRef(new Map<string, readonly TextMessage[]>());
  const requestId = useRef(0);
  const pending = useRef<{ id: number; input: SearchInput } | undefined>(undefined);
  const inFlight = useRef<{ id: number; cancelRequested: boolean } | undefined>(undefined);
  const input = useMemo(() => query ? { threads, query } : undefined, [threads, query]);

  useEffect(() => () => {
    worker.current?.terminate();
    worker.current = undefined;
    indexed.current.clear();
    pending.current = undefined;
    inFlight.current = undefined;
  }, []);

  const sendLatest = useCallback(function sendLatest() {
    const latest = pending.current;
    const fail = () => {
      worker.current?.terminate();
      worker.current = undefined;
      indexed.current.clear();
      inFlight.current = undefined;
      const request = pending.current;
      pending.current = undefined;
      if (request) setResult({ input: request.input });
    };
    try {
      const active = inFlight.current;
      if (active) {
        if (latest?.id !== active.id && !active.cancelRequested) {
          active.cancelRequested = true;
          worker.current?.postMessage({ cancel: active.id } satisfies ThreadSearchCancel);
        }
        return;
      }
      if (!latest) return;
      const { id, input } = latest;
      if (!worker.current) {
        const background = new Worker(new URL("../lib/threadSearch.worker.ts", import.meta.url), { type: "module" });
        worker.current = background;
        background.onmessage = ({ data }: MessageEvent<ThreadSearchResponse>) => {
          if (worker.current !== background || data.id !== inFlight.current?.id) return;
          inFlight.current = undefined;
          if (data.cancelled) {
            sendLatest();
            return;
          }
          if (!data.matches) {
            fail();
            return;
          }
          const request = pending.current;
          if (request?.id === data.id) {
            pending.current = undefined;
            setResult({ input: request.input, matches: new Map(data.matches) });
          } else {
            sendLatest();
          }
        };
        const onError = () => {
          if (worker.current === background) fail();
        };
        background.onerror = onError;
        background.onmessageerror = onError;
      }
      const next = new Map<string, readonly TextMessage[]>();
      const updated: ThreadSearchRequest["updated"] = [];
      for (const thread of input.threads) {
        if (!thread.messages?.length) continue;
        next.set(thread.id, thread.messages);
        if (indexed.current.get(thread.id) !== thread.messages) updated.push({ id: thread.id, messages: thread.messages });
      }
      const removed = [...indexed.current.keys()].filter((threadId) => !next.has(threadId));
      // Send changed histories once, then send only the query as the user types.
      inFlight.current = { id, cancelRequested: false };
      worker.current.postMessage({ id, query: input.query, updated, removed } satisfies ThreadSearchRequest);
      indexed.current = next;
    } catch {
      fail();
    }
  }, []);

  useEffect(() => {
    // Drop intermediate queries and interrupt the active scan when it becomes stale.
    pending.current = input ? { id: ++requestId.current, input } : undefined;
    sendLatest();
  }, [input, sendLatest]);

  const matches = input && result?.input === input ? result.matches : undefined;
  return { matches, loading: !!input && result?.input !== input, failed: !!input && result?.input === input && !matches };
}
