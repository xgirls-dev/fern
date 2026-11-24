import { chatSearchEntries, threadSearchMatcher } from "./chatSearch";
import type { TextMessage } from "./textThreads";

export interface ThreadSearchRequest {
  id: number;
  query: string;
  updated: Array<{ id: string; messages: readonly TextMessage[] }>;
  removed: string[];
}

export interface ThreadSearchResponse {
  id: number;
  matches?: Array<[threadId: string, excerpt: string]>;
}

const index = new Map<string, ReturnType<typeof chatSearchEntries>>();

self.addEventListener("message", ({ data }: MessageEvent<ThreadSearchRequest>) => {
  const { id, query, updated, removed } = data;
  try {
    for (const threadId of removed) index.delete(threadId);
    for (const thread of updated) index.set(thread.id, chatSearchEntries(thread.messages));
    const matches: NonNullable<ThreadSearchResponse["matches"]> = [];
    const match = threadSearchMatcher(query);
    for (const [threadId, entries] of index) {
      const excerpt = match(entries);
      if (excerpt) matches.push([threadId, excerpt]);
    }
    self.postMessage({ id, matches } satisfies ThreadSearchResponse);
  } catch {
    self.postMessage({ id } satisfies ThreadSearchResponse);
  }
});
