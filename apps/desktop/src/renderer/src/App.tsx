import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import type { ImageRecord } from "./lib/types";
import { PromptComposer } from "./components/PromptComposer";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { resolveAssetUrl } from "./lib/api";
import { useStudio } from "./hooks/useStudio";
import { useVideo } from "./hooks/useVideo";
import { readReference } from "./lib/reference";
import Clapperboard from "lucide-react/dist/esm/icons/clapperboard.mjs";
import { useQwen3Tts } from "./hooks/useQwen3Tts";
import { useTextChat } from "./hooks/useTextChat";
import { createThreadSearchSession } from "./hooks/useThreadSearch";
import { useSidebarLayout } from "./hooks/useSidebarLayout";
import { useComputePreference } from "./hooks/useComputePreference";
import { ActivityTerminal } from "./components/ActivityTerminal";
import { CommandPalette } from "./components/CommandPalette";
import { GenerationControls } from "./components/GenerationControls";
import { PreviewMetadataHud } from "./components/PreviewMetadataHud";
import { Lightbox } from "./components/Lightbox";
import { OutputWorkspace } from "./components/OutputWorkspace";
import { RuntimeLoadingDialog } from "./components/RuntimeLoadingDialog";
import { StudioSidebar } from "./components/StudioSidebar";
import { TitleBar } from "./components/TitleBar";
import { WorkspaceThreadTitle } from "./components/WorkspaceThreadTitle";
import { ThreadBrowser, type ThreadBrowserScope } from "./components/ThreadBrowser";
import { Button, IconButton, PageHeader } from "./components/ui/controls";
import { ProgressLabel } from "./components/ui/ProgressLabel";

import { Notifications } from "./components/Notifications";
import { notify } from "./lib/notifications";
import { validateReference } from "./lib/reference";
import { loadModelSetup, saveModelSetup, type SetupSelection, type SetupTask } from "./lib/modelSetup";
import { hasTextThreadWork, textRuntimeIssue } from "./lib/textThreads";
import { hasAudioThreadWork } from "./lib/ttsThreads";
import { loadLastWorkspace, matchesShortcut, saveLastWorkspace, shortcuts } from "./lib/workspaceNavigation";
import { fixedImagePreset, isKleinLoraModel, kleinLoraLabel, maxReferenceImages } from "./lib/imageModels";
import { chatFolderPath } from "./lib/chatFolders";

const StorageView = lazy(() => import("./components/StorageView").then((module) => ({ default: module.StorageView })));
const PreferencesView = lazy(() => import("./components/PreferencesView").then((module) => ({ default: module.PreferencesView })));
const Qwen3TtsWorkspace = lazy(() => import("./components/Qwen3TtsWorkspace").then((module) => ({ default: module.Qwen3TtsWorkspace })));
const VideoWorkspace = lazy(() => import("./components/VideoWorkspace").then((module) => ({ default: module.VideoWorkspace })));
const ChatWorkspace = lazy(() => import("./components/ChatWorkspace").then((module) => ({ default: module.ChatWorkspace })));
const ModelsView = lazy(() => import("./components/ModelsView").then((module) => ({ default: module.ModelsView })));

