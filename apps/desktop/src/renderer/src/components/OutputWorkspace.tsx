import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import { resolveAssetUrl } from "../lib/api";
import type { ImageRecord } from "../lib/types";
import { notify } from "../lib/notifications";
import { ImageActions } from "./ImageActions";
import { useModalFocus } from "../hooks/useModalFocus";
import { Button, IconButton, Input, Select, SegmentedControl } from "./ui/controls";
interface Props {
  mode: "create" | "library";
  stateKey?: string;
  preview: ImageRecord | null;
  images: ImageRecord[];
  logs: string[];
  running: boolean;
  onSelectPreview: (image: ImageRecord) => void;
  onRemix: (image: ImageRecord) => void;
  onRemixInNewThread: (image: ImageRecord) => void;
  onOpenLightbox: () => void;
  onDelete: (image: ImageRecord) => Promise<void>;
  onToggleRenderInfo?: () => void;
  onOpenImage?: (image: ImageRecord, images: ImageRecord[]) => void;
}
interface View {
  query: string;
  sort: "newest" | "oldest";
  gallery: boolean;
  scroll: number;
  limit: number;
}
const views = new Map<string, View>();
export function renderProgress(logs: string[]) {
  let image = 1,
    count = 1,
    current = 0,
    total = 0;
  for (const line of logs) {
    const batch = line.match(/Batch image (\d+)\/(\d+)/i);
    if (batch) {
      image = Number(batch[1]);
      count = Number(batch[2]);
      current = 0;
      total = 0;
    }
    const step = line.match(/\bStep\s+(\d+)\s*\/\s*(\d+)/i);
    if (step) {
      current = Number(step[1]);
      total = Number(step[2]);
    }
  }
  return {
    label: `Image ${image} of ${count} — ${total ? `step ${current} of ${total}` : "preparing…"}`,
    percent: Math.min(
      99,
      Math.round(((image - 1 + (total ? current / total : 0)) / count) * 100),
    ),
  };
}
export function OutputWorkspace({
  mode,
  stateKey = mode,
  preview,
  images,
  logs,
  running,
  onSelectPreview,
  onRemix,
  onRemixInNewThread,
  onOpenLightbox,
  onDelete,
  onToggleRenderInfo,
  onOpenImage,
}: Props) {
  const [view, setView] = useState<View>(
    () =>
      views.get(stateKey) ?? {
        query: "",
        sort: "newest",
        gallery: mode === "library",
        scroll: 0,
        limit: 48,
      },
  );
  useEffect(() => {
    const show = () => setView((view) => ({ ...view, gallery: false }));
    window.addEventListener("fern-show-preview", show);
    return () => window.removeEventListener("fern-show-preview", show);
  }, []);
  const scroll = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteDialog = useRef<HTMLDivElement>(null);
  useModalFocus(confirmDelete, deleteDialog, () => { if (!deleting) setConfirmDelete(false); });
  const url = preview
    ? resolveAssetUrl(preview.url, `${preview.mtime}-${retry}`)
    : null;
  useEffect(() => {
    setFailed(false);
  }, [url]);
  useEffect(() => {
    views.set(stateKey, view);
  }, [stateKey, view]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = view.scroll;
  }, [stateKey, view.gallery]);
  const filtered = useMemo(
    () =>
      images
        .filter((image) =>
          `${image.name} ${image.prompt ?? ""}`
            .toLowerCase()
            .includes(view.query.trim().toLowerCase()),
        )
        .sort((a, b) =>
          view.sort === "newest" ? b.mtime - a.mtime : a.mtime - b.mtime,
        ),
    [images, view.query, view.sort],
  );
  const gallery = mode === "library" || view.gallery;
  const progress = renderProgress(logs);
  return (
    <section
      className={`output-workspace${gallery ? " output-workspace--gallery" : ""}${mode === "create" && gallery ? " output-workspace--recent" : ""}`}
      aria-label="Output workspace"
    >
      {mode === "create" && images.length ? (
        <SegmentedControl
          className="output-view-toolbar"
          label="Image workspace view"
          value={view.gallery ? "gallery" : "preview"}
          options={[{ value: "preview", label: "Preview" }, { value: "gallery", label: `Thread images ${images.length}` }]}
          onChange={(value) => setView((current) => ({ ...current, gallery: value === "gallery" }))}
        />
      ) : null}
      {running ? (
        <div className="generation-progress-strip" role="status">
          <span>{progress.label}</span>
          <div
            className="render-progress-track"
            role="progressbar"
            aria-label={progress.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <span style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      ) : null}
      {!gallery ? (
        <div className="output-preview-area">
          <div className="stage">
            {url && !failed ? (
              <button
                className="stage-image-button"
                type="button"
                onClick={onOpenLightbox}
                aria-label={`Open preview of ${preview?.name}`}
              >
                <img
                  className="stage-image"
                  src={url}
                  alt={preview?.prompt ?? preview?.name}
                  width={preview?.width ?? 1024}
                  height={preview?.height ?? 1024}
                  onError={() => setFailed(true)}
                />
              </button>
            ) : url ? (
              <div className="empty-state">
                <strong>Preview unavailable</strong>
                <span>Retry, or use More to open the output folder.</span>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFailed(false);
                    setRetry((v) => v + 1);
                  }}
                >
                  Retry preview
                </Button>
              </div>
            ) : (
              <div className="empty-state creation-welcome">
                <h3>
                  {running ? "Creating your image…" : "What will you create?"}
                </h3>
                {!running ? (
                  <span className="welcome-hint">Write your first prompt</span>
                ) : null}
              </div>
            )}
          </div>
          {preview ? (
            <>
              <div className="output-bar">
                <span className="output-name">
                  {preview.width} × {preview.height}
                </span>
                <div className="output-bar-actions">
                  <ImageActions
                    image={preview}
                    onRemix={(image) => {
                      setView((v) => ({ ...v, gallery: false }));
                      onRemix(image);
                    }}
                    onRemixInNewThread={onRemixInNewThread}
                    onDelete={onDelete}
                  />
                  {onToggleRenderInfo ? (
                    <Button
                      variant="secondary"
                      onClick={onToggleRenderInfo}
                    >
                      Render info
                    </Button>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <section
          className="gallery-panel is-expanded"
          id="recent-renders"
          aria-label="Image gallery"
        >
          <div className="gallery-panel-header">
            <span className="gallery-panel-count" role="status">
              {view.query
                ? `${filtered.length} of ${images.length} images`
                : `${images.length} images`}
            </span>
            <div className="gallery-panel-tools">
              {mode === "library" ? selecting ? <>
                <span className="gallery-selection-count" role="status">{selected.size} selected</span>
                <Button onClick={() => setSelected((previous) => { const next = new Set(previous); const allSelected = filtered.every((image) => next.has(image.name)); for (const image of filtered) { if (allSelected) next.delete(image.name); else next.add(image.name); } return next; })} disabled={!filtered.length}>{filtered.length && filtered.every((image) => selected.has(image.name)) ? "Deselect results" : "Select all results"}</Button>
                <Button variant="danger" disabled={!selected.size || deleting} onClick={() => { setDeleteError(""); setConfirmDelete(true); }}>Delete selected</Button>
                <Button onClick={() => { setSelecting(false); setSelected(new Set()); }}>Done</Button>
              </> : <Button onClick={() => setSelecting(true)} disabled={!images.length}>Select</Button> : null}
              <Input
                ref={search}
                className="gallery-search"
                type="search"
                aria-label="Filter images"
                placeholder="Search images…"
                value={view.query}
                onChange={(event) =>
                  setView((v) => ({
                    ...v,
                    query: event.target.value,
                    limit: 48,
                    scroll: 0,
                  }))
                }
              />
              <Select
                aria-label="Sort images"
                value={view.sort}
                onChange={(event) =>
                  setView((v) => ({
                    ...v,
                    sort: event.target.value as View["sort"],
                    scroll: 0,
                  }))
                }
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </Select>
            </div>
          </div>
          <div
            className="gallery-panel-body"
            ref={scroll}
            onScroll={(event) => {
              const top = event.currentTarget.scrollTop;
              views.set(stateKey, { ...view, scroll: top });
            }}
          >
            {!filtered.length ? (
              <div className="gallery-no-results ui-empty-state">
                <strong>{images.length ? "No matching images" : "No images yet"}</strong>
                <p>{images.length ? "Try another search to find an image." : mode === "library" ? "Images you create will appear here." : "Images created in this thread will appear here."}</p>
                {view.query ? (
                  <Button
                    onClick={() => { setView((v) => ({ ...v, query: "" })); search.current?.focus(); }}
                  >
                    Clear search
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="history-grid">
                {filtered.slice(0, view.limit).map((image) => (
                  <ImageCard
                    key={`${image.name}:${image.mtime}`}
                    image={image}
                    selecting={mode === "library" && selecting}
                    selected={selected.has(image.name)}
                    onToggleSelect={() => setSelected((previous) => { const next = new Set(previous); if (next.has(image.name)) next.delete(image.name); else next.add(image.name); return next; })}
                    onOpen={() => {
                      if (onOpenImage) onOpenImage(image, filtered);
                      else {
                        onSelectPreview(image);
                        setView((v) => ({ ...v, gallery: false }));
                      }
                    }}
                    onRemix={(image) => {
                      setView((v) => ({ ...v, gallery: false }));
                      onRemix(image);
                    }}
                    onRemixInNewThread={onRemixInNewThread}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            )}
            {filtered.length > view.limit ? (
              <Button
                variant="secondary"
                className="gallery-load-more"
                onClick={() => setView((v) => ({ ...v, limit: v.limit + 48 }))}
              >
                Show more images ({filtered.length - view.limit} remaining)
              </Button>
            ) : null}
          </div>
        </section>
      )}
      {confirmDelete ? createPortal(<div className="dialog-backdrop image-delete-backdrop"><div className="delete-image-dialog" role="alertdialog" aria-modal="true" aria-label="Delete selected images" tabIndex={-1} ref={deleteDialog}>
        <h3>Move {selected.size} {selected.size === 1 ? "image" : "images"} to Recycle Bin?</h3>
        <p>They will disappear from Library and their threads. You can restore the files from the Windows Recycle Bin.</p>
        {deleteError ? <p role="alert">{deleteError}</p> : null}
        <div className="image-actions"><Button disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" disabled={deleting || !selected.size} onClick={() => void (async () => {
          setDeleting(true); setDeleteError("");
          let deletedCount = 0;
          try {
            const targets = images.filter((item) => selected.has(item.name));
            if (!targets.length) throw new Error("The selected images are no longer in the library.");
            for (const image of targets) {
              await onDelete(image);
              deletedCount += 1;
              setSelected((previous) => { const next = new Set(previous); next.delete(image.name); return next; });
            }
            setConfirmDelete(false); setSelecting(false);
            notify(`${deletedCount} ${deletedCount === 1 ? "image" : "images"} moved to Recycle Bin.`);
          } catch (error) { setDeleteError(`${deletedCount ? `${deletedCount} moved. ` : ""}${error instanceof Error ? error.message : "Could not delete the remaining images. Try again."}`); }
          finally { setDeleting(false); }
        })()}>{deleting ? "Deleting…" : "Delete images"}</Button></div>
      </div></div>, document.body) : null}
    </section>
  );
}
function ImageCard({
  image,
  selecting,
  selected,
  onToggleSelect,
  onOpen,
  onRemix,
  onRemixInNewThread,
  onDelete,
}: {
  image: ImageRecord;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onRemix: (image: ImageRecord) => void;
  onRemixInNewThread: (image: ImageRecord) => void;
  onDelete: (image: ImageRecord) => Promise<void>;
}) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);
  return (
    <article className="thumb-wrap">
      <button
        type="button"
        className="thumb"
        onClick={selecting ? onToggleSelect : onOpen}
        aria-label={`${selecting ? "Select" : "Review"} ${image.name}`}
        aria-pressed={selecting ? selected : undefined}
      >
        {selecting ? <span className={`gallery-select-indicator${selected ? " is-selected" : ""}`} aria-hidden="true">{selected ? <Check size={14} /> : null}</span> : null}
        {failed ? (
          <span>Image unavailable — open details</span>
        ) : (
          <img
            src={resolveAssetUrl(image.url, `${image.mtime}-${retry}`)}
            alt={image.prompt ?? image.name}
            width={image.width ?? 256}
            height={image.height ?? 256}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
      </button>
      <div className="thumb-meta">
        <div className="thumb-prompt-container">
          <span
            className="thumb-prompt"
            title={image.prompt}
          >
            {image.prompt || image.name}
          </span>
          <IconButton className={`prompt-copy${copied ? " is-copied" : ""}`} onClick={async (event) => {
            event.stopPropagation();
            try {
              await window.studio.copyText(image.prompt ?? image.name);
              setCopied(true);
              if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
              copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
            } catch {
              notify("Could not copy the prompt. Select the text and copy it manually.", "error");
            }
          }
          } aria-label={copied ? "Prompt copied" : "Copy prompt to clipboard"}>
            {copied ? <Check size={14} aria-hidden="true" /> : null}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
            </svg>
          </IconButton>
        </div>
        {!selecting ? <ImageActions
          compact
          image={image}
          onRemix={onRemix}
          onRemixInNewThread={onRemixInNewThread}
          onDelete={onDelete}
        /> : null}
      </div>
      {failed ? (
        <Button
          variant="secondary"
          onClick={() => {
            setFailed(false);
            setRetry((v) => v + 1);
          }}
        >
          Retry image
        </Button>
      ) : null}
    </article>
  );
}
