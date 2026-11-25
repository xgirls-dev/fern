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
const nativeAutosize = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

function fitDraftField(field: HTMLTextAreaElement, maxHeight: number) {
  const scrollTop = field.scrollTop;
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, maxHeight)}px`;
  field.scrollTop = scrollTop;
}

export function useTextDraftField(key: string, value: string, maxHeight: number) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const initialized = useRef<HTMLTextAreaElement | null>(null);
  const scrollTop = useRef(0);
  const rememberScroll = useCallback(() => {
    if (fieldRef.current) scrollTop.current = fieldRef.current.scrollTop;
  }, []);
  const bindField = useCallback((field: HTMLTextAreaElement | null) => {
    const leaving = fieldRef.current;
    if (leaving) {
      leaving.removeEventListener("scroll", rememberScroll);
      // Reading scrollTop while React unmounts the textarea can force a layout.
      if (leaving.value) draftViews.set(key, { text: leaving.value, start: leaving.selectionStart, end: leaving.selectionEnd,
        direction: leaving.selectionDirection, scrollTop: scrollTop.current });
    }
    fieldRef.current = field;
    scrollTop.current = 0;
    field?.addEventListener("scroll", rememberScroll, { passive: true });
  }, [key, rememberScroll]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (!nativeAutosize) fitDraftField(field, maxHeight);
    if (initialized.current === field) return;
    initialized.current = field;
    const saved = draftViews.get(key);
    draftViews.delete(key);
    if (saved?.text === value) {
      field.setSelectionRange(saved.start, saved.end, saved.direction);
      if (saved.scrollTop) {
        field.scrollTop = saved.scrollTop;
        scrollTop.current = field.scrollTop;
      }
    } else field.setSelectionRange(value.length, value.length);
  }, [key, maxHeight, value]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field || nativeAutosize) return;
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
