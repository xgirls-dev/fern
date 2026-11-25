import { useEffect, useRef } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Command from "lucide-react/dist/esm/icons/command.mjs";
import Cpu from "lucide-react/dist/esm/icons/cpu.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import type { ModelStatus } from "../lib/types";
import type { ComputePreference } from "../hooks/useComputePreference";
import { resolveTextModel, textModelReadiness, type TextRuntimeStatus, type TextThread } from "../lib/textThreads";
import { Button, ChoiceCard, PageHeader, Select, ToggleRow } from "./ui/controls";
import { chatModelShortcut, shortcutLabel, shortcuts } from "../lib/workspaceNavigation";

interface PreferencesViewProps {
  active: boolean;
  computeFocusRequest: number;
  onReturnToChat?: () => void;
  theme: "light" | "dark";
  sidebarCollapsed: boolean;
  compactLayout: boolean;
  modelStatus: ModelStatus | null;
  chatRuntime: { status: TextRuntimeStatus; thread: TextThread; loaded: boolean; error: string | null };
  onRefreshChatModels: () => Promise<void>;
  onOpenTextModels: () => void;
  computeDevice: ComputePreference;
  onComputeDeviceChange: (device: ComputePreference) => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
}

function deviceLabel(device: string | undefined): string {
  switch (device) {
    case "INTEL_GPU":
      return "Intel GPU";
    case "APPLE_GPU":
      return "Apple GPU";
    case "NVIDIA_GPU":
      return "NVIDIA GPU";
    case "CPU":
      return "CPU";
    default:
      return "Available GPU";
  }
}

function adapterState(
  adapter: NonNullable<ModelStatus["adapters"]>[number],
): string {
  if (!adapter.available) return "Unavailable";
  if (!adapter.runtimeReady) return "Setup required";
  return "Ready";
}

function chatEngineLabel(resident: NonNullable<TextRuntimeStatus["residentModel"]>): string {
  const device = resident.device === "CPU" ? "CPU" : resident.backend === "metal" ? "Apple GPU" : "Intel GPU";
  const backend = { openvino: "OpenVINO", metal: "Metal", vulkan: "Vulkan" }[resident.backend];
  return backend ? `${device} · ${backend}` : device;
}

