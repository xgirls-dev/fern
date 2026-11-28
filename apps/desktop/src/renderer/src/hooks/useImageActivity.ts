import { useEffect, useRef, useState } from "react";
import type { FluxJob } from "../lib/types";

interface ActivityJob {
  id: string;
  lines: string[];
}

const STORAGE_KEY = "fern-image-activity";
const MAX_JOBS = 12;
const MAX_LINES = 120;
const MAX_LINE_LENGTH = 512;

function recentLines(lines: string[]) {
  return lines.slice(-MAX_LINES).map((line) => line.slice(0, MAX_LINE_LENGTH));
}

function readActivity(): ActivityJob[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
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

export function useImageActivity(job: FluxJob | undefined, resetRevision: number) {
  const [history, setHistory] = useState(readActivity);
  const reset = useRef({ revision: resetRevision, ignoredJobId: null as string | null });

  useEffect(() => {
    if (reset.current.revision !== resetRevision) {
      reset.current = { revision: resetRevision, ignoredJobId: job?.id ?? null };
      setHistory([]);
      return;
    }
    if (!job?.id || job.id === reset.current.ignoredJobId || !job.logs.length) return;
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
      if (history.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // The terminal keeps its in-memory scrollback.
    }
  }, [history]);

  return history;
}
