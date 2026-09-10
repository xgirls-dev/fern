import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearLocalData,
  deleteThreadAssets,
  invalidateImages,
  resolveAssetUrl,
  fetchStatus,
  setApiBaseUrl,
  startGeneration,
  stopGeneration as requestStopGeneration,
} from "../lib/api";
import {
  createImageThread,
  loadThreadWorkspace,
  readThreadReference,
  saveThreadWorkspace,
  threadTitle,
  writeThreadReference,
  type ThreadWorkspace,
} from "../lib/threads";
import type {
  DeviceId,
  FluxStatusResponse,
  GenerationPayload,
  ImageRecord,
  StudioSettings,
} from "../lib/types";

import { notify } from "../lib/notifications";

const SETTINGS_KEY = "fern-studio-settings:v3";
const LEGACY_SETTINGS_KEYS = [
  "iris-studio-settings:v2",
  "iris-studio-settings",
];

const DEFAULT_SETTINGS: StudioSettings = {
  prompt: "",
  device: "AUTO",
  width: 1024,
  height: 1024,
  steps: 4,
  guidance: 1,
  seed: 42,
  batchSize: 1,
  seedLocked: false,
  theme: "light",
};

function normalizeDevice(value: unknown): DeviceId {
  switch (
    String(value ?? "")
      .trim()
      .toUpperCase()
  ) {
    case "GPU":
    case "INTEL":
    case "INTEL_GPU":
    case "OPENVINO_GPU":
      return "INTEL_GPU";
    case "NVIDIA":
    case "CUDA":
    case "NVIDIA_GPU":
      return "NVIDIA_GPU";
    case "CPU":
      return "CPU";
    case "AUTO":
      return "AUTO";
    default:
      return "AUTO";
  }
}

function loadSettings(): StudioSettings {
  try {
    const raw =
      localStorage.getItem(SETTINGS_KEY) ??
      LEGACY_SETTINGS_KEYS.map((key) => localStorage.getItem(key)).find(
        Boolean,
      );
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<StudioSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    const settings: StudioSettings = {
      prompt: merged.prompt,
      device: normalizeDevice(merged.device),
      width: merged.width,
      height: merged.height,
      steps: merged.steps,
      guidance: merged.guidance,
      seed: merged.seed,
      batchSize: merged.batchSize,
      seedLocked: merged.seedLocked,
      theme: merged.theme,
    };
    saveSettings(settings);
    for (const key of LEGACY_SETTINGS_KEYS) localStorage.removeItem(key);
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: StudioSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // The app remains usable if storage is unavailable or full.
  }
}

function clearStoredSettings(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    );
    for (const key of keys) {
      if (key?.startsWith("fern-") || key?.startsWith("iris-")) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Reset still clears backend-managed data when browser storage is unavailable.
  }
}

function normalizeStartedAt(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value > 1e12 ? value / 1000 : value;
}

function elapsedSeconds(startedAt: number | null): number {
  if (startedAt == null) return 0;
  return Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
}

function imageRecordChanged(previous: ImageRecord, next: ImageRecord): boolean {
  return (
    previous.mtime !== next.mtime ||
    previous.url !== next.url ||
    previous.prompt !== next.prompt ||
    previous.seed !== next.seed ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.steps !== next.steps ||
    previous.guidance !== next.guidance ||
    previous.device !== next.device ||
    previous.generationTime !== next.generationTime
  );
}

const BACKEND_CONNECT_TIMEOUT_MS = 90_000;
const BACKEND_CONNECT_INTERVAL_MS = 500;

