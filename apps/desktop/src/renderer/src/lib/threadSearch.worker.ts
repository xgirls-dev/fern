import { chatSearchEntries, threadSearchMatcher } from "./chatSearch";
import type { TextMessage, TextVersion } from "./textThreads";

export type ThreadSearchSource = { id: string; messages?: readonly TextMessage[]; versions?: readonly TextVersion[] };
export type ThreadSearchMatch = { excerpt: string; snapshotId?: string };

export interface ThreadSearchRequest {
  id: number;
  query: string;
  updated: Array<{ id: string; messages?: readonly TextMessage[] | null; versions?: readonly TextVersion[] | null }>;
  removed: string[];
  measure?: true;
}

export interface ThreadSearchResponse {
  id: number;
  matches?: Array<[threadId: string, match: ThreadSearchMatch]>;
  cancelled?: true;
  timing?: ThreadSearchWorkerTiming;
}

type ThreadSearchWorkerTiming = {
  receivedAt: number;
  finishedAt: number;
  indexMs: number;
  scanMs: number;
  markdownMs: number;
  markdownFields: number;
};

export interface ThreadSearchCancel {
  cancel: number;
}

type SearchTranscript = { entries: ReturnType<typeof chatSearchEntries>; snapshotId?: string };
const index = new Map<string, { current: SearchTranscript[]; saved: SearchTranscript[] }>();
const work = new MessageChannel();
const sliceMs = 8;
let nextStepScheduled = false;
type SearchTask = {
  id: number;
  matches: NonNullable<ThreadSearchResponse["matches"]>;
  scan: Generator<void>;
  timing?: ThreadSearchWorkerTiming;
};
let active: SearchTask | undefined;

function* scanHistory(query: string, matches: SearchTask["matches"], recordParse?: (elapsed: number) => void) {
  const match = threadSearchMatcher(query, recordParse);
  for (const [threadId, transcripts] of index) {
    // Prefer the current conversation when the same content exists in an earlier snapshot.
    const groups = transcripts.saved.length ? [...transcripts.current, ...transcripts.saved] : transcripts.current;
    searchThread: for (const { entries, snapshotId } of groups) {
      for (let start = 0; start < entries.length; start += 16) {
        const excerpt = match(entries.slice(start, start + 16));
        if (excerpt) {
          matches.push([threadId, { excerpt, snapshotId }]);
          yield;
          break searchThread;
        }
        yield;
      }
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
        const timing = task.timing;
        if (timing) {
          timing.finishedAt = performance.timeOrigin + performance.now();
          timing.scanMs = Math.max(0, timing.finishedAt - timing.receivedAt - timing.indexMs);
        }
        self.postMessage({ id: task.id, matches: task.matches, timing } satisfies ThreadSearchResponse);
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
  const { id, query, updated, removed, measure } = data;
  const started = measure ? performance.now() : 0;
  try {
    for (const threadId of removed) index.delete(threadId);
    for (const { id: threadId, messages, versions } of updated) {
      const previous = index.get(threadId);
      const current = messages === undefined ? previous?.current ?? []
        : messages?.length ? [{ entries: chatSearchEntries(messages) }] : [];
      const saved = versions === undefined ? previous?.saved ?? []
        : (versions ?? []).flatMap(({ id: snapshotId, messages: savedMessages }) =>
          savedMessages.length ? [{ snapshotId, entries: chatSearchEntries(savedMessages) }] : []);
      index.set(threadId, { current, saved });
    }
    const timing = measure ? {
      receivedAt: performance.timeOrigin + started,
      finishedAt: 0, indexMs: performance.now() - started, scanMs: 0, markdownMs: 0, markdownFields: 0,
    } : undefined;
    const recordParse = timing ? (elapsed: number) => {
      timing.markdownMs += elapsed;
      timing.markdownFields += 1;
    } : undefined;
    const matches: SearchTask["matches"] = [];
    active = { id, matches, scan: scanHistory(query, matches, recordParse), timing };
    scheduleStep();
  } catch {
    self.postMessage({ id } satisfies ThreadSearchResponse);
  }
});
