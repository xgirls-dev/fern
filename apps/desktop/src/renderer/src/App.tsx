import Square from "lucide-react/dist/esm/icons/square.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import { useCallback, useEffect, useRef, useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import type { ImageRecord } from "./lib/types";
import { PromptComposer } from "./components/PromptComposer";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { resolveAssetUrl } from "./lib/api";
import { useStudio } from "./hooks/useStudio";
import { ActivityTerminal } from "./components/ActivityTerminal";
import { CommandPalette } from "./components/CommandPalette";
import { StorageView } from "./components/StorageView";
import { GenerationControls } from "./components/GenerationControls";
import { PreviewMetadataHud } from "./components/PreviewMetadataHud";
import { Lightbox } from "./components/Lightbox";
import { OutputWorkspace } from "./components/OutputWorkspace";
import { PreferencesView } from "./components/PreferencesView";
import { RuntimeLoadingDialog } from "./components/RuntimeLoadingDialog";
import { StudioSidebar } from "./components/StudioSidebar";
import { TitleBar } from "./components/TitleBar";

import { Notifications } from "./components/Notifications";
import { ThreadBrowser } from "./components/ThreadBrowser";
import { notify } from "./lib/notifications";
import { validateReference } from "./lib/reference";

export function App() {
  const studio = useStudio();
  const [threadBrowserOpen, setThreadBrowserOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<
    "settings" | "info" | null
  >(null);
  const inspectorOpen = inspectorView === "settings";
  const renderInfoOpen = inspectorView === "info";
  const setInspectorOpen = (value: boolean | ((open: boolean) => boolean)) =>
    setInspectorView((current) =>
      (typeof value === "function" ? value(current === "settings") : value)
        ? "settings"
        : null,
    );
  const setRenderInfoOpen = (value: boolean | ((open: boolean) => boolean)) =>
    setInspectorView((current) =>
      (typeof value === "function" ? value(current === "info") : value)
        ? "info"
        : null,
    );
  const [lightboxImage, setLightboxImage] = useState<ImageRecord | null>(null);
  const [viewerImages, setViewerImages] = useState<ImageRecord[]>([]);
  const inspectorRef = useRef<HTMLElement>(null);
  const [runtimeDismissed, setRuntimeDismissed] = useState(true);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const lightboxOpen = Boolean(lightboxImage);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<
    "create" | "library" | "preferences" | "storage"
  >("create");
  const [promptFocusRequest, setPromptFocusRequest] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("fern-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (activeSection !== "preferences" && activeSection !== "storage") return;
    document
      .querySelector<HTMLElement>(".shell-page:not([hidden]) h2")
      ?.focus();
  }, [activeSection]);

  const openThreadSearch = useCallback(() => setThreadBrowserOpen(true), []);
  const openStorage = useCallback(() => setActiveSection("storage"), []);
  const openPreferences = useCallback(
    () => setActiveSection("preferences"),
    [],
  );
  const openLibrary = useCallback(() => {
    setActiveSection("library");
  }, []);

  const focusPrompt = useCallback(() => {
    setActiveSection("create");
    setPromptFocusRequest((value) => value + 1);
  }, []);

  const newThread = useCallback(() => {
    studio.newThread();
    focusPrompt();
  }, [studio.newThread, focusPrompt]);

  const openThread = useCallback(
    (id: string) => {
      studio.selectThread(id);
      setActiveSection("create");
      setLightboxImage(null);
    },
    [studio.selectThread],
  );

  const remixImage = (image: ImageRecord) => {
    const threadId = studio.activeThread.id;
    const previousPrompt = studio.settings.prompt;
    studio.setPreview(image);
    setTimeout(() => window.dispatchEvent(new Event("fern-show-preview")), 0);
    studio.updateSettings({ prompt: image.prompt ?? "" }, threadId);
    setLightboxImage(null);
    focusPrompt();
    notify("Image selected. Prompt restored to composer.", "info", {
      label: "Undo",
      run: () => studio.updateSettings({ prompt: previousPrompt }, threadId),
    });
  };
  const remixInNewThread = (image: ImageRecord) => {
    setLightboxImage(null);
    void studio
      .remixImage(image)
      .then(focusPrompt)
      .catch((error) => notify(String(error), "error"));
  };
  const openImage = (image: ImageRecord, images: ImageRecord[]) => {
    setViewerImages(images);
    setLightboxImage(image);
  };
  const deleteImage = async (image: ImageRecord) => {
    await studio.deleteImage(image);
    const remaining = viewerImages.filter((item) => item.name !== image.name);
    setViewerImages(remaining);
    if (lightboxImage?.name === image.name)
      setLightboxImage(remaining[0] ?? null);
    setTimeout(() => {
      if (document.activeElement === document.body) {
        document
          .querySelector<HTMLElement>('[aria-label="Filter images"], #prompt')
          ?.focus();
      }
    }, 50);
  };
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id) openThread(id);
    };
    const invalid = (event: Event) => {
      setInspectorOpen(true);
      setTimeout(() => {
        const key = (event as CustomEvent<string>).detail;
        const field = document.getElementById(
          key === "batchSize" ? "batch-size" : key,
        );
        field?.closest("details")?.setAttribute("open", "");
        field?.focus();
        field?.scrollIntoView({ block: "center" });
      }, 30);
    };
    const models = () => setActiveSection("preferences");
    window.addEventListener("fern-models", models);
    window.addEventListener("fern-open-thread", open);
    window.addEventListener("fern-validation", invalid);
    return () => {
      window.removeEventListener("fern-models", models);
      window.removeEventListener("fern-open-thread", open);
      window.removeEventListener("fern-validation", invalid);
    };
  }, [openThread]);
  useEffect(() => {
    if (!inspectorView) return;
    const opener = document.activeElement as HTMLElement;
    const timer = setTimeout(
      () =>
        inspectorRef.current
          ?.querySelector<HTMLButtonElement>("button")
          ?.focus(),
      0,
    );
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector('[aria-modal="true"]')
      ) {
        setInspectorOpen(false);
        opener?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", escape);
    };
  }, [inspectorView]);
  useEffect(() => {
    if (studio.notice) {
      notify(studio.notice, "info");
      studio.dismissNotice();
    }
  }, [studio.notice, studio.dismissNotice]);

  useEffect(() => {
    if (promptFocusRequest === 0 || activeSection !== "create" || !studio.ready)
      return;
    const timeout = window.setTimeout(() => {
      const prompt = document.getElementById("prompt");
      if (!prompt) return;
      prompt.scrollIntoView({ behavior: "smooth", block: "center" });
      prompt.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [activeSection, promptFocusRequest, studio.ready]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter" &&
        !event.isComposing &&
        !document.querySelector('[aria-modal="true"]') &&
        activeSection === "create" &&
        !lightboxOpen &&
        !commandPaletteOpen &&
        studio.modelInstalled &&
        !studio.runtimeLoading &&
        !studio.runtimeNeedsAttention &&
        !studio.running
      ) {
        event.preventDefault();
        void studio.generate();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    studio.generate,
    studio.running,
    studio.modelInstalled,
    studio.runtimeLoading,
    studio.runtimeNeedsAttention,
    activeSection,
    lightboxOpen,
    commandPaletteOpen,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      } else if (key === "n") {
        event.preventDefault();
        newThread();
      } else if (key === "l") {
        event.preventDefault();
        openLibrary();
      } else if (key === "b") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newThread, openLibrary]);

  useEffect(() => {
    try {
      localStorage.setItem("fern-sidebar-collapsed", String(sidebarCollapsed));
    } catch {
      // Layout preference is optional.
    }
  }, [sidebarCollapsed]);

  const previewUrl = studio.preview
    ? resolveAssetUrl(studio.preview.url, studio.preview.mtime)
    : null;
  const startupDialogOpen = !runtimeDismissed;
  const cpuAvailable =
    studio.status?.model.adapters?.some(
      (adapter) => adapter.id === "CPU" && adapter.available,
    ) ?? true;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <TitleBar
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
        theme={studio.settings.theme}
        onToggleTheme={() =>
          studio.updateSettings({
            theme: studio.settings.theme === "dark" ? "light" : "dark",
          })
        }
        onOpenCommands={() => setCommandPaletteOpen(true)}
      />

      <div
        className={`app-body${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
      >
        <StudioSidebar
          threads={studio.threads}
          onArchiveThread={studio.archiveThread}
          onOpenSearch={openThreadSearch}
          activeThreadId={studio.activeThread.id}
          runningThreadId={
            studio.running ? (studio.status?.job.threadId ?? null) : null
          }
          onSelectThread={openThread}
          onNewThread={newThread}
          onRenameThread={studio.renameThread}
          onDeleteThread={studio.deleteThread}
          submitting={studio.submitting}
          collapsed={sidebarCollapsed}
          activeSection={activeSection}
          onOpenLibrary={openLibrary}
          onOpenData={openStorage}
          onOpenPreferences={openPreferences}
        />

        <main
          id="main-content"
          className={`dashboard dashboard--${activeSection}`}
        >
          <StorageView
            active={activeSection === "storage"}
            running={studio.running}
            onResetLocalData={studio.resetLocalData}
          />
          <PreferencesView
            active={activeSection === "preferences"}
            theme={studio.settings.theme}
            sidebarCollapsed={sidebarCollapsed}
            modelStatus={studio.status?.model ?? null}
            onToggleTheme={() =>
              studio.updateSettings({
                theme: studio.settings.theme === "dark" ? "light" : "dark",
              })
            }
            onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          />

          {activeSection === "preferences" ||
          activeSection === "storage" ? null : activeSection === "create" ? (
            <section
              className={`create-view${inspectorView ? " has-inspector" : ""}`}
              aria-labelledby="create-heading"
            >
              <header className="workspace-header">
                <div className="workspace-heading">
                  <h2 id="create-heading" title={studio.activeThread.title}>
                    {studio.activeThread.title}
                  </h2>
                  <select
                    className={`thread-switcher${sidebarCollapsed ? " is-visible" : ""}`}
                    aria-label="Open thread"
                    value={studio.activeThread.id}
                    onChange={(event) => openThread(event.target.value)}
                  >
                    {studio.threads
                      .filter(
                        (thread) =>
                          !thread.archived ||
                          thread.id === studio.activeThread.id,
                      )
                      .map((thread) => (
                        <option key={thread.id} value={thread.id}>
                          {thread.title}
                        </option>
                      ))}
                  </select>
                  <span
                    className="workspace-heading-divider"
                    aria-hidden="true"
                  >
                    /
                  </span>
                  <span>
                    {studio.status?.model.selectedModel
                      ? `Flux.2 Klein ${studio.status.model.selectedModel.toUpperCase()}`
                      : "Flux.2 Klein"}
                  </span>
                </div>
                <div className="workspace-header-actions">
                  {studio.activeThreadRunning ? (
                    <div className="generation-header-status">
                      <span className="generation-elapsed" role="timer">
                        {studio.stateLabel}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary generation-stop"
                        onClick={() => void studio.stopGeneration()}
                        disabled={studio.stopping}
                        aria-label={
                          studio.stopping
                            ? "Stopping generation"
                            : "Stop generation"
                        }
                      >
                        <Square
                          size={10}
                          fill="currentColor"
                          aria-hidden="true"
                        />
                        {studio.stopping ? "Stopping…" : "Stop"}
                      </button>
                    </div>
                  ) : studio.running && studio.status?.job.threadId ? (
                    <button
                      type="button"
                      className="workspace-settings-button"
                      onClick={() => openThread(studio.status!.job.threadId!)}
                    >
                      View rendering thread
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="workspace-settings-button"
                    aria-label="Image settings"
                    aria-expanded={inspectorOpen}
                    aria-controls="generation-inspector"
                    onClick={() => setInspectorOpen((open) => !open)}
                  >
                    <SlidersHorizontal size={15} aria-hidden="true" />
                    <span>Image settings</span>
                  </button>
                </div>
              </header>
              <div className="create-layout">
                <section
                  className="creation-canvas"
                  aria-label="Image workspace"
                >
                  <OutputWorkspace
                    key={`outputs-${studio.activeThread.id}-${studio.resetRevision}`}
                    stateKey={`${studio.activeThread.id}-${studio.resetRevision}`}
                    onDelete={deleteImage}
                    onOpenImage={openImage}
                    mode="create"
                    preview={studio.preview}
                    images={studio.threadImages}
                    logs={
                      studio.status?.job.threadId === studio.activeThread.id
                        ? studio.status.job.logs
                        : []
                    }
                    running={studio.activeThreadRunning}
                    onSelectPreview={studio.setPreview}
                    onRemix={remixImage}
                    onRemixInNewThread={remixInNewThread}
                    onOpenLightbox={() => {
                      if (studio.preview)
                        openImage(studio.preview, studio.threadImages);
                    }}
                    onToggleRenderInfo={() =>
                      setRenderInfoOpen((open) => !open)
                    }
                  />
                  <PromptComposer
                    resolvedModel={studio.status?.model.selectedModel}
                    installedModels={studio.status?.installedModels}
                    onReferenceBusy={setReferenceBusy}
                    key={`composer-${studio.activeThread.id}`}
                    busyElsewhere={
                      studio.running && !studio.activeThreadRunning
                    }
                    settings={studio.settings}
                    referenceImage={studio.referenceImage}
                    referenceLabel={studio.referenceLabel}
                    supportsReference={
                      studio.status?.model.supportsReferenceImage ?? true
                    }
                    running={studio.activeThreadRunning}
                    submitting={studio.submitting}
                    stopping={studio.stopping}
                    ready={
                      studio.modelInstalled &&
                      !studio.connecting &&
                      !studio.referenceLoading &&
                      !referenceBusy
                    }
                    inspectorOpen={inspectorOpen}
                    onSettingsChange={(patch) =>
                      studio.updateSettings(patch, studio.activeThread.id)
                    }
                    onReferenceChange={(url, label) => {
                      studio.setReferenceImage(url);
                      studio.setReferenceLabel(label);
                    }}
                    onClearReference={() => {
                      studio.setReferenceImage("");
                      studio.setReferenceLabel("No reference image.");
                    }}
                    onToggleInspector={() => setInspectorOpen((open) => !open)}
                    onGenerate={() => void studio.generate()}
                  />
                  <ActivityTerminal
                    key={`activity-${studio.activeThread.id}-${studio.resetRevision}`}
                    logs={
                      studio.status?.job.threadId === studio.activeThread.id
                        ? studio.status.job.logs
                        : []
                    }
                    running={studio.activeThreadRunning}
                  />
                </section>
                <aside
                  ref={inspectorRef}
                  id="generation-inspector"
                  className="generation-inspector"
                  aria-label={renderInfoOpen ? "Render info" : "Image settings"}
                  hidden={!inspectorView}
                  data-view={inspectorView ?? undefined}
                >
                  <div className="inspector-heading">
                    <div
                      className="inspector-tabs"
                      role="group"
                      aria-label="Inspector view"
                    >
                      <button
                        type="button"
                        aria-pressed={inspectorOpen}
                        onClick={() => setInspectorView("settings")}
                      >
                        Image settings
                      </button>
                      <button
                        type="button"
                        aria-pressed={renderInfoOpen}
                        disabled={!studio.preview}
                        onClick={() => setInspectorView("info")}
                      >
                        Render info
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn-icon"
                      aria-label={
                        renderInfoOpen
                          ? "Close render info"
                          : "Close image settings"
                      }
                      onClick={() => setInspectorView(null)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div hidden={!inspectorOpen}>
                    <GenerationControls
                      errors={studio.fieldErrors}
                      onReferenceBusy={setReferenceBusy}
                      key={`controls-${studio.activeThread.id}-${studio.resetRevision}`}
                      settings={studio.settings}
                      modelStatus={studio.status?.model ?? null}
                      referenceImage={studio.referenceImage}
                      referenceLabel={studio.referenceLabel}
                      onSettingsChange={(patch) =>
                        studio.updateSettings(patch, studio.activeThread.id)
                      }
                      onReferenceChange={(dataUrl, label) => {
                        studio.setReferenceImage(dataUrl);
                        studio.setReferenceLabel(label);
                      }}
                      onClearReference={() => {
                        studio.setReferenceImage("");
                        studio.setReferenceLabel(
                          "No reference image. Text-to-image mode.",
                        );
                      }}
                      onUseOutputAsReference={async () => {
                        if (!previewUrl || !studio.preview) return;
                        setReferenceBusy(true);
                        try {
                          const response = await fetch(previewUrl);
                          if (!response.ok)
                            throw new Error(
                              "Image unavailable. Retry the preview or choose another reference.",
                            );
                          const blob = await response.blob();
                          const dataUrl = await new Promise<string>(
                            (resolve, reject) => {
                              const reader = new FileReader();
                              reader.onload = () =>
                                resolve(String(reader.result));
                              reader.onerror = reject;
                              reader.readAsDataURL(blob);
                            },
                          );
                          await validateReference(dataUrl);
                          studio.setReferenceImage(dataUrl);
                          studio.setReferenceLabel(
                            `${studio.preview.name} loaded as reference.`,
                          );
                        } finally {
                          setReferenceBusy(false);
                        }
                      }}
                      canUseOutput={Boolean(studio.preview)}
                    />
                  </div>
                  {renderInfoOpen && studio.preview ? (
                    <PreviewMetadataHud image={studio.preview} />
                  ) : null}
                </aside>
              </div>
            </section>
          ) : (
            <section
              id="library-view"
              className="library-view"
              aria-labelledby="library-view-heading"
            >
              <header className="library-view-header">
                <div>
                  <span className="view-kicker">Studio</span>
                  <h2 id="library-view-heading">Library</h2>
                  <p>
                    Review, search, and remix every image Fern has created on
                    this device.
                  </p>
                </div>
                <div className="workspace-header-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      void window.studio
                        .openOutputsFolder()
                        .then((error) => {
                          if (error) throw new Error(error);
                          notify("Opened output folder.");
                        })
                        .catch((error) => notify(String(error), "error"))
                    }
                  >
                    <FolderOpen size={14} aria-hidden="true" /> Open folder
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={newThread}
                  >
                    <Plus size={14} aria-hidden="true" />
                    New thread
                  </button>
                </div>
              </header>
              <OutputWorkspace
                key={`library-${studio.resetRevision}`}
                stateKey={`library-${studio.resetRevision}`}
                onDelete={deleteImage}
                onOpenImage={openImage}
                mode="library"
                preview={studio.preview}
                images={studio.status?.images ?? []}
                logs={studio.status?.job.logs ?? []}
                running={studio.running}
                onSelectPreview={(image) => {
                  setLightboxImage(image);
                }}
                onRemix={remixImage}
                onRemixInNewThread={remixInNewThread}
                onOpenLightbox={() => setLightboxImage(studio.preview)}
              />
            </section>
          )}

          {studio.error && !startupDialogOpen && (
            <div className="dashboard-error" role="alert">
              {studio.error}
              {studio.status?.job.model === "9b" &&
              /memory|allocation|out of resources/i.test(studio.error) ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    studio.updateSettings({ model: "4b" });
                    studio.dismissError();
                  }}
                >
                  Use Klein 4B for retry
                </button>
              ) : null}
              <button
                type="button"
                onClick={studio.dismissError}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}
        </main>
      </div>

      {startupDialogOpen ? (
        <RuntimeLoadingDialog
          onDismiss={() => setRuntimeDismissed(true)}
          runtime={studio.runtimeStatus}
          cpuAvailable={cpuAvailable}
          onRetry={() => void studio.retryRuntime()}
          onUseCpu={() => {
            studio.chooseDevice("CPU");
          }}
        />
      ) : null}

      {lightboxImage && (
        <Lightbox
          image={lightboxImage}
          images={viewerImages}
          onSelect={setLightboxImage}
          onRemix={remixImage}
          onRemixInNewThread={remixInNewThread}
          onDelete={deleteImage}
          onClose={() => setLightboxImage(null)}
        />
      )}
      <Notifications />
      {threadBrowserOpen ? (
        <ThreadBrowser
          threads={studio.threads}
          onOpen={openThread}
          onClose={() => setThreadBrowserOpen(false)}
        />
      ) : null}
      {runtimeDismissed &&
      !studio.running &&
      (studio.runtimeNeedsAttention ||
        studio.status?.model.checking ||
        studio.runtimeLoading ||
        studio.connecting ||
        !studio.status ||
        !studio.ready) ? (
        <div className="runtime-banner" role="status">
          <span>
            {!studio.status
              ? "Connecting to Fern…"
              : studio.status.model.checking
                ? studio.status.model.runtimeNote
                : (studio.runtimeStatus?.message ??
                  "Generation is unavailable.")}
          </span>
          <button type="button" onClick={() => setRuntimeDismissed(false)}>
            Generation status
          </button>
        </div>
      ) : null}
      {studio.running && activeSection !== "create" ? (
        <div className="runtime-banner">
          <span>
            {studio.runtimeLoading
              ? "Loading model for generation"
              : "Rendering in another view"}
          </span>
          <button
            type="button"
            disabled={studio.stopping}
            onClick={() => void studio.stopGeneration()}
          >
            Stop generation
          </button>
          <button
            type="button"
            onClick={() => {
              if (studio.status?.job.threadId)
                openThread(studio.status.job.threadId);
            }}
          >
            View thread
          </button>
        </div>
      ) : null}
      <CommandPalette
        open={commandPaletteOpen}
        running={studio.running}
        sidebarCollapsed={sidebarCollapsed}
        onClose={() => setCommandPaletteOpen(false)}
        onNewRender={newThread}
        onOpenLibrary={openLibrary}
        onOpenData={openStorage}
        onOpenPreferences={openPreferences}
        onToggleTheme={() =>
          studio.updateSettings({
            theme: studio.settings.theme === "dark" ? "light" : "dark",
          })
        }
        onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
        onStop={() => void studio.stopGeneration()}
      />
    </div>
  );
}
