export type PaletteThread = {
  id: string;
  title: string;
  updatedAt: number;
  archived?: boolean;
  excerpt?: string;
  folderPath?: string;
};

export function normalizeCommandSearch(value: string) {
  return value.normalize().toLowerCase().trim().replace(/\s+/g, " ");
}

export function commandSearchRank(needle: string, words: string[], title: string, details: string) {
  if (title === needle) return 4;
  if (title.startsWith(needle)) return 3;
  if (title.includes(needle) || words.every((word) => title.includes(word))) return 2;
  return words.every((word) => title.includes(word) || details.includes(word)) ? 1 : 0;
}

export function indexPaletteThreads(threads: readonly PaletteThread[]) {
  const visible = threads.filter((thread) => !thread.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  const titles = new Map<string, number>();
  const summaries = new Map<string, number>();
  const entries = visible.map((thread) => {
    const excerpt = thread.excerpt?.trim().replace(/\s+/g, " ").slice(0, 90);
    const title = normalizeCommandSearch(thread.title);
    const path = normalizeCommandSearch(thread.folderPath ?? "");
    const body = normalizeCommandSearch(thread.excerpt ?? "");
    const summaryKey = JSON.stringify([thread.title, thread.folderPath ?? "", excerpt ?? "", Math.floor(thread.updatedAt / 60_000)]);
    titles.set(thread.title, (titles.get(thread.title) ?? 0) + 1);
    summaries.set(summaryKey, (summaries.get(summaryKey) ?? 0) + 1);
    return { thread, title, details: `${path} ${body}`, body, excerpt, summaryKey };
  });
  return { entries, titles, summaries };
}

export function searchPaletteThreads(entries: ReturnType<typeof indexPaletteThreads>["entries"], needle: string, words: string[], limit: number) {
  const ranks: Array<Array<(typeof entries)[number]>> = [[], [], [], [], []];
  for (const entry of entries) {
    const rank = commandSearchRank(needle, words, entry.title, entry.details);
    if (rank && ranks[rank].length < limit) ranks[rank].push(entry);
    if (ranks[4].length === limit) break;
  }
  ranks.reverse();
  const firstMatch = ranks.findIndex((group) => group.length > 0);
  return { entries: ranks.flat().slice(0, limit), bestRank: firstMatch < 0 ? 0 : 4 - firstMatch };
}
