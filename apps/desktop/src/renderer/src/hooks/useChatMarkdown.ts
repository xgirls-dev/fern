import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RootContent } from "hast";
import { appendChatMarkdownTableRows, canReuseChatMarkdownPrefix, parseChatMarkdown, parsePlainChatMarkdown, type ChatMarkdownRequest, type ChatMarkdownResponse } from "../lib/chatMarkdown";

const WORKER_THRESHOLD = 2_000;
const SYNC_PROSE_LIMIT = 16_000;
const FINAL_TAIL_LIMIT = 1_024;
const SETTLED_MARKDOWN_CACHE_SIZE = 96;
type MarkdownQueue = "live" | "history";
const workers = new Map<MarkdownQueue, Worker>();
let requestId = 0;
const responses = new Map<number, { queue: MarkdownQueue; receive: (response: ChatMarkdownResponse) => void }>();

function markdownWorker(queue: MarkdownQueue) {
  const worker = workers.get(queue);
  if (worker) return worker;
  const next = new Worker(new URL("../lib/chatMarkdown.worker.ts", import.meta.url), { type: "module" });
  next.onmessage = ({ data }: MessageEvent<ChatMarkdownResponse>) => {
    const pending = responses.get(data.id);
    if (pending?.queue !== queue) return;
    responses.delete(data.id);
    pending.receive(data);
  };
  const reset = () => {
    next.terminate();
    if (workers.get(queue) !== next) return;
    workers.delete(queue);
    for (const [id, pending] of responses) {
      if (pending.queue !== queue) continue;
      responses.delete(id);
      pending.receive({ id });
    }
  };
  next.onerror = reset;
  next.onmessageerror = reset;
  workers.set(queue, next);
  return next;
}

function requestMarkdown(queue: MarkdownQueue, input: Omit<ChatMarkdownRequest, "id">, receive: (response: ChatMarkdownResponse) => void) {
  const id = ++requestId;
  responses.set(id, { queue, receive });
  try {
    markdownWorker(queue).postMessage({ id, ...input });
  } catch {
    queueMicrotask(() => {
      const failed = responses.get(id);
      responses.delete(id);
      failed?.receive({ id });
    });
  }
  return () => { responses.delete(id); };
}

type MarkdownInput = Omit<ChatMarkdownRequest, "id"> & { queue: MarkdownQueue };
type ParsedMarkdown = {
  content: string;
  nodes: RootContent[];
};
const settledMarkdown = new Map<string, ParsedMarkdown>();

function parseSmallReply(content: string, streaming: boolean, receivingReply: boolean): ParsedMarkdown {
  // Virtualized rows and switched chats can remount with the same saved reply.
  // Keep only small, settled parses so live snapshots never crowd them out.
  const cacheable = !receivingReply && !streaming && !!content && content.length < WORKER_THRESHOLD;
  const parsed = (cacheable ? settledMarkdown.get(content) : undefined) ?? {
    content,
    nodes: parseChatMarkdown(content, streaming).children,
  };
  if (cacheable) {
    settledMarkdown.delete(content);
    settledMarkdown.set(content, parsed);
    if (settledMarkdown.size > SETTLED_MARKDOWN_CACHE_SIZE) {
      const oldest = settledMarkdown.keys().next().value;
      if (oldest !== undefined) settledMarkdown.delete(oldest);
    }
  }
  return parsed;
}

type ParsedWorkerMarkdown = ParsedMarkdown & {
  requestId: number;
  streaming: boolean;
  signatures: (string | undefined)[];
  stablePrefix?: ChatMarkdownResponse["stablePrefix"];
  matchesFinal?: ChatMarkdownResponse["matchesFinal"];
};

function fitsContent(parsed: ParsedMarkdown | null, content: string) {
  return parsed && (content.startsWith(parsed.content) || content.trimEnd() === parsed.content.trimEnd());
}

function finishParsedReply(previous: ParsedWorkerMarkdown | null, content: string): RootContent[] | null {
  if (previous?.matchesFinal && previous.content === content) return previous.nodes;
  const prefix = previous?.stablePrefix;
  if (!prefix || !previous || content.length - prefix.sourceLength > FINAL_TAIL_LIMIT ||
      !content.startsWith(previous.content.slice(0, prefix.sourceLength)) || !canReuseChatMarkdownPrefix(content)) return null;
  const tail = content.slice(prefix.sourceLength);
  if (!tail.trim()) return null;
  // The worker verified this split point. Limit synchronous work to the final tail.
  return [...previous.nodes.slice(0, prefix.blockCount), ...parseChatMarkdown(tail, false).children];
}

