import Check from "lucide-react/dist/esm/icons/check.mjs";
import Command from "lucide-react/dist/esm/icons/command.mjs";
import Cpu from "lucide-react/dist/esm/icons/cpu.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import type { ModelStatus } from "../lib/types";

interface PreferencesViewProps {
  active: boolean;
  theme: "light" | "dark";
  sidebarCollapsed: boolean;
  modelStatus: ModelStatus | null;
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
      return "Auto-select";
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
          <p>Shape the workspace around how you create and review images.</p>
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
              <h3 id="preferences-runtime">Active runtime</h3>
              <p>These values describe the current local generation path.</p>
            </div>
            <Cpu size={17} aria-hidden="true" />
          </div>
          <div className="preferences-runtime-grid">
            <div>
              <span>Model</span>
              <strong>{modelStatus?.modelId ?? "Flux.2 Klein 9B"}</strong>
            </div>
            <div>
              <span>Device</span>
              <strong>{deviceLabel(modelStatus?.selectedDevice)}</strong>
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
            {(modelStatus?.adapters ?? []).map((adapter) => {
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
              <p>Keep your hands on the prompt and canvas.</p>
            </div>
            <Command size={17} aria-hidden="true" />
          </div>
          <div className="shortcut-list">
            <div>
              <span>Open commands</span>
              <span className="kbd">Ctrl K</span>
            </div>
            <div>
              <span>New thread</span>
              <span className="kbd">Ctrl N</span>
            </div>
            <div>
              <span>Open library</span>
              <span className="kbd">Ctrl L</span>
            </div>
            <div>
              <span>Toggle sidebar</span>
              <span className="kbd">Ctrl B</span>
            </div>
            <div>
              <span>Generate</span>
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
