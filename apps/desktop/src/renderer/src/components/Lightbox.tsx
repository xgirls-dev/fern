import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import ZoomIn from "lucide-react/dist/esm/icons/zoom-in.mjs";
import ZoomOut from "lucide-react/dist/esm/icons/zoom-out.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
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
  onRemixInNewThread,
  onDelete,
}: {
  image: ImageRecord;
  images: ImageRecord[];
  onSelect: (image: ImageRecord) => void;
  onClose: () => void;
  onRemix: (image: ImageRecord) => void;
  onRemixInNewThread: (image: ImageRecord) => void;
  onDelete: (image: ImageRecord) => Promise<void>;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
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
  return createPortal(
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
          <div className="viewer-navigation">
            <button
              type="button"
              className="viewer-icon"
              title="Previous image"
              aria-label="Previous"
              disabled={index <= 0}
              onClick={() => move(-1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span className="viewer-count">
              {Math.max(1, index + 1)} / {images.length || 1}
            </span>
            <button
              type="button"
              className="viewer-icon"
              title="Next image"
              aria-label="Next"
              disabled={index < 0 || index >= images.length - 1}
              onClick={() => move(1)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="viewer-zoom" role="group" aria-label="Image zoom">
            <button
              type="button"
              aria-pressed={zoom === 0}
              onClick={() => setZoom(0)}
            >
              Fit
            </button>
            <button
              type="button"
              aria-pressed={zoom === 1}
              onClick={() => setZoom(1)}
            >
              100%
            </button>
            <button
              type="button"
              className="viewer-icon"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={zoom === 0.25}
              onClick={() => setZoom((v) => Math.max(0.25, (v || 1) - 0.25))}
            >
              <ZoomOut size={17} />
            </button>
            {zoom > 0 && zoom !== 1 ? (
              <span className="viewer-zoom-value">
                {Math.round(zoom * 100)}%
              </span>
            ) : null}
            <button
              type="button"
              className="viewer-icon"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={zoom === 4}
              onClick={() => setZoom((v) => Math.min(4, (v || 1) + 0.25))}
            >
              <ZoomIn size={17} />
            </button>
          </div>
          <div className="viewer-utilities">
            <button
              type="button"
              className="viewer-icon"
              aria-label="Render info"
              title="Render info"
              aria-expanded={infoOpen}
              onClick={() => setInfoOpen((v) => !v)}
            >
              <Info size={18} />
            </button>
            <button
              type="button"
              className="viewer-icon"
              aria-label="Close preview"
              title="Close preview"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </div>
        </header>
        <div className={`viewer-body${infoOpen ? " has-info" : ""}`}>
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
          {infoOpen ? (
            <aside className="viewer-info" aria-label="Render info">
              <h3>Render info</h3>
              <PreviewMetadataHud image={image} />
            </aside>
          ) : null}
        </div>
        <footer className="viewer-details">
          <span className="viewer-filename" title={image.name}>
            {image.name}
          </span>
          <ImageActions
            image={image}
            onRemix={onRemix}
            onRemixInNewThread={onRemixInNewThread}
            onDelete={onDelete}
          />
        </footer>
      </div>
    </div>,
    document.body,
  );
}
