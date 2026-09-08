import { useEffect, useMemo, useRef, useState } from "react";
import { resolveAssetUrl } from "../lib/api";
import type { ImageRecord } from "../lib/types";
import { ImageActions } from "./ImageActions";
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
  const scroll = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
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
        <div
          className="output-view-toolbar"
          role="group"
          aria-label="Image workspace view"
        >
          <button
            type="button"
            aria-pressed={!view.gallery}
            onClick={() => setView((v) => ({ ...v, gallery: false }))}
          >
            Preview
          </button>
          <button
            type="button"
            aria-pressed={view.gallery}
            onClick={() => setView((v) => ({ ...v, gallery: true }))}
          >
            Thread images {images.length}
          </button>
        </div>
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
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setFailed(false);
                    setRetry((v) => v + 1);
                  }}
                >
                  Retry preview
                </button>
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
                    onRemix={onRemix}
                    onRemixInNewThread={onRemixInNewThread}
                    onDelete={onDelete}
                  />
                  {onToggleRenderInfo ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={onToggleRenderInfo}
                    >
                      Render info
                    </button>
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
              <input
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
              <select
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
              </select>
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
              <div className="gallery-no-results">
                <p>
                  {images.length
                    ? "No images match your search."
                    : "No images yet."}
                </p>
                {view.query ? (
                  <button
                    type="button"
                    onClick={() => setView((v) => ({ ...v, query: "" }))}
                  >
                    Clear search
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="history-grid">
                {filtered.slice(0, view.limit).map((image) => (
                  <ImageCard
                    key={`${image.name}:${image.mtime}`}
                    image={image}
                    onOpen={() => {
                      if (onOpenImage) onOpenImage(image, filtered);
                      else {
                        onSelectPreview(image);
                        setView((v) => ({ ...v, gallery: false }));
                      }
                    }}
                    onRemix={onRemix}
                    onRemixInNewThread={onRemixInNewThread}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            )}
            {filtered.length > view.limit ? (
              <button
                type="button"
                className="btn btn-secondary gallery-load-more"
                onClick={() => setView((v) => ({ ...v, limit: v.limit + 48 }))}
              >
                Show more images ({filtered.length - view.limit} remaining)
              </button>
            ) : null}
          </div>
        </section>
      )}
    </section>
  );
}
function ImageCard({
  image,
  onOpen,
  onRemix,
  onRemixInNewThread,
  onDelete,
}: {
  image: ImageRecord;
  onOpen: () => void;
  onRemix: (image: ImageRecord) => void;
  onRemixInNewThread: (image: ImageRecord) => void;
  onDelete: (image: ImageRecord) => Promise<void>;
}) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  return (
    <article className="thumb-wrap">
      <button
        type="button"
        className="thumb"
        onClick={onOpen}
        aria-label={`Review ${image.name}`}
      >
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
        <span className="thumb-prompt" title={image.prompt}>
          {image.prompt || image.name}
        </span>
        <ImageActions
          compact
          image={image}
          onRemix={onRemix}
          onRemixInNewThread={onRemixInNewThread}
          onDelete={onDelete}
        />
      </div>
      {failed ? (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setRetry((v) => v + 1);
          }}
        >
          Retry image
        </button>
      ) : null}
    </article>
  );
}
