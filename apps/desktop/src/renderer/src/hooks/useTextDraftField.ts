import { useCallback, useLayoutEffect, useRef } from "react";

interface DraftView {
  text: string;
  start: number;
  end: number;
  direction: HTMLTextAreaElement["selectionDirection"];
  scrollTop: number;
}

// A draft can temporarily unmount during workspace navigation or transcript scrolling.
const draftViews = new Map<string, DraftView>();

function fitDraftField(field: HTMLTextAreaElement, maxHeight: number) {
  const scrollTop = field.scrollTop;
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, maxHeight)}px`;
  field.scrollTop = scrollTop;
}

export function useTextDraftField(key: string, value: string, maxHeight: number) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const initialized = useRef<HTMLTextAreaElement | null>(null);
  const bindField = useCallback((field: HTMLTextAreaElement | null) => {
    const leaving = fieldRef.current;
    if (!field && leaving?.value) {
      draftViews.set(key, { text: leaving.value, start: leaving.selectionStart, end: leaving.selectionEnd,
        direction: leaving.selectionDirection, scrollTop: leaving.scrollTop });
    }
    fieldRef.current = field;
  }, [key]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    fitDraftField(field, maxHeight);
    if (initialized.current === field) return;
    initialized.current = field;
    const saved = draftViews.get(key);
    draftViews.delete(key);
    if (saved?.text === value) {
      field.setSelectionRange(saved.start, saved.end, saved.direction);
      field.scrollTop = saved.scrollTop;
    } else field.setSelectionRange(value.length, value.length);
  }, [key, maxHeight, value]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    // Height changes trigger ResizeObserver too, so refit only when the width changes.
    let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = field.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      if (width > 0) fitDraftField(field, maxHeight);
    });
    observer.observe(field, { box: "border-box" });
    return () => observer.disconnect();
  }, [key, maxHeight]);

  return { fieldRef, bindField };
}
