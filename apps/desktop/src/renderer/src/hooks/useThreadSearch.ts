import { useEffect, useMemo, useRef, useState } from "react";
import type { TextMessage } from "../lib/textThreads";
import type { ThreadSearchRequest, ThreadSearchResponse } from "../lib/threadSearch.worker";

type ThreadSearchSource = { id: string; messages?: readonly TextMessage[] };
type SearchInput = { threads: readonly ThreadSearchSource[]; query: string };
type SearchResult = { input: SearchInput; matches?: Map<string, string> };

export function useThreadSearch(threads: readonly ThreadSearchSource[], query: string) {
  const [result, setResult] = useState<SearchResult>();
  const worker = useRef<Worker | undefined>(undefined);
  const indexed = useRef(new Map<string, readonly TextMessage[]>());
  const requestId = useRef(0);
  const pending = useRef<{ id: number; input: SearchInput } | undefined>(undefined);
  const input = useMemo(() => query ? { threads, query } : undefined, [threads, query]);

  useEffect(() => () => {
    worker.current?.terminate();
    worker.current = undefined;
    indexed.current.clear();
    pending.current = undefined;
  }, []);

  useEffect(() => {
    if (!input) {
      pending.current = undefined;
      return;
    }
    const id = ++requestId.current;
    pending.current = { id, input };
    const fail = () => {
      worker.current?.terminate();
      worker.current = undefined;
      indexed.current.clear();
      const request = pending.current;
      pending.current = undefined;
      if (request) setResult({ input: request.input });
    };
    try {
      if (!worker.current) {
        const background = new Worker(new URL("../lib/threadSearch.worker.ts", import.meta.url), { type: "module" });
        worker.current = background;
        background.onmessage = ({ data }: MessageEvent<ThreadSearchResponse>) => {
          if (!data.matches) {
            fail();
            return;
          }
          const request = pending.current;
          if (request?.id !== data.id) return;
          pending.current = undefined;
          setResult({ input: request.input, matches: new Map(data.matches) });
        };
        background.onerror = fail;
        background.onmessageerror = fail;
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
      worker.current.postMessage({ id, query: input.query, updated, removed } satisfies ThreadSearchRequest);
      indexed.current = next;
    } catch {
      fail();
    }
  }, [input]);

  const matches = input && result?.input === input ? result.matches : undefined;
  return { matches, loading: !!input && result?.input !== input, failed: !!input && result?.input === input && !matches };
}
