export type ReadingSection = "answer" | "reasoning";
export type ReadingLine = { section: ReadingSection; path: number[]; character: number; fingerprint: number; offset: number };
export type ScrollPosition = { top: number; anchor?: { id: string; offset: number; line?: ReadingLine } };

const storageKey = "fern-chat-reading:v1";
const storedLimit = 256;

function isIndex(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function readPositions(): Map<string, ScrollPosition> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(saved)) return new Map();
    return new Map(saved.slice(-storedLimit).filter((entry): entry is [string, ScrollPosition] => {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1]) return false;
      const position: ScrollPosition = entry[1];
      if (!Number.isFinite(position.top) || position.top < 0) return false;
      if (position.anchor === undefined) return true;
      const anchor = position.anchor;
      if (!anchor || typeof anchor.id !== "string" || !Number.isFinite(anchor.offset)) return false;
      const line = anchor.line;
      return line === undefined || (!!line && (line.section === "answer" || line.section === "reasoning") &&
        Array.isArray(line.path) && line.path.every(isIndex) && isIndex(line.character) &&
        isIndex(line.fingerprint) && Number.isFinite(line.offset));
    }));
  } catch {
    return new Map();
  }
}

let positions: Map<string, ScrollPosition> | undefined;
let saveTimer: number | undefined;

export function getChatReadingPosition(threadId: string) {
  return (positions ??= readPositions()).get(threadId);
}

export function flushChatReadingPositions() {
  if (saveTimer === undefined || !positions) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    localStorage.setItem(storageKey, JSON.stringify(Array.from(positions).slice(-storedLimit)));
  } catch { /* Reading positions still work for this session. */ }
}

export function saveChatReadingPosition(threadId: string, position?: ScrollPosition) {
  const saved = positions ??= readPositions();
  const previouslyPaused = saved.delete(threadId);
  if (position) saved.set(threadId, position);
  else if (!previouslyPaused) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushChatReadingPositions, 300);
}

export function clearChatReadingPositions() {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  positions = new Map();
  try { localStorage.removeItem(storageKey); }
  catch { /* The in-memory reading positions are already cleared. */ }
}

// Check whether the text node still matches after reflow without storing its text.
export function readingLineFingerprint(text: string, character: number) {
  let hash = 2166136261;
  for (let index = Math.max(0, character - 8); index < Math.min(text.length, character + 12); index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}