export function useStudio() {
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [workspace, setWorkspace] = useState(() =>
    loadThreadWorkspace(loadSettings()),
  );
  const activeThread = workspace.threads.find(
    (thread) => thread.id === workspace.activeId,
  )!;
  const settings = activeThread.settings;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [status, setStatus] = useState<FluxStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceDirty = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [referenceImage, setReferenceImageState] = useState("");
  const referenceLabel = activeThread.referenceLabel;
  const [referenceLoading, setReferenceLoading] = useState(true);
  const referenceRevision = useRef(0);
  const [preview, setPreviewState] = useState<ImageRecord | null>(null);
  const [previewedJobId, setPreviewedJobId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const [localStartedAt, setLocalStartedAt] = useState<number | null>(null);
  const [resetRevision, setResetRevision] = useState(0);
  const settingsRef = useRef(settings);
  const previewRef = useRef(preview);
  const previewedJobIdRef = useRef(previewedJobId);
  const previousJobStatusRef = useRef<string>("idle");
  const refreshingRef = useRef(false);
  settingsRef.current = settings;
  previewRef.current = preview;
  previewedJobIdRef.current = previewedJobId;

  const commitWorkspace = useCallback(
    (update: (current: ThreadWorkspace) => ThreadWorkspace) => {
      const next = update(workspaceRef.current);
      workspaceRef.current = next;
      setWorkspace(next);
      workspaceDirty.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        try {
          saveThreadWorkspace(workspaceRef.current);
          saveSettings(settingsRef.current);
          workspaceDirty.current = false;
          setPersistenceError(null);
        } catch {
          setPersistenceError(
            "Could not save your threads. Free local storage before closing Fern.",
          );
        }
      }, 250);
    },
    [],
  );
  useEffect(() => {
    const flush = () => {
      if (!workspaceDirty.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      try {
        saveThreadWorkspace(workspaceRef.current);
        saveSettings(settingsRef.current);
        workspaceDirty.current = false;
      } catch {
        setPersistenceError(
          "Could not save your threads. Free local storage before closing Fern.",
        );
      }
    };
    window.addEventListener("pagehide", flush);
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  const updateThreadSettings = useCallback(
    (id: string, patch: Partial<StudioSettings>) => {
      commitWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) => {
          if (thread.id !== id)
            return patch.theme
              ? {
                  ...thread,
                  settings: { ...thread.settings, theme: patch.theme },
                }
              : thread;
          const nextSettings = { ...thread.settings, ...patch };
          return {
            ...thread,
            settings: nextSettings,
            updatedAt: thread.updatedAt,
            title: thread.title,
          };
        }),
      }));
    },
    [commitWorkspace],
  );

  const updateSettings = useCallback(
    (
      patch: Partial<StudioSettings>,
      threadId = workspaceRef.current.activeId,
    ) => {
      setFieldErrors((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !(key in patch)),
        ),
      );
      setError(null);
      updateThreadSettings(threadId, patch);
    },
    [updateThreadSettings],
  );

  useEffect(() => {
    const id = activeThread.id;
    const revision = ++referenceRevision.current;
    setReferenceImageState("");
    setReferenceLoading(true);
    readThreadReference(id)
      .then((image) => {
        if (
          workspaceRef.current.activeId === id &&
          referenceRevision.current === revision
        )
          setReferenceImageState(image);
      })
      .catch(() => {
        if (workspaceRef.current.activeId === id)
          setError(
            "Could not restore this thread's reference image. Attach it again before generating.",
          );
      })
      .finally(() => {
        if (
          workspaceRef.current.activeId === id &&
          referenceRevision.current === revision
        )
          setReferenceLoading(false);
      });
  }, [activeThread.id]);

  const setReferenceImage = useCallback(
    (image: string) => {
      const id = activeThread.id;
      if (workspaceRef.current.activeId !== id) return;
      ++referenceRevision.current;
      setReferenceImageState(image);
      setReferenceLoading(false);
      void writeThreadReference(id, image).catch(() =>
        setError("Could not save the reference image for this thread."),
      );
    },
    [activeThread.id],
  );

  const setReferenceLabel = useCallback(
    (label: string) => {
      if (workspaceRef.current.activeId !== activeThread.id) return;
      commitWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === current.activeId
            ? { ...thread, referenceLabel: label }
            : thread,
        ),
      }));
    },
    [activeThread.id, commitWorkspace],
  );

  const setPreview = useCallback(
    (image: ImageRecord | null) => {
      setPreviewState(image);
      commitWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === current.activeId
            ? {
                ...thread,
                previewName: image?.name ?? null,
                imageNames: image
                  ? [...new Set([...thread.imageNames, image.name])]
                  : thread.imageNames,
              }
            : thread,
        ),
      }));
    },
    [commitWorkspace],
  );

  const selectThread = useCallback(
    (id: string) => {
      const thread = workspaceRef.current.threads.find(
        (candidate) => candidate.id === id,
      );
      if (!thread || id === workspaceRef.current.activeId) return;
      commitWorkspace((current) => ({ ...current, activeId: id }));
      setPreviewState(null);
      setReferenceImageState("");
      setReferenceLoading(true);
      setError(null);
    },
    [commitWorkspace],
  );

  const newThread = useCallback(() => {
    const current = workspaceRef.current;
    const previous = current.threads.find(
      (thread) => thread.id === current.activeId,
    )!;
    const thread = createImageThread(previous.settings);
    commitWorkspace((value) => ({
      ...value,
      activeId: thread.id,
      threads: [thread, ...value.threads],
    }));
    setPreviewState(null);
    setReferenceImageState("");
    setReferenceLoading(true);
    setError(null);
    return thread.id;
  }, [commitWorkspace]);

  const renameThread = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim().slice(0, 80);
      if (!trimmed) return;
      commitWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === id
            ? { ...thread, title: trimmed, renamed: true }
            : thread,
        ),
      }));
    },
    [commitWorkspace],
  );

  const deleteThread = useCallback(
    async (id: string) => {
      if (
        submitting ||
        (status?.job.status === "running" && status.job.threadId === id)
      )
        return false;
      const removed = workspaceRef.current.threads.find(
        (thread) => thread.id === id,
      );
      if (!removed) return false;
      try {
        const names = await deleteThreadAssets(id, removed.imageNames);
        await writeThreadReference(id, "");
        commitWorkspace((current) => {
          const remaining = current.threads
            .filter((thread) => thread.id !== id)
            .map((thread) => ({
              ...thread,
              imageNames: thread.imageNames.filter(
                (name) => !names.includes(name),
              ),
              previewName: names.includes(thread.previewName ?? "")
                ? null
                : thread.previewName,
            }));
          if (!remaining.length)
            remaining.push(
              createImageThread({
                ...DEFAULT_SETTINGS,
                theme: removed.settings.theme,
              }),
            );
          return {
            activeId:
              current.activeId === id ? remaining[0].id : current.activeId,
            threads: remaining,
          };
        });
        setStatus((current) =>
          current
            ? {
                ...current,
                images: current.images.filter(
                  (image) => !names.includes(image.name),
                ),
                job:
                  current.job.threadId === id
                    ? { ...current.job, threadId: null, output: null, logs: [] }
                    : current.job,
              }
            : current,
        );
        if (names.includes(previewRef.current?.name ?? ""))
          setPreviewState(null);
        return true;
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message
            : "Could not delete this thread. Try again.",
          "error",
        );
        return false;
      }
    },
    [commitWorkspace, status?.job.status, status?.job.threadId, submitting],
  );

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;

    try {
      const data = await fetchStatus(settingsRef.current.device);
      setStatus(data);
      setConnectionError(null);

      const selected = workspaceRef.current.threads.find(
        (thread) => thread.id === workspaceRef.current.activeId,
      )!;
      const images = data.images.filter(
        (image) =>
          image.threadId === selected.id ||
          selected.imageNames.includes(image.name),
      );
      const output = data.job.output;
      if (output && data.job.id !== previewedJobIdRef.current) {
        if (output.threadId) {
          commitWorkspace((current) => ({
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === output.threadId
                ? { ...thread, previewName: output.name, updatedAt: Date.now() }
                : thread,
            ),
          }));
        }
        setPreviewedJobId(data.job.id ?? "");
        if (output.threadId === selected.id) {
          setPreviewState(output);
          return true;
        }
      }
      const currentPreview = previewRef.current;
      const refreshed = images.find(
        (image) => image.name === currentPreview?.name,
      );
      if (refreshed && currentPreview) {
        if (imageRecordChanged(currentPreview, refreshed))
          setPreviewState(refreshed);
      } else if (
        output?.threadId !== selected.id ||
        data.job.id === previewedJobIdRef.current
      ) {
        setPreviewState(
          images.find((image) => image.name === selected.previewName) ??
            images[0] ??
            null,
        );
      }
      return true;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Status refresh failed";
      setConnectionError((current) =>
        current === message ? current : message,
      );
      return false;
    } finally {
      refreshingRef.current = false;
    }
  }, [commitWorkspace]);

  const connectBackend = useCallback(async () => {
    setConnecting(true);
    setError(null);

    const deadline = Date.now() + BACKEND_CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if (await refresh()) {
          setConnecting(false);
          return true;
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Backend connection failed";
        if (
          !message.includes("fetch") &&
          !message.includes("Failed to fetch")
        ) {
          setError(message);
          setConnecting(false);
          return false;
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, BACKEND_CONNECT_INTERVAL_MS),
      );
    }

    setConnecting(false);
    setError(
      "Timed out waiting for the Fern AI backend. Quit other Fern instances and try again.",
    );
    return false;
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      try {
        const url = await window.studio.getApiBaseUrl();
        if (cancelled) return;
        setApiBaseUrl(url);
        setReady(true);
        await connectBackend();
      } catch (err) {
        if (cancelled) return;
        setReady(true);
        setError(err instanceof Error ? err.message : "Backend startup failed");
      }
    };

    void boot();
    const unsubscribeUrl = window.studio.onApiBaseUrl((url) => {
      setApiBaseUrl(url);
      setReady(true);
      void connectBackend();
    });
    const unsubscribeError = window.studio.onBackendError((message) => {
      setReady(true);
      setConnecting(false);
      setError(message);
    });

    return () => {
      cancelled = true;
      unsubscribeUrl();
      unsubscribeError();
    };
  }, [connectBackend]);

  const running = status?.job.status === "running";
  const runtimeStatus = status?.runtime ?? null;
  const runtimeLoading =
    runtimeStatus?.status === "pending" || runtimeStatus?.status === "loading";
  const runtimeNeedsAttention =
    runtimeStatus?.status === "blocked" || runtimeStatus?.status === "failed";
  const runtimeDialogOpen = runtimeLoading || runtimeNeedsAttention;

  useEffect(() => {
    if (!ready) return;
    const intervalMs = running ? 750 : 3000;
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [ready, refresh, running]);

  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh, settings.device, activeThread.id]);

  useEffect(() => {
    if (running) return;
    setLocalStartedAt(null);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClockTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const jobStatus = status?.job.status;
    if (!jobStatus) return;
    const previousStatus = previousJobStatusRef.current;
    if (previousStatus === "running" && jobStatus === "cancelled") {
      const title =
        workspaceRef.current.threads.find(
          (thread) => thread.id === status.job.threadId,
        )?.title ?? "Thread";
      notify(`${title}: generation stopped.`, "info");
    } else if (previousStatus === "running" && jobStatus === "complete") {
      const title =
        workspaceRef.current.threads.find(
          (thread) => thread.id === status.job.threadId,
        )?.title ?? "Thread";
      notify(`${title}: generation complete.`, "success", {
        label: "View images",
        run: () =>
          window.dispatchEvent(
            new CustomEvent("fern-open-thread", {
              detail: status.job.threadId,
            }),
          ),
      });
    } else if (previousStatus === "running" && jobStatus === "failed") {
      const title =
        workspaceRef.current.threads.find(
          (thread) => thread.id === status.job.threadId,
        )?.title ?? "Thread";
      notify(`${title}: ${status.job.error ?? "Generation failed."}`, "error", {
        label: "View thread",
        run: () =>
          window.dispatchEvent(
            new CustomEvent("fern-open-thread", {
              detail: status.job.threadId,
            }),
          ),
      });
    }
    previousJobStatusRef.current = jobStatus;
  }, [status?.job.error, status?.job.status]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        settings.theme === "dark" ? "#171717" : "#f3f3f3",
      );
    void window.studio.setTheme(settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    const unsubscribe = window.studio.onThemeChanged((theme) => {
      updateSettings({ theme });
    });
    return unsubscribe;
  }, [updateSettings]);

  const modelInstalled = status?.model.runtimeReady ?? false;

  const retryRuntime = useCallback(async () => {
    setError(null);
    setNotice(null);
    await refresh();
  }, [refresh]);

  const chooseDevice = useCallback(
    (device: DeviceId) => {
      updateSettings({ device });
      setError(null);
      setNotice(null);
    },
    [updateSettings],
  );

  const generate = useCallback(async () => {
    if (submitting || running || referenceLoading) return;
    const generationThreadId = workspaceRef.current.activeId;
    if (!settings.prompt.trim()) {
      setError("Prompt is required.");
      return;
    }
    const invalid: Record<string, string> = {};
    for (const key of ["width", "height"] as const) {
      const value = settings[key];
      if (
        !Number.isInteger(value) ||
        value < 256 ||
        value > 1920 ||
        value % 16 !== 0
      )
        invalid[key] = "Use a multiple of 16 between 256 and 1920.";
    }
    if (
      !Number.isInteger(settings.steps) ||
      settings.steps < 1 ||
      settings.steps > 50
    )
      invalid.steps = "Use 1–50 whole steps.";
    if (
      !Number.isFinite(settings.guidance) ||
      settings.guidance < 0 ||
      settings.guidance > 10
    )
      invalid.guidance = "Use guidance from 0 to 10.";
    if (!Number.isSafeInteger(settings.seed))
      invalid.seed = "Use a whole-number seed.";
    if (
      !Number.isInteger(settings.batchSize) ||
      settings.batchSize < 1 ||
      settings.batchSize > 4
    )
      invalid.batchSize = "Choose 1–4 images.";
    setFieldErrors(invalid);
    if (Object.keys(invalid).length) {
      window.dispatchEvent(
        new CustomEvent("fern-validation", { detail: Object.keys(invalid)[0] }),
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);
    setLocalStartedAt(Date.now() / 1000);

    const payload: GenerationPayload = {
      thread_id: generationThreadId,
      prompt: settings.prompt.trim(),
      device: settings.device,
      width: settings.width,
      height: settings.height,
      steps: settings.steps,
      guidance: settings.guidance,
      seed: settings.seedLocked
        ? settings.seed
        : Math.floor(Math.random() * 1_000_000_000),
      batch_size: settings.batchSize,
    };

    if (referenceImage) {
      payload.reference_image = referenceImage;
    }

    try {
      await startGeneration(payload);
      commitWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === generationThreadId && !thread.renamed
            ? { ...thread, title: threadTitle(payload.prompt), renamed: true }
            : thread,
        ),
      }));
      if (!settings.seedLocked) {
        updateThreadSettings(generationThreadId, {
          seed: Math.floor(Math.random() * 1_000_000_000),
        });
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setSubmitting(false);
    }
  }, [
    referenceImage,
    referenceLoading,
    commitWorkspace,
    refresh,
    running,
    settings,
    submitting,
    updateThreadSettings,
  ]);

  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);

  const stopGeneration = useCallback(async () => {
    if (!running || stopping) return;
    setStopping(true);
    setError(null);
    setNotice("Stopping generation...");
    try {
      await requestStopGeneration();
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not stop generation",
      );
      setStopping(false);
    }
  }, [refresh, running, stopping]);

  const dismissNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const remixImage = useCallback(
    async (image: ImageRecord) => {
      const source = workspaceRef.current.threads.find(
        (thread) => thread.id === image.threadId,
      );
      const thread = createImageThread({
        ...settingsRef.current,
        prompt: image.prompt ?? "",
        seed: image.seed ?? 42,
        seedLocked: true,
        width: image.width ?? 1024,
        height: image.height ?? 1024,
        steps: image.steps ?? 4,
        guidance: image.guidance ?? 1,
        device: normalizeDevice(image.device),
        batchSize: 1,
      });
      thread.settings.prompt = image.prompt ?? "";
      thread.title = `${threadTitle(image.prompt ?? source?.title ?? "Image")} · variation`;
      thread.renamed = true;
      thread.imageNames = [image.name];
      thread.previewName = image.name;
      if (image.referenceUrl) {
        try {
          const response = await fetch(resolveAssetUrl(image.referenceUrl));
          if (!response.ok) throw new Error("Reference unavailable");
          const blob = await response.blob();
          const url = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          await writeThreadReference(thread.id, url);
          thread.referenceLabel = "Original render reference";
        } catch {
          notify(
            "Original reference could not be restored. Attach it before generating this variation.",
            "error",
          );
        }
      } else if (image.referenceUsed !== false) {
        notify(
          "Reference history is unavailable for this image. The variation starts without a reference.",
          "info",
        );
      }
      commitWorkspace((current) => ({
        ...current,
        activeId: thread.id,
        threads: [thread, ...current.threads],
      }));
      setReferenceImageState("");
      setReferenceLoading(true);
      setPreviewState(image);
      setError(null);
    },
    [commitWorkspace],
  );

  const archiveThread = useCallback(
    (id: string) => {
      commitWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === id ? { ...thread, archived: !thread.archived } : thread,
        ),
      }));
    },
    [commitWorkspace],
  );

  const deleteImage = useCallback(
    async (image: ImageRecord) => {
      await window.studio.deleteOutputImage(image.name);
      invalidateImages();
      setStatus((current) =>
        current
          ? {
              ...current,
              images: current.images.filter((item) => item.name !== image.name),
              job: {
                ...current.job,
                output:
                  current.job.output?.name === image.name
                    ? null
                    : current.job.output,
              },
            }
          : current,
      );
      commitWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) => ({
          ...thread,
          imageNames: thread.imageNames.filter((name) => name !== image.name),
          previewName:
            thread.previewName === image.name ? null : thread.previewName,
        })),
      }));
      if (previewRef.current?.name === image.name) setPreviewState(null);
      await refresh();
    },
    [commitWorkspace, refresh],
  );

  const resetLocalData = useCallback(async () => {
    if (running || submitting) {
      throw new Error("Wait for the current generation to finish.");
    }
    await Promise.all([
      clearLocalData(),
      writeThreadReference(null, ""),
      window.studio.clearWebCache().catch(() => undefined),
    ]);
    clearStoredSettings();
    const thread = createImageThread({
      ...DEFAULT_SETTINGS,
      theme: settingsRef.current.theme,
    });
    commitWorkspace(() => ({ activeId: thread.id, threads: [thread] }));
    setReferenceImageState("");
    setPreviewState(null);
    setPreviewedJobId("");
    setError(null);
    setNotice(null);
    setResetRevision((value) => value + 1);
    await refresh();
  }, [commitWorkspace, refresh, running, submitting]);

  const stateLabel = useMemo(() => {
    if (runtimeLoading) return "Loading Model";
    if (runtimeNeedsAttention) return "Needs Attention";
    if (running) {
      const startedAt =
        normalizeStartedAt(status?.job.startedAt) ??
        normalizeStartedAt(localStartedAt);
      if (startedAt != null) {
        return `Generating ${elapsedSeconds(startedAt)}s`;
      }
      return "Generating";
    }
    if (!modelInstalled) return "Model Missing";
    return "Ready";
  }, [
    clockTick,
    localStartedAt,
    modelInstalled,
    running,
    runtimeLoading,
    runtimeNeedsAttention,
    status?.job.startedAt,
  ]);

  const threadImages = useMemo(
    () =>
      (status?.images ?? []).filter(
        (image) =>
          image.threadId === activeThread.id ||
          activeThread.imageNames.includes(image.name),
      ),
    [status?.images, activeThread.id, activeThread.imageNames],
  );
  const navigationCache = useRef<
    Array<Pick<typeof activeThread, "id" | "title" | "archived" | "updatedAt">>
  >([]);
  const threads = useMemo(() => {
    const next = workspace.threads
      .map(({ id, title, archived, updatedAt }) => ({
        id,
        title,
        archived,
        updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const previous = navigationCache.current;
    if (
      previous.length === next.length &&
      next.every(
        (thread, index) =>
          thread.id === previous[index].id &&
          thread.title === previous[index].title &&
          thread.archived === previous[index].archived &&
          thread.updatedAt === previous[index].updatedAt,
      )
    )
      return previous;
    navigationCache.current = next;
    return next;
  }, [workspace.threads]);

  return {
    threads,
    activeThread,
    threadImages,
    activeThreadRunning: running && status?.job.threadId === activeThread.id,
    referenceLoading,
    newThread,
    selectThread,
    renameThread,
    deleteThread,
    ready,
    connecting,
    settings,
    updateSettings,
    status,
    error: persistenceError ?? connectionError ?? error,
    fieldErrors,
    dismissError: () => {
      setError(null);
      setConnectionError(null);
      setPersistenceError(null);
    },
    archiveThread,
    deleteImage,
    notice,
    dismissNotice,
    referenceImage,
    setReferenceImage,
    referenceLabel,
    setReferenceLabel,
    preview,
    setPreview,
    submitting,
    stopping,
    running,
    runtimeLoading,
    runtimeNeedsAttention,
    runtimeDialogOpen,
    runtimeStatus,
    modelInstalled,
    stateLabel,
    generate,
    stopGeneration,
    remixImage,
    resetLocalData,
    resetRevision,
    refresh,
    retryRuntime,
    chooseDevice,
    reconnect: connectBackend,
  };
}
