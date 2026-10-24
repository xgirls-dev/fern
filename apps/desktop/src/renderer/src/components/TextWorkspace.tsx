import { useEffect, useRef, useState } from "react";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Send from "lucide-react/dist/esm/icons/arrow-up.mjs";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import Info from "lucide-react/dist/esm/icons/info.mjs";
import { TextMarkdown } from "./TextMarkdown";

import { TextMenu } from "./TextMenu";
import X from "lucide-react/dist/esm/icons/x.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import type { useTextChat } from "../hooks/useTextChat";
import { notify } from "../lib/notifications";

type TextStudio = ReturnType<typeof useTextChat>;

export function TextWorkspace({ studio, sidebarCollapsed = false }: { studio: TextStudio; sidebarCollapsed?: boolean }) {
  const { activeThread, status, statusError, actionError, busy } = studio;
  const visibleError = actionError ?? statusError ?? status.registryError ?? (!status.runtimeAvailable ? status.runtimeError : null);
  const [panel, setPanel] = useState<"settings" | null>(null);
  const openModels = () => { setPanel(null); window.dispatchEvent(new CustomEvent("fern-models", { detail: "text" })); };
  const panelRef = useRef<HTMLElement>(null);
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [infoId, setInfoId] = useState<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runningHere = status.job.status === "running" && status.job.threadId === activeThread?.id;
  const models = status.models;
  const modelOptions = [
    ...models.map(model => ({ value: model.id, label: model.name, description: model.installed ? undefined : "Unavailable", disabled: !model.installed })),
    ...(status.recommendedModels ?? []).filter(model => !models.some(installed => installed.id === model.id))
      .map(model => ({ value: model.id, label: model.name, description: "Not installed", disabled: true })),
  ];
  const installedModels = models.filter((model) => model.installed);
  const preferredModel = installedModels.find((model) => model.id === status.defaultModelId) ?? installedModels[0];
  const selectedModel = activeThread?.modelId ?? preferredModel?.id ?? "";
  const modelAvailable = models.some((model) => model.id === selectedModel && model.installed);
  const lastMessage = activeThread?.messages.at(-1);
  const needsRetry = !!lastMessage && (lastMessage.role === "user" || !lastMessage.content.trim());
  const pinnedToBottom = useRef(true);
  const empty = !activeThread?.messages.length && !runningHere;
  const checking = !studio.statusLoaded && !statusError;
  const pendingHere = !!activeThread?.pendingJobId && !runningHere;
  const unavailableReason = checking ? "Checking local models…" : !modelAvailable ? "Choose an installed model to send" : !status.runtimeAvailable ? "Text runtime unavailable" : needsRetry && !busy ? "Retry the response to continue" : "";
  const activity = studio.modelAction ?? (["downloading", "preparing"].includes(status.modelInstall?.status ?? "") ? status.modelInstall?.phase ?? "Installing model…" : pendingHere ? "Preparing your response…" : busy && !runningHere ? "Another response is running" : "");
  const { selectModel } = studio;

  useEffect(() => {
    if (activeThread && !activeThread.modelId && preferredModel) {
      selectModel(preferredModel.id);
    }
  }, [activeThread?.id, activeThread?.modelId, preferredModel?.id, selectModel]);

  useEffect(() => {
    const element = feedRef.current;
    if (element && pinnedToBottom.current) element.scrollTo({ top: element.scrollHeight, behavior: busy ? "auto" : "smooth" });
  }, [activeThread?.messages.length, status.job.partialText, status.job.status, busy]);
  useEffect(() => {
    pinnedToBottom.current = true;
    setShowScrollButton(false);
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
    if (window.innerWidth > 760 && window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, [activeThread?.id]);

  useEffect(() => {
    const input = inputRef.current;
    if (input) { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
  }, [activeThread?.draft, activeThread?.id]);

  const closePanel = () => {
    setPanel(null);
    panelTrigger.current?.focus();
  };

  useEffect(() => {
    if (panel) panelRef.current?.focus();
  }, [panel]);

  const copyMessage = async (id: string, content: string) => {
    try {
      await window.studio.copyText(content);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => current === id ? null : current), 1300);
    } catch {
      notify("Could not copy the response. Select the text and copy it manually.", "error");
    }
  };

  const submit = () => {
    if (busy || needsRetry || !modelAvailable || !status.runtimeAvailable) return;
    const text = activeThread?.draft ?? "";
    if (!text.trim()) return;
    pinnedToBottom.current = true;
    void studio.send(text);
  };

  if (!activeThread) return null;

  return (
    <section className={`text-workspace${empty ? " text-workspace--empty" : ""}`} aria-label="Text conversation">
      <header className="workspace-header text-header">
        <div className="workspace-heading">
          <h2 title={activeThread.title}>{activeThread.title}</h2>
          <select className={`thread-switcher text-thread-switcher${sidebarCollapsed ? " is-visible" : ""}`} aria-label="Open text thread" value={activeThread.id} onChange={event => studio.selectThread(event.target.value)}>
            {studio.threads.filter(thread => !thread.archived || thread.id === activeThread.id).map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
          </select>
        </div>
        <button ref={panelTrigger} type="button" className="workspace-settings-button" aria-label="Generation settings" aria-expanded={panel !== null} aria-controls={panel ? "text-inspector" : undefined} onClick={() => panel ? closePanel() : setPanel("settings")}><Settings2 size={15} aria-hidden="true" /><span>Chat settings</span></button>
      </header>

      <div className={`text-layout${panel ? " text-layout--inspecting" : ""}`}>
      <div className="text-main">
      <div className="text-conversation" ref={feedRef} onScroll={(event) => { const el = event.currentTarget; pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setShowScrollButton(!pinnedToBottom.current); }} role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
        {!activeThread.messages.length && !runningHere ? (
          <div className="text-empty-state">
            <h3>What can I help with?</h3>
            {checking ? <p role="status">Checking local models…</p> : !installedModels.length && <p>Download a model to start chatting on your device.</p>}
            {!checking && !installedModels.length && <button type="button" className="text-secondary-button" onClick={openModels}><Plus size={16} aria-hidden="true" /> Browse models</button>}

          </div>
        ) : null}

        {activeThread.messages.map((message) => (
          <article className={`text-message text-message--${message.role}`} key={message.id}>
            <div className="text-message-content">{message.role === "user" ? message.content : <TextMarkdown content={message.content} />}</div>
            {message.status === "failed" ? <div className="text-error" role="alert">{message.error ?? "Generation failed. Retry the response."}</div> : null}
            {message.status === "stopped" ? <div className="text-partial-note">Stopped{message.content ? " · Partial response" : " before any text was generated"}</div> : null}
            {message.role === "assistant" && <div className="text-message-tools">
              {message.content.trim() && <button type="button" className="text-icon-button" aria-label={copiedId === message.id ? "Copied" : "Copy message"} title={copiedId === message.id ? "Copied" : "Copy message"} onClick={() => void copyMessage(message.id, message.content)}><Copy size={15} aria-hidden="true" /></button>}
              {message === lastMessage && !busy && <button type="button" className="text-icon-button" aria-label={message.status === "failed" || message.status === "stopped" ? "Retry response" : "Regenerate response"} title="Regenerate response" disabled={!modelAvailable || !status.runtimeAvailable} onClick={() => void studio.retry()}><RotateCcw size={15} aria-hidden="true" /></button>}
              <button type="button" className="text-icon-button" aria-label="Response details" title="Response details" aria-expanded={infoId === message.id} onClick={() => setInfoId(infoId === message.id ? null : message.id)}><Info size={15} aria-hidden="true" /></button>
              {copiedId === message.id && <span role="status">Copied</span>}
            </div>}
            {infoId === message.id && <div className="text-response-details"><span className="text-message-label">{message.modelName ?? message.metrics?.modelName ?? "Local model"}</span>{message.metrics && <span>{message.metrics.device} · {message.metrics.inputTokens} in / {message.metrics.outputTokens} out · {message.metrics.tokensPerSecond.toFixed(1)} tokens/s · {message.metrics.generationSeconds.toFixed(1)} s<br />Temperature {message.metrics.temperature ?? "unknown"} · Top P {message.metrics.topP ?? "unknown"} · Seed {message.metrics.seed ?? "unknown"} · Max tokens {message.metrics.maxNewTokens ?? "unknown"}</span>}</div>}

          </article>
        ))}
        {runningHere ? <article className="text-message text-message--assistant text-message--streaming">
          <div className="text-message-content">{status.job.partialText ? <TextMarkdown content={status.job.partialText} /> : <span className="text-thinking">Thinking…</span>}<span className="text-stream-cursor" aria-hidden="true" /></div>
          {!status.job.partialText && <div className="text-message-tools"><span>{status.job.phase ?? "Preparing your response…"}</span></div>}
        </article> : null}
        {lastMessage?.role === "user" && !busy && <button type="button" className="text-secondary-button text-retry" disabled={!modelAvailable || !status.runtimeAvailable} onClick={() => void studio.retry()}><RotateCcw size={15} aria-hidden="true" />Retry response</button>}

        <div className="text-feed-end" />
      </div>

      <footer className="text-composer-area">
        {showScrollButton && <button type="button" className="text-scroll-latest" aria-label="Jump to latest message" title="Jump to latest message" onClick={() => { pinnedToBottom.current = true; setShowScrollButton(false); feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" }); }}><ArrowDown size={16} aria-hidden="true" /></button>}
        {visibleError ? <div className="text-error" role="alert">{visibleError}<button type="button" onClick={() => { void studio.refresh(); }}>Refresh status</button></div> : null}
        {selectedModel && !modelAvailable ? <div className="text-error" role="alert">{models.find((model) => model.id === selectedModel)?.error ?? "This thread’s model was removed. Add its folder again or select another model."}</div> : null}
        <form className="text-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <textarea
            ref={inputRef}
            aria-label="Message"
            name="message"
            autoComplete="off"
            placeholder={checking ? "Ask anything…" : installedModels.length ? "Ask anything…" : "Download a model to get started"}
            rows={1}
            maxLength={20_000}
            value={activeThread.draft}
            onChange={(event) => studio.updateThread(activeThread.id, { draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="text-composer-bottom">
            <div className="text-composer-model-controls">
            </div>
            <div className="composer-send-tools">
              <TextMenu label="Text model" value={selectedModel} disabled={busy} options={modelOptions} onSelect={studio.selectModel}>
                <button type="button" role="menuitem" onClick={openModels}>Manage models</button>
              </TextMenu>
            {runningHere ? <button type="button" className="composer-submit is-stop" disabled={status.job.status !== "running"} onClick={() => void studio.stop()} aria-label="Stop generation" title="Stop generation"><Square size={14} fill="currentColor" aria-hidden="true" /></button> : <button type="submit" className="composer-submit" disabled={busy || !activeThread.draft.trim() || !modelAvailable || !status.runtimeAvailable || needsRetry} aria-label="Send message" title={activity || unavailableReason || "Send message"}>{studio.submitting || pendingHere ? <LoaderCircle className="spinner" size={16} aria-hidden="true" /> : <Send size={20} aria-hidden="true" />}</button>}
            </div>
          </div>
        </form>
        <div className="text-composer-hint"><span role="status">{activity || unavailableReason || "Your conversations stay on this device"}</span><span className="text-keyboard-hint">{activeThread.draft.length > 18000 ? `${activeThread.draft.length.toLocaleString()} / 20,000` : "Enter to send · Shift + Enter for newline"}</span></div>
      </footer>
      </div>
      {panel && <aside id="text-inspector" className="generation-inspector text-inspector" ref={panelRef} tabIndex={-1} aria-label="Chat settings panel" onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closePanel(); } }}>
        <div className="inspector-heading">
          <div className="inspector-tabs" aria-label="Chat inspector views">
            <button type="button" aria-pressed={panel === "settings"} onClick={() => setPanel("settings")}>Settings</button>
            <button type="button" onClick={openModels}>Manage models</button>
          </div>
          <button type="button" className="btn btn-icon" aria-label="Close chat settings" onClick={closePanel}><X size={16} aria-hidden="true" /></button>
        </div>
        {panel === "settings" && <div className="text-inspector-body">
          <p className="text-panel-description">Settings for this conversation. Changes apply to your next response.</p>
          {busy && <p className="text-panel-description" role="status">{activity || "Settings are locked while a response is generating."}</p>}
          <div className="text-settings-grid">
            <label>Model<select aria-label="Settings model" value={selectedModel} disabled={busy} onChange={event => studio.selectModel(event.target.value)}>{!selectedModel && <option value="">Choose a model</option>}{models.map(model => <option key={model.id} value={model.id} disabled={!model.installed}>{model.name}{model.installed ? "" : " - Unavailable"}</option>)}</select></label>
            <label>Device<select aria-label="Compute device" value={activeThread.device} disabled={busy} onChange={event => studio.setDevice(event.target.value as "AUTO" | "GPU" | "CPU")}><option value="AUTO">Auto - Intel GPU</option><option value="GPU">Intel GPU</option><option value="CPU">CPU</option></select></label>
            <label>System prompt<textarea rows={3} maxLength={10_000} placeholder="Optional instructions for the model" value={activeThread.systemPrompt} disabled={busy} onChange={(event) => studio.updateThread(activeThread.id, { systemPrompt: event.target.value })} /></label>
            <label>Maximum output<select aria-label="Maximum output" value={activeThread.maxNewTokens} disabled={busy} onChange={(event) => studio.updateThread(activeThread.id, { maxNewTokens: Number(event.target.value) })}>{[128, 256, 512, 1024, 2048, 4096, 8192].map((value) => <option key={value} value={value}>{value.toLocaleString()} tokens</option>)}</select></label>
            <label>Temperature<small className="text-setting-help">Lower for focused answers, higher for variety.</small><div className="text-range-control"><input aria-label="Temperature" type="range" min="0" max="2" step="0.05" value={activeThread.temperature} disabled={busy} onChange={(event) => studio.updateThread(activeThread.id, { temperature: Number(event.target.value) })} /><output>{activeThread.temperature.toFixed(2)}</output></div></label>
            <label>Top P<small className="text-setting-help">Limits the range of words the model considers.</small><div className="text-range-control"><input aria-label="Top P" type="range" min="0.1" max="1" step="0.05" value={activeThread.topP} disabled={busy} onChange={(event) => studio.updateThread(activeThread.id, { topP: Number(event.target.value) })} /><output>{activeThread.topP.toFixed(2)}</output></div></label>
          </div>
        </div>}
      </aside>}
      </div>
    </section>
  );
}
