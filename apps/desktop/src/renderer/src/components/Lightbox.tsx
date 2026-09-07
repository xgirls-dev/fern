import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/useModalFocus";
import type { ImageRecord } from "../lib/types";
import { resolveAssetUrl } from "../lib/api";
import { ImageActions } from "./ImageActions";
import { PreviewMetadataHud } from "./PreviewMetadataHud";
export function Lightbox({
  image,
  images,
  onSelect,
  onClose,
  onRemix,
  onDelete,
}: {
  image: ImageRecord;
  images: ImageRecord[];
  onSelect: (image: ImageRecord) => void;
  onClose: () => void;
  onRemix: (image: ImageRecord) => void;
  onDelete: (image: ImageRecord) => Promise<void>;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useModalFocus(true, dialog, onClose);
  const index = images.findIndex((item) => item.name === image.name);
  useEffect(() => {
    setFailed(false);
    setZoom(0);
  }, [image.name, image.mtime]);
  function move(delta: number) {
    const next = images[index + delta];
    if (next) onSelect(next);
  }
  return createPortal((
    <div className="lightbox-backdrop" onMouseDown={onClose}>
    <div
      ref={dialog}
      className="lightbox image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Review ${image.name}`}
      tabIndex={-1}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (
          (event.target as HTMLElement).closest(
            'input,select,textarea,[role="alertdialog"]',
          )
        )
          return;
        if (!zoom && event.key === "ArrowLeft") {
          event.preventDefault();
          move(-1);
        }
        if (!zoom && event.key === "ArrowRight") {
          event.preventDefault();
          move(1);
        }
      }}
    >
      <header className="viewer-toolbar">
        <span>
          {Math.max(1, index + 1)} of {images.length || 1}
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={index <= 0}
          onClick={() => move(-1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={index < 0 || index >= images.length - 1}
          onClick={() => move(1)}
        >
          Next
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={zoom === 0}
          onClick={() => setZoom(0)}
        >
          Fit
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={zoom === 1}
          onClick={() => setZoom(1)}
        >
          100%
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setZoom((v) => Math.min(4, (v || 1) + 0.25))}
        >
          Zoom in
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setZoom((v) => Math.max(0.25, (v || 1) - 0.25))}
        >
          Zoom out
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close preview
        </button>
      </header>
      <div
        className={`viewer-canvas${zoom ? " is-zoomed" : ""}`}
        tabIndex={0}
        aria-label="Image canvas. Use arrow keys to pan when zoomed."
      >
        {failed ? (
          <div className="empty-state">
            <strong>Image unavailable</strong>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setFailed(false);
                setRetry((v) => v + 1);
              }}
            >
              Retry image
            </button>
          </div>
        ) : (
          <img
            src={resolveAssetUrl(image.url, `${image.mtime}-${retry}`)}
            alt={image.prompt ?? image.name}
            width={image.width}
            height={image.height}
            style={
              zoom
                ? {
                    width: (image.width ?? 1024) * zoom,
                    maxWidth: "none",
                    maxHeight: "none",
                  }
                : undefined
            }
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <footer className="viewer-details">
        <ImageActions image={image} onRemix={onRemix} onDelete={onDelete} />
        <PreviewMetadataHud image={image} />
      </footer>
    </div>
    </div>
  ), document.body);
}