export function PreferencesView({
  active,
  computeFocusRequest,
  onReturnToChat,
  theme,
  sidebarCollapsed,
  compactLayout,
  modelStatus,
  chatRuntime,
  onRefreshChatModels,
  onOpenTextModels,
  computeDevice,
  onComputeDeviceChange,
  onToggleTheme,
  onToggleSidebar,
}: PreferencesViewProps) {
  const device = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active && computeFocusRequest) device.current?.focus();
  }, [active, computeFocusRequest]);
  useEffect(() => { if (active) void onRefreshChatModels(); }, [active, onRefreshChatModels]);

  if (!active) return null;

  const { status, thread, loaded, error } = chatRuntime;
  const chatModelId = resolveTextModel(status, thread);
  const chatModel = status.models.find((model) => model.id === chatModelId);
  const readiness = chatModel && textModelReadiness({
    ...status, runningModelId: status.job.status === "running" ? status.job.modelId : null,
  }, chatModel);
  const catalogError = error ?? status.registryError;
  const chatStatus = catalogError ? "Could not check chat models" : !loaded ? "Checking chat models…"
    : readiness?.label ?? (chatModelId ? "Files unavailable" : "Choose a chat model");
  const resident = readiness?.resident;
  const chatDetail = catalogError ?? readiness?.detail ?? (resident ? chatEngineLabel(resident) : null);

  return (
    <section
      className="shell-page preferences-view"
      aria-labelledby="preferences-view-title"
    >
      <PageHeader className="shell-page-header" id="preferences-view-title" title="Preferences" description="Appearance, workspace, and application settings." />

      <div className="shell-page-body preferences-body">
        <section
          className="preferences-section"
          aria-labelledby="preferences-appearance"
        >
          <div className="preferences-section-heading">
            <div>
              <h3 id="preferences-appearance">Appearance</h3>
              <p>Choose the surface treatment that is easiest to read.</p>
            </div>
            {theme === "dark" ? (
              <Moon size={17} aria-hidden="true" />
            ) : (
              <Sun size={17} aria-hidden="true" />
            )}
          </div>
          <div className="preference-choice-grid">
            <ChoiceCard
              className="preference-choice"
              selected={theme === "dark"}
              onClick={() => {
                if (theme !== "dark") onToggleTheme();
              }}
            >
              <span className="preference-choice-preview preference-choice-preview--dark" />
              <span>
                <strong>Dark</strong>
                <small>Low-glare charcoal surfaces</small>
              </span>
              {theme === "dark" ? <Check size={15} aria-hidden="true" /> : null}
            </ChoiceCard>
            <ChoiceCard
              className="preference-choice"
              selected={theme === "light"}
              onClick={() => {
                if (theme !== "light") onToggleTheme();
              }}
            >
              <span className="preference-choice-preview preference-choice-preview--light" />
              <span>
                <strong>Light</strong>
                <small>Bright neutral surfaces</small>
              </span>
              {theme === "light" ? (
                <Check size={15} aria-hidden="true" />
              ) : null}
            </ChoiceCard>
          </div>
        </section>

        <section
          className="preferences-section"
          aria-labelledby="preferences-workspace"
        >
          <div className="preferences-section-heading">
            <div>
              <h3 id="preferences-workspace">Workspace</h3>
              <p>Keep navigation visible or give the canvas more room.</p>
            </div>
            <PanelLeft size={17} aria-hidden="true" />
          </div>
          <ToggleRow
            className="preferences-toggle-row"
            icon={<PanelLeft size={15} />}
            title="Persistent sidebar"
            description={compactLayout
              ? sidebarCollapsed ? "Icon rail on wider windows" : "Expanded on wider windows"
              : sidebarCollapsed ? "Collapsed to an icon rail" : "Showing navigation and threads"}
            pressed={!sidebarCollapsed}
            onClick={onToggleSidebar}
          />
        </section>

        <section
          className="preferences-section"
          aria-labelledby="preferences-runtime"
        >
          <div className="preferences-section-heading">
            <div>
              <h3 id="preferences-runtime">Compute</h3>
              <p>The compute choice applies to image, text, and audio generation. Image generation in chat requires a compatible {window.studio.platform === "darwin" ? "Apple" : "Intel"} GPU.</p>
            </div>
            <Cpu size={17} aria-hidden="true" />
          </div>
          <label className="field preference-compute-device">
            <span>Generation device</span>
            <Select<ComputePreference> ref={device} aria-label="Generation device" value={computeDevice}
              options={[{ value: "GPU", label: "Available GPU" }, { value: "CPU", label: "CPU" }]}
              onChange={onComputeDeviceChange} />
          </label>
          {computeDevice === "CPU" ? <p className="model-library-note">Image creation in chat is unavailable with CPU selected.</p> : null}
          {onReturnToChat && <Button variant="ghost" onClick={onReturnToChat}>Return to chat</Button>}
          <section aria-labelledby="preferences-chat-runtime">
            <h4 id="preferences-chat-runtime">Chat runtime</h4>
            <div className="preferences-runtime-grid">
              <div><span>Current chat model</span><strong title={chatModel?.name}>{chatModel?.name ?? (chatModelId ? "Unavailable model" : "No model selected")}</strong></div>
              <div><span>Status</span><strong role="status">{chatStatus}</strong></div>
            </div>
            {chatDetail ? <p className="model-library-note">{chatDetail}</p> : null}
            <Button variant="ghost" onClick={onOpenTextModels}>Manage text models</Button>
          </section>
          <h4>Image workspace runtime</h4>
          <div className="preferences-runtime-grid">
            <div>
              <span>Model</span>
              <strong>{modelStatus?.modelId ?? "Unknown"}</strong>
            </div>
            <div>
              <span>Device</span>
              <strong>{modelStatus?.selectedDevice ? deviceLabel(modelStatus.selectedDevice) : "Unknown"}</strong>
            </div>
            <div>
              <span>Backend</span>
              <strong>{modelStatus?.runtimeBackend ?? "Unknown"}</strong>
            </div>
            <div>
              <span>Reference images</span>
              <strong>
                {modelStatus?.supportsReferenceImage === undefined
                  ? "Unknown"
                  : modelStatus.supportsReferenceImage ? "Supported" : "Unavailable"}
              </strong>
            </div>
          </div>
          <div
            className="preferences-adapters"
            role="group"
            aria-label="Device availability"
          >
            {(modelStatus?.adapters ?? []).map((adapter) => {
              const state = adapterState(adapter);
              return (
                <div
                  key={adapter.id}
                  className={`preferences-adapter-row${state === "Ready" ? " is-ready" : ""}`}
                >
                  <span
                    className="preferences-adapter-dot"
                    aria-hidden="true"
                  />
                  <span className="preferences-adapter-copy">
                    <strong>{adapter.label}</strong>
                    <small>{adapter.runtimeBackend ?? adapter.note ?? "Runtime details unavailable"}</small>
                  </span>
                  <span className="preferences-adapter-state">{state}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section
          className="preferences-section"
          aria-labelledby="preferences-shortcuts"
        >
          <div className="preferences-section-heading">
            <div>
              <h3 id="preferences-shortcuts">Keyboard shortcuts</h3>
              <p>Move between workspaces and find recent threads.</p>
            </div>
            <Command size={17} aria-hidden="true" />
          </div>
          <div className="shortcut-list">
            {[...Object.values(shortcuts), chatModelShortcut].map((shortcut) => <div key={shortcut.label}>
              <span>{shortcut.label}</span>
              <span className="kbd">{shortcutLabel(shortcut)}</span>
            </div>)}
            <div>
              <span>Generate image or speech</span>
              <span>
                <span className="kbd">Ctrl</span>{" "}
                <span className="kbd">Enter</span>
              </span>
            </div>
          </div>
        </section>

        <footer className="data-dialog-footer preferences-footer">
          Settings are stored locally on this device.
        </footer>
      </div>
    </section>
  );
}
