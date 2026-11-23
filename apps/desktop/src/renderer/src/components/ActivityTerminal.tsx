import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import Terminal from "lucide-react/dist/esm/icons/terminal.mjs";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/controls";
import { ResizeHandle } from "./ui/ResizeHandle";

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
  const panelId = useId();

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

  const previewHeight = (next: number) => panelRef.current?.style.setProperty("height", `${next}px`);

  const lineCount = logs.length;
  const panelHeight = expanded ? height : COLLAPSED_HEIGHT;

  return (
    <section
      id={panelId}
      ref={panelRef}
      className={`activity-terminal-panel${expanded ? " is-expanded" : " is-collapsed"}`}
      style={{ height: panelHeight }}
      aria-label="Activity terminal"
    >
      {expanded && (
        <ResizeHandle
          className="activity-terminal-resize-handle"
          label="Resize activity terminal"
          controls={panelId}
          orientation="horizontal"
          value={height}
          min={MIN_HEIGHT}
          max={MAX_HEIGHT}
          step={12}
          inverted
          formatValue={(size) => `${size} pixels`}
          onPreview={previewHeight}
          onCommit={(size) => { previewHeight(size); setHeight(size); }}
          onCancel={() => previewHeight(height)}
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
            <Button
              variant="secondary"
              className="jump-latest"
              onClick={() => setFollowing(true)}
            >
              Jump to latest
            </Button>
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
