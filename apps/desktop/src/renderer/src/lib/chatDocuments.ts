export const MAX_CHAT_DOCUMENTS = 8;
export const MAX_CHAT_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const CHAT_DOCUMENT_ACCEPT = ".pdf,.docx,.txt,.md";

export interface ChatDocument {
  id: string;
  name: string;
  bytes: number;
  unavailable?: boolean;
}

export interface ChatDocumentSource {
  number: number;
  name: string;
  location: string;
  excerpt: string;
}

export function isChatDocument(value: unknown): value is ChatDocument {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChatDocument>;
  return typeof item.id === "string" && /^doc-[a-f0-9]{64}$/.test(item.id)
    && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 255
    && typeof item.bytes === "number" && Number.isInteger(item.bytes)
    && item.bytes > 0 && item.bytes <= MAX_CHAT_DOCUMENT_BYTES;
}

export function normalizeChatDocuments(value: unknown): ChatDocument[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Map(value.filter(isChatDocument).map((document) => [document.id, document])).values()].slice(0, MAX_CHAT_DOCUMENTS);
}

export function normalizeDocumentSources(value: unknown): ChatDocumentSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is ChatDocumentSource => item && Number.isInteger(item.number) && item.number > 0
    && typeof item.name === "string" && typeof item.location === "string" && typeof item.excerpt === "string")
    .slice(0, 80).map(({ number, name, location, excerpt }) => ({
      number, name: name.slice(0, 255), location: location.slice(0, 80), excerpt: excerpt.slice(0, 600),
    }));
}

export function validateChatDocument(file: File) {
  if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) throw new Error("Choose a PDF, DOCX, TXT, or Markdown document.");
  if (!file.size || file.size > MAX_CHAT_DOCUMENT_BYTES) throw new Error("Choose a non-empty document up to 20 MB.");
}
