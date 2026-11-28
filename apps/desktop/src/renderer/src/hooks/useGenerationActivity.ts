import { useEffect, useRef, useState } from "react";

interface ActivityJob {
  id: string;
  lines: string[];
}

const MAX_JOBS = 12;
const MAX_LINES = 120;
const MAX_LINE_LENGTH = 512;

function recentLines(lines: readonly string[]) {
  return lines.slice(-MAX_LINES).map((line) => line.slice(0, MAX_LINE_LENGTH));
}

function readActivity(storageKey: string): ActivityJob[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(saved)) {
      return saved.filter((job): job is ActivityJob => typeof job?.id === "string" &&
        Array.isArray(job.lines) && job.lines.every((line: unknown) => typeof line === "string"))
        .slice(-MAX_JOBS).map(({ id, lines }) => ({ id, lines: recentLines(lines) }));
    }
  } catch {
    // Activity is still available for this session if storage is unavailable.
  }
  return [];
}

export function useGenerationActivity(workspace: "image" | "video", job: { id: string | null; logs?: readonly string[] } | undefined, resetRevision: number) {
  const storageKey = `fern-${workspace}-activity`;
  const [history, setHistory] = useState(() => readActivity(storageKey));
  const reset = useRef({ revision: resetRevision, ignoredJobId: null as string | null });

  useEffect(() => {
    if (reset.current.revision !== resetRevision) {
      reset.current = { revision: resetRevision, ignoredJobId: job?.id ?? null };
      setHistory([]);
      return;
    }
    if (!job?.id || job.id === reset.current.ignoredJobId || !job.logs?.length) return;
    const id = job.id;
    const lines = recentLines(job.logs);
    setHistory((current) => {
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) return [...current, { id, lines }].slice(-MAX_JOBS);
      const previous = current[index].lines;
      if (previous.length === lines.length && previous.every((line, offset) => line === lines[offset])) return current;
      return current.map((entry, offset) => offset === index ? { id, lines } : entry);
    });
  }, [job, resetRevision]);

  useEffect(() => {
    try {
      if (history.length) localStorage.setItem(storageKey, JSON.stringify(history));
      else localStorage.removeItem(storageKey);
    } catch {
      // The terminal keeps its in-memory scrollback.
    }
  }, [history, storageKey]);

  return history;
}
