import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import Terminal from "lucide-react/dist/esm/icons/terminal.mjs";
import { useCallback, useEffect, useRef, useState } from "react";

interface ActivityTerminalProps {
  logs: string[];
  running: boolean;
}

const EXPANDED_KEY = "fern-terminal-expanded";
const HEIGHT_KEY = "fern-terminal-height";
const LEGACY_EXPANDED_KEY = "iris-terminal-expanded";
const LEGACY_HEIGHT_KEY = "iris-terminal-height";
const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 420;
const COLLAPSED_HEIGHT = 32;

export function ActivityTerminal({ logs, running }: ActivityTerminalProps) {
  const [expanded, setExpanded] = useState(() => {
    try {
      return (
        (localStorage.getItem(EXPANDED_KEY) ??
          localStorage.getItem(LEGACY_EXPANDED_KEY)) === "true"
      );
    } catch {
      return false;
    }
  });
  const [height, setHeight] = useState(() => {
    try {
      const stored = Number(
        localStorage.getItem(HEIGHT_KEY) ??
          localStorage.getItem(LEGACY_HEIGHT_KEY),
      );
      if (
        Number.isFinite(stored) &&
        stored >= MIN_HEIGHT &&
        stored <= MAX_HEIGHT
      ) {
        return stored;
      }
    } catch {
      // ignore
    }
    return DEFAULT_HEIGHT;
  });
  const [following, setFollowing] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(height);
  const liveHeightRef = useRef(height);

  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, String(expanded));
  }, [expanded]);

  useEffect(() => {
    localStorage.setItem(HEIGHT_KEY, String(height));
  }, [height]);

  useEffect(() => {
    if (!expanded || !bodyRef.current || !following) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [expanded, logs, running, following]);

  const onResizeMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      const delta = startYRef.current - event.clientY;
      const next = Math.min(
        MAX_HEIGHT,
        Math.max(MIN_HEIGHT, startHeightRef.current + delta),
      );
      liveHeightRef.current = next;
      if (panelRef.current) panelRef.current.style.height = `${next}px`;
    },
    [],
  );

  const onResizeEnd = useCallback(
    (event?: React.PointerEvent<HTMLDivElement>) => {
      if (event && pointerIdRef.current !== event.pointerId) return;
      pointerIdRef.current = null;
      panelRef.current?.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setHeight(liveHeightRef.current);
    },
    [],
  );

  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!expanded) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerIdRef.current = event.pointerId;
      startYRef.current = event.clientY;
      startHeightRef.current = height;
      liveHeightRef.current = height;
      panelRef.current?.classList.add("is-resizing");
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [expanded, height],
  );

  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const nextHeight =
        event.key === "Home"
          ? MIN_HEIGHT
          : event.key === "End"
            ? MAX_HEIGHT
            : event.key === "ArrowUp"
              ? height + 12
              : event.key === "ArrowDown"
                ? height - 12
                : null;
      if (nextHeight == null) return;
      event.preventDefault();
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, nextHeight)));
    },
    [height],
  );

  useEffect(
    () => () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  const lineCount = logs.length;
  const panelHeight = expanded ? height : COLLAPSED_HEIGHT;

  return (
    <section
      ref={panelRef}
      className={`activity-terminal-panel${expanded ? " is-expanded" : " is-collapsed"}`}
      style={{ height: panelHeight }}
      aria-label="Activity terminal"
    >
      {expanded && (
        <div
          className="activity-terminal-resize-handle"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onKeyDown={onResizeKeyDown}
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Resize activity terminal"
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          aria-valuenow={height}
        />
      )}

      <button
        type="button"
        className="activity-terminal-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <div className="activity-terminal-title">
          <Terminal size={13} aria-hidden="true" />
          <span>Activity</span>
          {lineCount > 0 && (
            <span className="activity-terminal-count">{lineCount}</span>
          )}
          {running && <span className="activity-terminal-live">live</span>}
        </div>
        {expanded ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronUp size={14} aria-hidden="true" />
        )}
      </button>

      <span className="sr-only" role="status" aria-live="polite">
        {running
          ? "Generation activity is updating."
          : lineCount > 0
            ? `${lineCount} activity entries available.`
            : "No generation activity yet."}
      </span>

      {expanded && (
        <div
          className="activity-terminal-body"
          ref={bodyRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {!following ? (
            <button
              type="button"
              className="jump-latest"
              onClick={() => setFollowing(true)}
            >
              Jump to latest
            </button>
          ) : null}
          {logs.length === 0 ? (
            <div className="activity-terminal-line activity-terminal-line--muted">
              <span className="activity-terminal-prompt">$</span>
              Waiting for generation activity…
            </div>
          ) : (
            logs.map((line, index) => (
              <div key={`${index}:${line}`} className="activity-terminal-line">
                <span className="activity-terminal-prompt">$</span>
                <span>{line}</span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
