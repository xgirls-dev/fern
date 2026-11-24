import { chatSearchText } from "./chatSearch";
import { chatSearchExcerpt, chatSearchPattern } from "./chatSearchRange";
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

const index = new Map<string, ReturnType<typeof chatSearchText>>();

self.addEventListener("message", ({ data }: MessageEvent<ThreadSearchRequest>) => {
  const { id, query, updated, removed } = data;
  try {
    for (const threadId of removed) index.delete(threadId);
    for (const thread of updated) index.set(thread.id, chatSearchText(thread.messages));
    const matches: NonNullable<ThreadSearchResponse["matches"]> = [];
    const pattern = chatSearchPattern(query);
    for (const [threadId, fields] of index) {
      const field = fields.find((text) => text && text.normalize().search(pattern) !== -1);
      const excerpt = chatSearchExcerpt(field, pattern);
      if (excerpt) matches.push([threadId, excerpt]);
    }
    self.postMessage({ id, matches } satisfies ThreadSearchResponse);
  } catch {
    self.postMessage({ id } satisfies ThreadSearchResponse);
  }
});