export function useChatMarkdown(content: string, streaming: boolean, receivingReply = streaming): RootContent[] | null {
  const view = useId();
  const [workerFailed, setWorkerFailed] = useState(false);
  const [largeResult, setLargeResult] = useState<ParsedWorkerMarkdown | null>(null);
  const latestWorkerResult = useRef<ParsedWorkerMarkdown | null>(null);
  const latestSmall = useRef<ParsedMarkdown | null>(null);
  const inFlight = useRef<{ queue: MarkdownQueue; cancel: () => void } | null>(null);
  const waiting = useRef<MarkdownInput | null>(null);
  const wasReceivingReply = useRef(receivingReply);
  const workerCandidate = !workerFailed && content.length >= WORKER_THRESHOLD;
  const plainResult = useMemo<ParsedMarkdown | null>(() => {
    if (!workerCandidate || content.length > SYNC_PROSE_LIMIT) return null;
    const root = parsePlainChatMarkdown(content);
    return root && { content, nodes: root.children };
  }, [content, workerCandidate]);
  const shouldOffload = workerCandidate && !plainResult;
  const smallResult = useMemo(() => shouldOffload ? null : plainResult ?? parseSmallReply(content, streaming, receivingReply),
    [content, plainResult, receivingReply, shouldOffload, streaming]);
  const finalNodes = useMemo(() => shouldOffload && !streaming ? finishParsedReply(largeResult, content) : null,
    [content, largeResult, shouldOffload, streaming]);
  const needsWorker = shouldOffload && !finalNodes && (largeResult?.content !== content || largeResult.streaming !== streaming);

  useLayoutEffect(() => {
    if (smallResult) latestSmall.current = smallResult;
  }, [smallResult]);

  useEffect(() => () => {
    inFlight.current?.cancel();
    inFlight.current = null;
    waiting.current = null;
  }, []);

  useEffect(() => {
    if (!receivingReply || workerFailed) return;
    // Start loading the parser while the reply is still being prepared.
    try {
      markdownWorker("live");
    } catch {
      // The first large parse can retry startup and fall back if it still fails.
    }
  }, [receivingReply, workerFailed]);

  useEffect(() => {
    // Keep the final parse beside its streamed prefix. Reading a saved reply
    // has a separate queue, even when the same row is reused for regeneration.
    const queue = streaming || (!receivingReply && wasReceivingReply.current) ? "live" : "history";
    wasReceivingReply.current = receivingReply;
    waiting.current = needsWorker ? { content, streaming, view, queue } : null;
    if (inFlight.current && inFlight.current.queue !== queue) {
      inFlight.current.cancel();
      inFlight.current = null;
    }
    if (!needsWorker) return;

    function drain() {
      const next = waiting.current;
      if (!next || inFlight.current) return;
      waiting.current = null;
      const { queue, ...input } = next;
      const previous = latestWorkerResult.current;
      const cancel = requestMarkdown(queue, { ...input, previousId: previous?.requestId }, ({ id, blocks, retained, tableRows, stablePrefix, matchesFinal }) => {
        inFlight.current = null;
        const count = retained?.blockCount ?? 0;
        if (!blocks || (retained && (!previous || previous.requestId !== retained.requestId || count > previous.nodes.length))) {
          setWorkerFailed(true);
          return;
        }
        const nodes = previous?.nodes.slice(0, count) ?? [];
        const signatures = previous?.signatures.slice(0, count) ?? [];
        if (tableRows) {
          const table = appendChatMarkdownTableRows(previous?.nodes[count], tableRows);
          if (!table) {
            setWorkerFailed(true);
            return;
          }
          nodes.push(table);
          signatures.push(undefined);
        }
        for (const [index, { node, signature }] of blocks.entries()) {
          const position = count + Number(!!tableRows) + index;
          nodes.push(previous?.signatures[position] === signature ? previous.nodes[position] : node);
          signatures.push(signature);
        }
        const parsed = {
          requestId: id,
          content: input.content,
          streaming: input.streaming,
          nodes,
          signatures,
          stablePrefix,
          matchesFinal,
        };
        latestWorkerResult.current = parsed;
        setLargeResult(parsed);
        drain();
      });
      inFlight.current = { queue, cancel };
    }
    drain();
  }, [content, needsWorker, receivingReply, streaming, view]);

  if (smallResult) return smallResult.nodes;
  if (finalNodes) return finalNodes;
  if (fitsContent(largeResult, content)) return largeResult!.nodes;
  if (fitsContent(latestSmall.current, content)) return latestSmall.current!.nodes;
  return null;
}
