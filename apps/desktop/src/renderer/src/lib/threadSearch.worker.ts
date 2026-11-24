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
  cancelled?: true;
}

export interface ThreadSearchCancel {
  cancel: number;
}

const index = new Map<string, ReturnType<typeof chatSearchEntries>>();
const work = new MessageChannel();
const sliceMs = 8;
let nextStepScheduled = false;
let active: { id: number; matches: NonNullable<ThreadSearchResponse["matches"]>; scan: Generator<void> } | undefined;

function* scanHistory(query: string, matches: NonNullable<ThreadSearchResponse["matches"]>) {
  const match = threadSearchMatcher(query);
  for (const [threadId, entries] of index) {
    // A single long chat can also need to yield between groups of messages.
    for (let start = 0; start < entries.length; start += 16) {
      const excerpt = match(entries.slice(start, start + 16));
      if (excerpt) matches.push([threadId, excerpt]);
      yield;
      if (excerpt) break;
    }
  }
}

function scheduleStep() {
  if (nextStepScheduled) return;
  nextStepScheduled = true;
  // Let the worker receive cancellation messages between slices.
  work.port2.postMessage(null);
}

work.port1.onmessage = () => {
  nextStepScheduled = false;
  if (!active) return;
  const task = active;
  try {
    const deadline = performance.now() + sliceMs;
    do {
      if (task.scan.next().done) {
        active = undefined;
        self.postMessage({ id: task.id, matches: task.matches } satisfies ThreadSearchResponse);
        return;
      }
    } while (performance.now() < deadline);
    scheduleStep();
  } catch {
    active = undefined;
    self.postMessage({ id: task.id } satisfies ThreadSearchResponse);
  }
};

self.addEventListener("message", ({ data }: MessageEvent<ThreadSearchRequest | ThreadSearchCancel>) => {
  if ("cancel" in data) {
    if (active?.id === data.cancel) {
      active = undefined;
      self.postMessage({ id: data.cancel, cancelled: true } satisfies ThreadSearchResponse);
    }
    return;
  }
  const { id, query, updated, removed } = data;
  try {
    for (const threadId of removed) index.delete(threadId);
    for (const thread of updated) index.set(thread.id, chatSearchEntries(thread.messages));
    const matches: NonNullable<ThreadSearchResponse["matches"]> = [];
    active = { id, matches, scan: scanHistory(query, matches) };
    scheduleStep();
  } catch {
    self.postMessage({ id } satisfies ThreadSearchResponse);
  }
});
