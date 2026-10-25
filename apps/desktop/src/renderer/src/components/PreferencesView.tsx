import Check from "lucide-react/dist/esm/icons/check.mjs";
import Command from "lucide-react/dist/esm/icons/command.mjs";
import Cpu from "lucide-react/dist/esm/icons/cpu.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import type { ModelStatus } from "../lib/types";
import type { ComputePreference } from "../hooks/useComputePreference";

interface PreferencesViewProps {
  active: boolean;
  theme: "light" | "dark";
  sidebarCollapsed: boolean;
  modelStatus: ModelStatus | null;
  allowCpu: boolean;
  computeDevice: ComputePreference;
  onAllowCpuChange: (allow: boolean) => void;
  onComputeDeviceChange: (device: ComputePreference) => void;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
}

function deviceLabel(device: string | undefined): string {
  switch (device) {
    case "INTEL_GPU":
      return "Intel GPU";
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
  if (!adapter.runtimeReady) return "Model missing";
  return "Ready";
}

export function PreferencesView({
  active,
  theme,
  sidebarCollapsed,
  modelStatus,
  allowCpu,
  computeDevice,
  onAllowCpuChange,
  onComputeDeviceChange,
  onToggleTheme,
  onToggleSidebar,
}: PreferencesViewProps) {
  if (!active) return null;

  return (
    <section
      className="shell-page preferences-view"
      aria-labelledby="preferences-view-title"
    >
      <header className="shell-page-header">
        <div>
          <h2 tabIndex={-1} id="preferences-view-title">
            Preferences
          </h2>
          <p>Appearance, workspace, and application settings.</p>
        </div>
      </header>

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
            <button
              type="button"
              className={`preference-choice ${theme === "dark" ? "is-selected" : ""}`}
              onClick={() => {
                if (theme !== "dark") onToggleTheme();
              }}
              aria-pressed={theme === "dark"}
            >
              <span className="preference-choice-preview preference-choice-preview--dark" />
              <span>
                <strong>Dark</strong>
                <small>Low-glare charcoal surfaces</small>
              </span>
              {theme === "dark" ? <Check size={15} aria-hidden="true" /> : null}
            </button>
            <button
              type="button"
              className={`preference-choice ${theme === "light" ? "is-selected" : ""}`}
              onClick={() => {
                if (theme !== "light") onToggleTheme();
              }}
              aria-pressed={theme === "light"}
            >
              <span className="preference-choice-preview preference-choice-preview--light" />
              <span>
                <strong>Light</strong>
                <small>Bright neutral surfaces</small>
              </span>
              {theme === "light" ? (
                <Check size={15} aria-hidden="true" />
              ) : null}
            </button>
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
          <button
            type="button"
            className="preference-toggle-row"
            onClick={onToggleSidebar}
            aria-pressed={!sidebarCollapsed}
          >
            <span className="preference-row-icon">
              <PanelLeft size={15} aria-hidden="true" />
            </span>
            <span className="preference-row-copy">
              <strong>Persistent sidebar</strong>
              <small>
                {sidebarCollapsed
                  ? "Collapsed to an icon rail"
                  : "Showing navigation and threads"}
              </small>
            </span>
            <span
              className={`preference-switch ${sidebarCollapsed ? "" : "is-on"}`}
              aria-hidden="true"
            >
              <span />
            </span>
          </button>
        </section>

        <section
          className="preferences-section"
          aria-labelledby="preferences-runtime"
        >
          <div className="preferences-section-heading">
            <div>
              <h3 id="preferences-runtime">Compute & image runtime</h3>
              <p>The compute choice applies to image, text, and audio generation. GPU is the default.</p>
            </div>
            <Cpu size={17} aria-hidden="true" />
          </div>
          <button
            type="button"
            className="preference-toggle-row"
            onClick={() => onAllowCpuChange(!allowCpu)}
            aria-pressed={allowCpu}
          >
            <span className="preference-row-icon"><Cpu size={15} aria-hidden="true" /></span>
            <span className="preference-row-copy">
              <strong>Allow CPU selection</strong>
              <small>{allowCpu ? "CPU is available below; GPU remains selected until you change it." : "CPU is hidden and cannot be selected. Fern uses an available GPU."}</small>
            </span>
            <span className={`preference-switch ${allowCpu ? "is-on" : ""}`} aria-hidden="true"><span /></span>
          </button>
          {allowCpu ? (
            <label className="field preference-compute-device">
              <span>Generation device</span>
              <select aria-label="Generation device" value={computeDevice} onChange={(event) => onComputeDeviceChange(event.target.value as ComputePreference)}>
                <option value="GPU">Available GPU</option>
                <option value="CPU">CPU</option>
              </select>
            </label>
          ) : null}
          <div className="preferences-runtime-grid">
            <div>
              <span>Model</span>
              <strong>{modelStatus?.modelId ?? "Flux.2 Klein 9B"}</strong>
            </div>
            <div>
              <span>Device</span>
              <strong>{computeDevice === "CPU" ? "CPU" : deviceLabel(modelStatus?.selectedDevice)}</strong>
            </div>
            <div>
              <span>Backend</span>
              <strong>{modelStatus?.runtimeBackend ?? "OpenVINO"}</strong>
            </div>
            <div>
              <span>Reference images</span>
              <strong>
                {modelStatus?.supportsReferenceImage === false
                  ? "Unavailable"
                  : "Supported"}
              </strong>
            </div>
          </div>
          <div
            className="preferences-adapters"
            aria-label="Device availability"
          >
            {(modelStatus?.adapters ?? []).filter((adapter) => adapter.id !== "CPU" || allowCpu).map((adapter) => {
              const state = adapterState(adapter);
              return (
                <div
                  key={adapter.id}
                  className={`preferences-adapter-row${state === "Ready" ? " is-ready" : ""}`}
                  aria-label={`${adapter.label}: ${state}`}
                >
                  <span
                    className="preferences-adapter-dot"
                    aria-hidden="true"
                  />
                  <span className="preferences-adapter-copy">
                    <strong>{adapter.label}</strong>
                    <small>{adapter.runtimeBackend ?? "OpenVINO"}</small>
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
              <p>Move between image and audio workspaces quickly.</p>
            </div>
            <Command size={17} aria-hidden="true" />
          </div>
          <div className="shortcut-list">
            <div>
              <span>Open commands</span>
              <span className="kbd">Ctrl K</span>
            </div>
            <div>
              <span>New image thread</span>
              <span className="kbd">Ctrl N</span>
            </div>
            <div><span>New audio thread</span><span className="kbd">Ctrl Shift N</span></div>
            <div>
              <span>Open library</span>
              <span className="kbd">Ctrl L</span>
            </div>
            <div>
              <span>Toggle sidebar</span>
              <span className="kbd">Ctrl B</span>
            </div>
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
