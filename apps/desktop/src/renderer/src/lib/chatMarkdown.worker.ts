import { canReuseChatMarkdownPrefix, parsePreparedChatMarkdown, prepareChatMarkdown, type ChatMarkdownRequest, type ChatMarkdownResponse } from "./chatMarkdown";

type BlockPrefix = { source: string; blockCount: number };
type TablePrefix = BlockPrefix & { header: string; rowCount: number };
const prefixes = new Map<string, { requestId: number; blocks?: BlockPrefix; table?: TablePrefix }>();
const PREFIX_LIMIT = 8;

// The live worker starts while the response still shows its loading row.
// Initialize the streaming parser before the first large reply reaches it.
if (self.name === "live") parsePreparedChatMarkdown("A **short** note.\n\n- One\n- Two", true, true);

function parseTableTail(source: string, table: TablePrefix, preview: boolean, streaming: boolean) {
  if (!source.startsWith(table.source)) return;
  const tail = source.slice(table.source.length);
  // A leading pipe can continue the known table. A blank line can close it.
  // Leave ambiguous continuations to the full parser.
  if (tail && !/^(?: {0,3}\||[ \t]*\r?\n)/.test(tail)) return;
  const parsed = parsePreparedChatMarkdown(table.header + tail, preview, streaming);
  const [first, ...following] = parsed.root.children;
  if (first?.type !== "element" || first.tagName !== "table") return;
  const body = first.children.find((node) => node.type === "element" && node.tagName === "tbody");
  const rewritten = parsed.openTable;
  const next = rewritten && !following.length ? {
    ...table,
    source: source.slice(0, table.source.length + rewritten.completedThrough - table.header.length),
    rowCount: table.rowCount + rewritten.rowCount,
  } : streaming && !following.length ? table : undefined;
  return {
    table: next,
    blocks: following.map((node) => ({ signature: JSON.stringify(node), node })),
    tableRows: { rowCount: table.rowCount, tail: body?.type === "element" ? body.children.slice(1) : [] },
    trimmedPreview: parsed.trimmedPreview,
  };
}

self.addEventListener("message", (event: MessageEvent<ChatMarkdownRequest>) => {
  const { id, content, streaming, view, previousId, seedPrefix } = event.data;
  let response: ChatMarkdownResponse;
  try {
    const { source, preview } = prepareChatMarkdown(content, streaming);
    const independent = canReuseChatMarkdownPrefix(source);
    const candidate = prefixes.get(view);
    // Only omit nodes from a reply the renderer has acknowledged.
    const acknowledged = independent && candidate?.requestId === previousId ? candidate : undefined;
    const prior = acknowledged?.blocks ?? (!acknowledged && independent ? seedPrefix : undefined);
    const prefix = prior && source.startsWith(prior.source) ? prior : undefined;
    const table = acknowledged?.table;
    const delta = table && parseTableTail(source, table, preview, streaming);
    let reusable = streaming ? prefix : undefined;
    let openTable: TablePrefix | undefined;
    let retained: BlockPrefix | undefined = prefix;
    let blocks: ChatMarkdownResponse["blocks"];
    let trimmedPreview: boolean;
    if (delta && table) {
      retained = table;
      openTable = delta.table;
      blocks = delta.blocks;
      trimmedPreview = delta.trimmedPreview;
    } else {
      const tailOffset = prefix?.source.length ?? 0;
      const parsed = parsePreparedChatMarkdown(source.slice(tailOffset), preview, independent && streaming);
      blocks = parsed.root.children.map((node) => ({ signature: JSON.stringify(node), node }));
      trimmedPreview = parsed.trimmedPreview;
      const retainedCount = prefix?.blockCount ?? 0;
      if (parsed.boundary) reusable = {
        source: source.slice(0, tailOffset + parsed.boundary.offset),
        blockCount: retainedCount + parsed.boundary.index,
      };
      if (parsed.openTable) openTable = {
        source: source.slice(0, tailOffset + parsed.openTable.completedThrough),
        blockCount: retainedCount + blocks.length - 1,
        header: parsed.openTable.header,
        rowCount: parsed.openTable.rowCount,
      };
    }
    prefixes.delete(view);
    if (streaming && (reusable || openTable)) prefixes.set(view, { requestId: id, blocks: reusable, table: openTable });
    const oldestView = prefixes.keys().next().value;
    if (prefixes.size > PREFIX_LIMIT && oldestView !== undefined) prefixes.delete(oldestView);
    response = {
      id, blocks,
      retained: retained ? { requestId: acknowledged?.requestId, blockCount: retained.blockCount } : undefined,
      tableRows: delta?.tableRows,
      stablePrefix: reusable && content.startsWith(reusable.source)
        ? { sourceLength: reusable.source.length, blockCount: reusable.blockCount } : undefined,
      // A retained prefix excludes the blocks that preview trimming can change.
      matchesFinal: streaming && source === content && !trimmedPreview ? true : undefined,
    };
  } catch {
    prefixes.delete(view);
    response = { id };
  }
  self.postMessage(response);
});
