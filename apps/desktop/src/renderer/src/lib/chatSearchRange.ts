import { segmentGraphemes } from "./text";

const blockTags = new Set(["blockquote", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul"]);

export function isChatSearchBlock(tagName: string) {
  return blockTags.has(tagName);
}

export function chatSearchPattern(query: string) {
  const literal = query.normalize().trim().split(/\s+/).map((part) => part.replace(/[\^$\\.*+?()[\]{}|]/g, "\\$&")).join("\\s+");
  return new RegExp(literal, "giu");
}

export function findChatSearchRange(text: string, pattern: RegExp, occurrence = 0) {
  const normalized = text.normalize();
  const hits = normalized.matchAll(pattern);
  for (let index = 0; index < occurrence; index += 1) hits.next();
  const match = hits.next().value;
  if (!match?.[0]) return;
  const start = match.index;
  const end = start + match[0].length;
  if (normalized === text) return { start, end };

  const graphemes = segmentGraphemes(text);
  function originalBoundary(offset: number, exclusiveEnd: boolean) {
    // Prefix lengths at grapheme boundaries stay ordered after normalization.
    const character = exclusiveEnd ? offset - 1 : offset;
    let low = 0;
    let high = text.length;
    let normalizedLow = 0;
    while (low < high) {
      const { index, segment } = graphemes.containing(Math.floor((low + high) / 2))!;
      const boundary = index + segment.length;
      const normalizedBoundary = normalizedLow + text.slice(low, boundary).normalize().length;
      if (normalizedBoundary <= character) {
        low = boundary;
        normalizedLow = normalizedBoundary;
      } else {
        high = index;
      }
    }
    const { index, segment } = graphemes.containing(low)!;
    if (segment === segment.normalize()) return index + offset - normalizedLow;
    // A remapped endpoint covers the full original character, including its combining marks.
    return exclusiveEnd ? index + segment.length : index;
  }
  return { start: originalBoundary(start, false), end: originalBoundary(end, true) };
}

export function chatSearchExcerpt(text: string | undefined, pattern: RegExp) {
  if (!text) return;
  const match = findChatSearchRange(text, pattern);
  if (!match) return;
  const start = Math.max(0, match.start - 45);
  const end = match.end + 75;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