export function App() {
  const compute = useComputePreference();
  const studio = useStudio(compute.device);
  const imageGpu = window.studio.platform === "darwin" ? "APPLE_GPU" : "INTEL_GPU";
  const imageGpuAvailable = studio.status?.model.adapters?.find((adapter) => adapter.id === imageGpu)?.available;
  const tts = useQwen3Tts(studio.ready, compute.device);
  const text = useTextChat(studio.ready, compute.device, imageGpuAvailable);
  const [threadSearchSession] = useState(createThreadSearchSession);
  useEffect(() => threadSearchSession.clear, [threadSearchSession]);
  const [threadSearch, setThreadSearch] = useState<{ query: string; scope?: ThreadBrowserScope } | null>(null);
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
  const attachReference = (dataUrl: string, label: string) => {
    const limit = maxReferenceImages(studio.settings.model);
    if (limit > 1) {
      if (studio.referenceImages.length >= limit) throw new Error(`Klein accepts up to ${limit} references. Remove an attachment in the composer first.`);
      studio.setReferenceImages([...studio.referenceImages, { dataUrl, label }]);
    } else studio.setReferenceImages([{ dataUrl, label }]);
  };
  const lightboxOpen = Boolean(lightboxImage);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [modelSetup, setModelSetup] = useState(loadModelSetup);
  const [activeSection, setActiveSection] = useState<
    "create" | "tts" | "text" | "video" | "library" | "models" | "preferences" | "storage"
  >(() => modelSetup && modelSetup.viewing !== false ? "models" : loadLastWorkspace());
  const video = useVideo(studio.ready, activeSection === "video");
  const audioBusy = ["running", "setting_up", "stopping"].includes(tts.status.status);
  const [modelCategory, setModelCategory] = useState<"image" | "text" | "audio" | "video">(
    modelSetup && modelSetup.task !== "image" ? "text" : "image",
  );
  const [chatFocusRequest, setChatFocusRequest] = useState(0);
  const [chatFindRequest, setChatFindRequest] = useState<{ threadId: string; query: string } | null>(null);
  const clearChatFindRequest = useCallback(() => setChatFindRequest(null), []);
  const [computeFocusRequest, setComputeFocusRequest] = useState(0);
  useEffect(() => { saveLastWorkspace(activeSection); }, [activeSection]);
  useEffect(() => {
    if (modelSetup) saveModelSetup({ ...modelSetup, viewing: activeSection === "models" });
  }, [activeSection, modelSetup]);
  const chatFolderIndex = useMemo(() => new Map(text.folders.map((folder) => [folder.id, folder])), [text.folders]);
  const searchingThreads = threadSearch !== null;
  const searchKind = commandPaletteOpen ? undefined : threadSearch?.scope?.kind;
  const searchableThreads = useMemo(() => {
    if (!commandPaletteOpen && !searchingThreads) return [];
    return [
      ...(!searchKind || searchKind === "Image" ? studio.searchThreads() : []),
      ...(!searchKind || searchKind === "Speech" ? tts.threads.map((thread) => ({
        ...thread, excerpt: thread.text, hasWork: hasAudioThreadWork(thread),
      })) : []),
      ...(!searchKind || searchKind === "Chat" ? text.threads.map((thread) => ({
        ...thread,
        hasWork: hasTextThreadWork(thread),
        excerpt: thread.messages.find((message) => message.role === "user")?.content || thread.draft,
        folderPath: chatFolderPath(chatFolderIndex, thread.folderId),
      })) : []),
    ];
  }, [chatFolderIndex, commandPaletteOpen, searchKind, searchingThreads, studio.searchThreads, text.threads, tts.threads]);
  const imageSetupNeeded = studio.status?.installedModels !== undefined && !studio.modelInstalled &&
    !studio.status.installedModels.some((model) => model.installed !== false);
  useEffect(() => {
    if (!studio.ready) return;
    const imageActive = activeSection === "create" || activeSection === "library";
    studio.setImagePollingActive(imageActive);
    if (imageActive) void studio.refresh();
  }, [activeSection, studio.ready, studio.refresh, studio.setImagePollingActive]);
  const [promptFocusRequest, setPromptFocusRequest] = useState(0);
  const handledPromptFocusRequest = useRef(0);
  const {
    compactLayout,
    sidebarIsCollapsed,
    wideSidebarCollapsed,
    sidebarOverlayOpen,
    sidebarRef,
    sidebarToggleRef,
    toggleSidebar,
    toggleWideSidebar,
    closeSidebarOverlay,
  } = useSidebarLayout();
  const openCommands = useCallback(() => {
    if (sidebarOverlayOpen) {
      sidebarToggleRef.current?.focus();
      closeSidebarOverlay("current");
    }
    setCommandPaletteOpen(true);
  }, [sidebarOverlayOpen, sidebarToggleRef, closeSidebarOverlay]);
  const theme = studio.settings.theme;
  const toggleTheme = useCallback(() => {
    studio.updateSettings({ theme: theme === "dark" ? "light" : "dark" });
  }, [studio.updateSettings, theme]);

  const onSidebarNavigate = useCallback(() => {
    if (sidebarOverlayOpen) closeSidebarOverlay("workspace");
  }, [sidebarOverlayOpen, closeSidebarOverlay]);

  useEffect(() => {
    if (activeSection !== "preferences" && computeFocusRequest) setComputeFocusRequest(0);
    if (activeSection === "preferences" && computeFocusRequest) return;
    if (!["preferences", "storage", "models"].includes(activeSection)) return;
    document
      .querySelector<HTMLElement>(".shell-page:not([hidden]) h2")
      ?.focus();
  }, [activeSection, computeFocusRequest]);

  const searchThreadsByQuery = useCallback((query: string) => setThreadSearch({ query }), []);
  const openThreadSearch = useCallback(() => setThreadSearch({ query: "" }), []);
  const openChatThreadSearch = useCallback(() => {
    setThreadSearch({ query: "", scope: { kind: "Chat", currentId: text.activeThread.id } });
  }, [text.activeThread.id]);
  const openImageThreadSearch = useCallback(() => {
    setThreadSearch({ query: "", scope: { kind: "Image", currentId: studio.activeThread.id } });
  }, [studio.activeThread.id]);
  const openAudioThreadSearch = useCallback(() => {
    setThreadSearch({ query: "", scope: { kind: "Speech", currentId: tts.activeThread.id } });
  }, [tts.activeThread.id]);
  const openStorage = useCallback(() => setActiveSection("storage"), []);
  const openVideo = useCallback(() => setActiveSection("video"), []);
  const openVideoModels = useCallback(() => { setModelCategory("video"); setActiveSection("models"); }, []);
  const animateImage = async (image: ImageRecord) => {
    try {
      const response = await fetch(resolveAssetUrl(image.url), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("The saved image could not be opened.");
      const file = new File([await response.blob()], image.name, { type: "image/png" });
      video.setReference({ dataUrl: await readReference(file), label: image.name });
      openVideo();
    } catch (error) {
      notify(error instanceof Error ? error.message : "The saved image could not be opened.", "error");
    }
  };
  const openModels = useCallback(() => { setModelCategory("image"); setActiveSection("models"); }, []);
  const openPreferences = useCallback(
    () => setActiveSection("preferences"),
    [],
  );
  const openComputePreferences = () => {
    setComputeFocusRequest((value) => value + 1);
    setActiveSection("preferences");
  };
  const [openingImages, startImagesNavigation] = useTransition();
  const openLibrary = useCallback(() => {
    startImagesNavigation(() => setActiveSection("library"));
  }, [startImagesNavigation]);

  const focusPrompt = useCallback(() => {
    setActiveSection("create");
    setPromptFocusRequest((value) => value + 1);
  }, []);

  const newThread = useCallback(() => {
    studio.newThread();
    focusPrompt();
  }, [studio.newThread, focusPrompt]);

  const newAudioThread = useCallback(() => {
    tts.newThread();
    setActiveSection("tts");
  }, [tts.newThread]);

  const newTextThread = useCallback((folderId?: string) => {
    text.newThread(folderId);
    setActiveSection("text");
    setChatFocusRequest((value) => value + 1);
  }, [text.newThread]);

  const duplicateTextThread = useCallback((id: string) => {
    text.copyThread(id);
    setActiveSection("text");
    setChatFocusRequest((value) => value + 1);
  }, [text.copyThread]);

  const selectTextThread = useCallback((id: string) => {
    text.selectThread(id);
    setActiveSection("text");
  }, [text.selectThread]);

  const selectAudioThread = useCallback((id: string) => {
    tts.selectThread(id);
    setActiveSection("tts");
  }, [tts.selectThread]);

  const openThread = useCallback(
    (id: string) => {
      if (id.startsWith("text-thread-")) {
        text.selectThread(id);
        setActiveSection("text");
        setLightboxImage(null);
        return;
      }
      if (id.startsWith("audio-thread-")) {
        tts.selectThread(id);
        setActiveSection("tts");
        setLightboxImage(null);
        return;
      }
      studio.selectThread(id);
      setActiveSection("create");
      setLightboxImage(null);
    },
    [studio.selectThread, tts.selectThread, text.selectThread],
  );

  const imageThreadId = studio.activeThread.id;
  const textThreadId = text.activeThread?.id;
  const { models: textModels, ggufAvailable, ggufUnavailableReason, runtimeAvailable, runtimeError } = text.status;
  const openModelSetup = useCallback((task: SetupTask, chatId?: string) => {
    const threadId = task === "image" ? imageThreadId : chatId ?? textThreadId;
    if (!threadId) return;
    const setup = { task, threadId };
    setModelSetup(setup);
    const runtime = { ggufAvailable, ggufUnavailableReason, runtimeAvailable, runtimeError };
    const hasVisionModel = task === "chat-image" && textModels.some((model) =>
      model.installed && model.supportsTools && model.supportsVision && !textRuntimeIssue(runtime, model));
    setModelCategory(task === "image" || (task === "chat-image" && hasVisionModel) ? "image" : "text");
    setActiveSection("models");
  }, [ggufAvailable, ggufUnavailableReason, imageThreadId, runtimeAvailable, runtimeError, textModels, textThreadId]);

  const returnToDraft = (selection?: SetupSelection) => {
    if (!modelSetup) return;
    const { task, threadId } = modelSetup;
    saveModelSetup(null);
    setModelSetup(null);
    if (task === "image") {
      const thread = studio.threads.find((item) => item.id === threadId);
      if (thread && !thread.archived) {
        if (selection?.imageModelId) {
          const preset = fixedImagePreset(selection.imageModelId);
          studio.updateSettings({
            model: selection.imageModelId,
            ...(preset ? { width: 512, height: 512, steps: preset.steps, guidance: preset.guidance, batchSize: 1, device: "AUTO" as const } : {}),
          }, threadId);
        }
        studio.selectThread(threadId);
      }
      focusPrompt();
    } else {
      const thread = text.threads.find((item) => item.id === threadId);
      if (thread && !thread.archived) {
        if (selection?.textModelId) text.updateThread(threadId, {
          modelId: selection.textModelId,
          ...(selection.imageModelId ? { imageModel: selection.imageModelId } : {}),
        });
        text.selectThread(threadId);
      }
      setActiveSection("text");
      setChatFocusRequest((value) => value + 1);
    }
  };

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
  const openImage = useCallback((image: ImageRecord, images: ImageRecord[]) => {
    setViewerImages(images);
    setLightboxImage(image);
  }, []);
  const deleteImage = async (image: ImageRecord) => {
    await studio.deleteImage(image);
    const remaining = viewerImages.filter((item) => item.name !== image.name);
    setViewerImages(remaining);
    if (lightboxImage?.name === image.name)
      setLightboxImage(remaining[0] ?? null);
    setTimeout(() => {
      if (!document.querySelector('[aria-modal="true"]') && document.activeElement === document.body) {
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
    const models = (event: Event) => {
      const category = (event as CustomEvent<string>).detail;
      setModelCategory(category === "text" || category === "audio" || category === "video" ? category : "image");
      setActiveSection("models");
    };
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

  useLayoutEffect(() => {
    if (activeSection !== "create" || promptFocusRequest === handledPromptFocusRequest.current) return;
    const prompt = document.getElementById("prompt");
    if (!prompt) return;
    handledPromptFocusRequest.current = promptFocusRequest;
    prompt.focus({ preventScroll: true });
    prompt.scrollIntoView({ block: "nearest" });
  }, [activeSection, promptFocusRequest]);

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
      const actions = {
        commands: openCommands,
        image: activeSection === "text" ? newTextThread : newThread, speech: newAudioThread, chat: newTextThread, images: openLibrary,
        sidebar: toggleSidebar,
      };
      const match = (Object.keys(shortcuts) as Array<keyof typeof shortcuts>).find((key) => matchesShortcut(event, shortcuts[key]));
      if (!match) return;
      event.preventDefault();
      if (match !== "commands" && match !== "sidebar") onSidebarNavigate();
      actions[match]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSection, newThread, newAudioThread, newTextThread, openLibrary, openCommands, toggleSidebar, onSidebarNavigate]);

  const previewUrl = studio.preview
    ? resolveAssetUrl(studio.preview.url, studio.preview.mtime)
    : null;
  const canReuseRenderSettings = !!studio.preview?.width && !!studio.preview.height &&
    (!studio.preview.model || studio.preview.model === studio.settings.model ||
      studio.status?.installedModels?.some((model) => model.id === studio.preview?.model && model.installed !== false));
  const reuseRenderSettings = () => {
    const image = studio.preview;
    if (!image || !canReuseRenderSettings || !image.width || !image.height) return;
    studio.updateSettings({
      width: image.width,
      height: image.height,
      ...(image.model ? { model: image.model } : {}),
      ...(image.steps !== undefined ? { steps: image.steps } : {}),
      ...(image.guidance !== undefined ? { guidance: image.guidance } : {}),
      ...(image.seed !== undefined ? { seed: image.seed, seedLocked: true } : {}),
    }, studio.activeThread.id);
    setInspectorView("settings");
    notify("Render settings applied to the next image.");
  };
  const startupDialogOpen = !runtimeDismissed;
  const connectionPending = studio.connecting || !studio.status;
  const connectionError = studio.connectionError ??
    (studio.ready && !studio.status && !studio.connecting ? studio.error : null);
  const showImageRuntimeStatus = activeSection === "create" &&
    (connectionPending || studio.runtimeNeedsAttention ||
      (!imageSetupNeeded && (studio.status?.model.checking || studio.runtimeLoading)));
  const connectionStatus = studio.connecting
    ? "Connecting to Fern…"
    : connectionError
      ? "Fern’s local service is unavailable."
      : !studio.status ? "Connecting to Fern…" : null;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <TitleBar
        sidebarCollapsed={sidebarIsCollapsed}
        sidebarToggleRef={sidebarToggleRef}
        onToggleSidebar={toggleSidebar}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenCommands={openCommands}
      />

      <div
        className={`app-body${sidebarIsCollapsed ? " is-sidebar-collapsed" : ""}${sidebarOverlayOpen ? " has-sidebar-overlay" : ""}`}
      >
        {sidebarOverlayOpen ? (
          <div className="sidebar-overlay-scrim" aria-hidden="true" onClick={() => closeSidebarOverlay("opener")} />
        ) : null}
        <StudioSidebar
          sidebarRef={sidebarRef}
          onNavigate={onSidebarNavigate}
          onExpandForNew={compactLayout && !sidebarOverlayOpen ? toggleSidebar : undefined}
          threads={studio.threads}
          audioThreads={tts.threads}
          textThreads={text.sidebarThreads}
          chatFolders={text.folders}
          onOrganizeChats={text.organize}
          onArchiveThread={studio.archiveThread}
          onOpenSearch={openThreadSearch}
          activeThreadId={studio.activeThread.id}
          activeAudioThreadId={tts.activeThread.id}
          activeTextThreadId={text.activeThread.id}
          runningAudioThreadId={
            tts.status.status === "running" || tts.status.status === "setting_up" || tts.status.status === "stopping"
              ? tts.status.threadId
              : null
          }
          runningTextThreadId={text.status.job.status === "running" ? text.status.job.threadId : text.threads.find((thread) => !!thread.pendingJobId)?.id ?? null}
          runningThreadId={
            studio.running ? (studio.status?.job.threadId ?? null) : null
          }
          onSelectThread={openThread}
          onNewThread={newThread}
          onSelectAudioThread={selectAudioThread}
          onNewAudioThread={newAudioThread}
          onSelectTextThread={selectTextThread}
          onNewTextThread={newTextThread}
          onRenameTextThread={text.renameThread}
          onDuplicateTextThread={duplicateTextThread}
          onExportTextThread={text.exportTranscript}
          onArchiveTextThread={text.archiveThread}
          onDeleteTextThread={text.deleteThread}
          onRenameAudioThread={tts.renameThread}
          onArchiveAudioThread={tts.archiveThread}
          onDeleteAudioThread={tts.deleteThread}
          onRenameThread={studio.renameThread}
          onDeleteThread={studio.deleteThread}
          submitting={studio.submitting}
          collapsed={sidebarIsCollapsed}
          activeSection={activeSection}
          onOpenLibrary={openLibrary}
          openingImages={openingImages}
          onOpenVideo={openVideo}
          onOpenModels={openModels}
          onOpenData={openStorage}
          onOpenPreferences={openPreferences}
        />

        <main
          id="main-content"
          tabIndex={-1}
          className={`dashboard dashboard--${activeSection}`}
        >
          <h1 className="sr-only">Fern workspace</h1>
          <Notifications inChat={activeSection === "text"} />
          {activeSection === "models" ? <Suspense fallback={<div className="dashboard-loading" role="status">Opening models…</div>}><ModelsView category={modelCategory} onCategoryChange={setModelCategory} text={text} audio={tts} setup={modelSetup} onReturnToDraft={returnToDraft} imageGpuAvailable={imageGpuAvailable} /></Suspense> : null}
          {activeSection === "storage" ? <Suspense fallback={<div className="dashboard-loading" role="status">Opening storage…</div>}><StorageView
            active={activeSection === "storage"}
            running={studio.running || audioBusy || text.busy || text.savingAttachment || video.running}
            onOpenModels={openModels}
            onResetLocalData={async () => {
              await studio.resetLocalData();
              await text.resetWorkspace();
              threadSearchSession.clear();
              tts.resetWorkspace();
              video.reset();
              saveModelSetup(null);
              setModelSetup(null);
            }}
          /></Suspense> : null}
          {activeSection === "preferences" ? <Suspense fallback={<div className="dashboard-loading" role="status">Opening preferences…</div>}><PreferencesView
            active={activeSection === "preferences"}
            computeFocusRequest={computeFocusRequest}
            onReturnToChat={computeFocusRequest ? () => { setComputeFocusRequest(0); setActiveSection("text"); setChatFocusRequest((value) => value + 1); } : undefined}
            theme={studio.settings.theme}
            sidebarCollapsed={wideSidebarCollapsed}
            compactLayout={compactLayout}
            modelStatus={studio.status?.model ?? null}
            chatRuntime={{ status: text.status, thread: text.activeThread, loaded: text.statusLoaded, error: text.statusError }}
            onRefreshChatModels={text.refreshModels}
            onOpenTextModels={() => openModelSetup("chat")}
            computeDevice={compute.device}
            onComputeDeviceChange={(device) => compute.updatePreference({ device, allowCpu: device === "CPU" })}
            onToggleTheme={() =>
              studio.updateSettings({
                theme: studio.settings.theme === "dark" ? "light" : "dark",
              })
            }
            onToggleSidebar={toggleWideSidebar}
          /></Suspense> : null}

          {activeSection === "models" || activeSection === "preferences" ||
          activeSection === "storage" ? null : activeSection === "text" ? (
            text.storageReady
              ? <Suspense fallback={<div className="dashboard-loading" role="status"><ProgressLabel>Opening chat…</ProgressLabel></div>}><ChatWorkspace studio={text} sidebarCollapsed={sidebarIsCollapsed} onOpenThreadSearch={openChatThreadSearch} onSetupModels={openModelSetup} focusRequest={chatFocusRequest} findRequest={chatFindRequest} onFindRequestHandled={clearChatFindRequest} imageGpuAvailable={imageGpuAvailable} onOpenImage={openImage} onNewChat={newTextThread} onCreateImage={newThread} onCreateSpeech={newAudioThread} onOpenCompute={openComputePreferences} /></Suspense>
              : <div className="dashboard-loading">
                {text.storageError ? <><span role="alert">{text.storageError}</span><Button variant="secondary" onClick={text.retryStorage}>Retry opening chats</Button></> : <span role="status"><ProgressLabel>Opening chats…</ProgressLabel></span>}
              </div>
          ) : activeSection === "video" ? (
            <Suspense fallback={<div className="dashboard-loading" role="status">Opening video workspace…</div>}>
              <VideoWorkspace video={video} device={compute.device} busyElsewhere={studio.running || studio.submitting || audioBusy || text.busy}
                openModels={openVideoModels} openCompute={openComputePreferences} />
            </Suspense>
          ) : activeSection === "tts" ? (
            <Suspense fallback={<div className="dashboard-loading" role="status">Opening audio workspace…</div>}><Qwen3TtsWorkspace studio={tts} sidebarCollapsed={sidebarIsCollapsed} onOpenThreadSearch={openAudioThreadSearch} /></Suspense>
          ) : activeSection === "create" ? (
            <section
              className={`create-view${inspectorView ? " has-inspector" : ""}`}
              aria-labelledby="create-heading"
            >
              <header className="workspace-header">
                <div className="workspace-heading">
                  <WorkspaceThreadTitle
                    id="create-heading"
                    title={studio.activeThread.title}
                    switchLabel="Open thread"
                    sidebarCollapsed={sidebarIsCollapsed}
                    onOpen={openImageThreadSearch}
                  />
                  <span
                    className="workspace-heading-divider"
                    aria-hidden="true"
                  >
                    /
                  </span>
                  <span>
                    {!studio.status ? "Checking models…" : imageSetupNeeded ? "No image model" : studio.status.model.selectedModel === "qwen21-turbo"
                      ? "Qwen Image 2.1 Turbo"
                      : studio.status?.model.selectedModel === "flux3-klein"
                        ? "FLUX.3 Klein · INT4"
                        : studio.status?.model.selectedModel === "tame-pony-v25-sdxl" || studio.status?.model.selectedModel === "tame-pony-v25-sdxl-int8"
                          ? studio.status?.model.selectedModel.endsWith("-int8") ? "Tame Pony · SDXL INT8" : "Tame Pony · SDXL"
                        : studio.status?.model.selectedModel?.startsWith("custom-") || fixedImagePreset(studio.status?.model.selectedModel)
                          ? studio.status?.installedModels?.find((model) => model.id === studio.status?.model.selectedModel)?.label ?? "Custom image model"
                        : studio.status?.model.selectedModel
                        ? `FLUX.2 ${isKleinLoraModel(studio.status.model.selectedModel) ? kleinLoraLabel(studio.status.model.selectedModel) : `Klein ${studio.status.model.selectedModel.toUpperCase()}`}`
                        : "Flux.2 Klein"}
                  </span>
                </div>
                <div className="workspace-header-actions">
                  {studio.preview && !video.running ? <IconButton title="Animate image" aria-label="Animate image"
                    onClick={() => { if (studio.preview) void animateImage(studio.preview); }}>
                    <Clapperboard size={15} aria-hidden="true" />
                  </IconButton> : null}
                  {studio.running && !studio.activeThreadRunning && studio.status?.job.threadId ? (
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
                    onSetupModel={imageSetupNeeded ? () => openModelSetup("image") : undefined}
                    preview={studio.preview}
                    images={studio.threadImages}
                    logs={
                      studio.status?.job.threadId === studio.activeThread.id
                        ? studio.status.job.logs
                        : []
                    }
                    running={studio.activeThreadRunning}
                    stopping={studio.stopping}
                    phase={studio.runtimeLoading ? studio.runtimeStatus?.message : undefined}
                    elapsed={studio.elapsed}
                    onStop={() => void studio.stopGeneration()}
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
                    onManageModels={() => openModelSetup("image")}
                    installedModels={studio.status?.installedModels}
                    onReferenceBusy={setReferenceBusy}
                    key={`composer-${studio.activeThread.id}`}
                    busyElsewhere={
                      (studio.running && !studio.activeThreadRunning) || video.running
                    }
                    settings={studio.settings}
                    referenceImages={studio.referenceImages}
                    running={studio.activeThreadRunning}
                    submitting={studio.submitting}
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
                    onReferencesChange={studio.setReferenceImages}
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
                  aria-label={renderInfoOpen ? "Selected image" : "Next image"}
                  hidden={!inspectorView}
                  data-view={inspectorView ?? undefined}
                >
                  <div className="inspector-heading">
                    <div
                      className="inspector-tabs"
                      role="group"
                      aria-label="Inspector view"
                    >
                      <Button
                        variant="ghost"
                        aria-pressed={inspectorOpen}
                        onClick={() => setInspectorView("settings")}
                      >
                        Next image
                      </Button>
                      <Button
                        variant="ghost"
                        aria-pressed={renderInfoOpen}
                        disabled={!studio.preview}
                        onClick={() => setInspectorView("info")}
                      >
                        Selected image
                      </Button>
                    </div>
                    <IconButton
                      aria-label={
                        renderInfoOpen
                          ? "Close render info"
                          : "Close image settings"
                      }
                      onClick={() => setInspectorView(null)}
                    >
                      <X size={16} />
                    </IconButton>
                  </div>
                  <div hidden={!inspectorOpen}>
                    <GenerationControls
                      errors={studio.fieldErrors}
                      onReferenceBusy={setReferenceBusy}
                      key={`controls-${studio.activeThread.id}-${studio.resetRevision}`}
                      settings={studio.settings}
                      modelStatus={studio.status?.model ?? null}
                      computeDevice={compute.device}
                      referenceImage={studio.referenceImage}
                      referenceCount={studio.referenceImages.length}
                      referenceLabel={studio.referenceLabel}
                      onSettingsChange={(patch) =>
                        studio.updateSettings(patch, studio.activeThread.id)
                      }
                      onReferenceChange={(dataUrl, label) => {
                        attachReference(dataUrl, label);
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
                          attachReference(dataUrl, studio.preview.name);
                        } finally {
                          setReferenceBusy(false);
                        }
                      }}
                      canUseOutput={Boolean(studio.preview)}
                    />
                  </div>
                  {renderInfoOpen && studio.preview ? (
                    <div className="selected-render-details">
                      <PreviewMetadataHud image={studio.preview} />
                      {canReuseRenderSettings ? <Button variant="secondary" onClick={reuseRenderSettings}>Use render settings</Button> : null}
                    </div>
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
              <PageHeader className="library-view-header" id="library-view-heading" title="Images" actions={
                <div className="workspace-header-actions">
                  <Button
                    variant="ghost"
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
                  </Button>
                  {studio.status?.images?.length ? <Button variant="primary"
                    onClick={newThread}
                  >
                    <Plus size={14} aria-hidden="true" />
                    Create image
                  </Button> : null}
                </div>
              } />
              <OutputWorkspace
                key={`library-${studio.resetRevision}`}
                stateKey={`library-${studio.resetRevision}`}
                onDelete={deleteImage}
                onOpenImage={openImage}
                mode="library"
                onCreateImage={newThread}
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

          {studio.error && activeSection !== "tts" && activeSection !== "text" && activeSection !== "video" && !startupDialogOpen && (
            <div className="dashboard-error" role="alert">
              {studio.error}
              {studio.status?.job.model === "9b" &&
              /memory|allocation|out of resources/i.test(studio.error) ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    studio.updateSettings({ model: "4b" });
                    studio.dismissError();
                  }}
                >
                  Use Klein 4B for retry
                </Button>
              ) : null}
              <IconButton onClick={studio.dismissError} aria-label="Dismiss error">
                ×
              </IconButton>
            </div>
          )}
        </main>
      </div>

      {startupDialogOpen ? (
        <RuntimeLoadingDialog
          onDismiss={() => setRuntimeDismissed(true)}
          runtime={studio.runtimeStatus}
          connecting={studio.connecting || !studio.ready || !studio.status}
          connectionError={connectionError}
          onRetry={() => void studio.retryRuntime()}
          onOpenPreferences={() => {
            setRuntimeDismissed(true);
            openPreferences();
          }}
        />
      ) : null}

      {lightboxImage && (
        <Lightbox
          image={lightboxImage}
          images={viewerImages}
          onSelect={setLightboxImage}
          onRemix={activeSection === "text" ? remixInNewThread : remixImage}
          onRemixInNewThread={remixInNewThread}
          onDelete={deleteImage}
          onClose={() => setLightboxImage(null)}
        />
      )}
      {threadSearch ? <ThreadBrowser
        threads={searchableThreads}
        searchSession={threadSearchSession}
        initialQuery={threadSearch.query}
        scope={threadSearch.scope}
        onOpen={(id, query) => {
          onSidebarNavigate();
          openThread(id);
          setChatFindRequest(query && id.startsWith("text-thread-") ? { threadId: id, query } : null);
        }}
        onClose={() => setThreadSearch(null)}
      /> : null}
      {runtimeDismissed && !studio.running && (connectionError || showImageRuntimeStatus) ? (
        <div className="runtime-banner" role="status">
          <span>
            {connectionStatus ?? (studio.status?.model.checking
              ? studio.status.model.runtimeNote
              : studio.runtimeStatus?.message ?? "Generation is unavailable.")}
          </span>
          <button type="button" onClick={() => setRuntimeDismissed(false)}>
            {connectionError || connectionPending ? "Connection details" : "Generation status"}
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
      {modelSetup && activeSection !== "models" && !studio.running && !text.busy &&
        (modelSetup.task === "image"
          ? activeSection !== "create" || studio.activeThread.id !== modelSetup.threadId
          : activeSection !== "text" || text.activeThread.id !== modelSetup.threadId) ? (
        <div className="runtime-banner model-setup-return">
          <span>Model setup</span>
          <button type="button" onClick={() => returnToDraft()}>Return to draft</button>
        </div>
      ) : null}
      {commandPaletteOpen && <CommandPalette
        threads={searchableThreads}
        onOpenThread={openThread}
        onOpenThreadSearch={searchThreadsByQuery}
        running={studio.running}
        audioRunning={tts.status.status === "running" || tts.status.status === "setting_up" || tts.status.status === "stopping"}
        textRunning={text.status.job.status === "running" || text.threads.some((thread) => !!thread.pendingJobId)}
        sidebarCollapsed={sidebarIsCollapsed}
        onClose={() => setCommandPaletteOpen(false)}
        onNewRender={newThread}
        onNewAudio={newAudioThread}
        onNewText={newTextThread}
        onOpenAudio={() => setActiveSection("tts")}
        onOpenVideo={openVideo}
        videoRunning={video.running}
        onStopVideo={() => void video.update("stop")}
        onOpenText={() => setActiveSection("text")}
        onExportChat={activeSection === "text" && text.activeThread.messages.length
          ? (destination) => void text.exportTranscript(text.activeThread.id, destination) : undefined}
        onOpenLibrary={openLibrary}
        onOpenData={openStorage}
        onOpenPreferences={openPreferences}
        onToggleTheme={toggleTheme}
        onToggleSidebar={toggleSidebar}
        onStop={() => void studio.stopGeneration()}
        onStopAudio={() => void tts.stopJob()}
        onStopText={() => void text.stop(text.status.job.threadId ?? text.activeThread.id)}
      />}
    </div>
  );
}
