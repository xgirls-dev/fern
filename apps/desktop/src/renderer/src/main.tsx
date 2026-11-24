import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Button } from "./components/ui/controls";
import "./styles/globals.css";
import "./styles/studio.css";
import "./styles/design-system.css";

document.documentElement.dataset.platform = window.studio.platform;

function RestoreFailure() {
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState(false);
  const returnToWorkspace = async () => {
    setReturning(true);
    setError(false);
    try { await window.studio.returnFromFailedRestore(); }
    catch { setReturning(false); setError(true); }
  };
  return <main className="dashboard-loading">
    <div role="alert">Fern could not open this backup. Your previous workspace is still available.</div>
    <Button variant="secondary" disabled={returning} onClick={() => void returnToWorkspace()}>Return to previous workspace</Button>
    {error && <p role="alert">Could not reopen the workspace. Try again.</p>}
  </main>;
}

const root = createRoot(document.getElementById("root")!);
const openApp = () => root.render(<StrictMode><App /></StrictMode>);

if (window.studio.hasWorkspaceSeed) {
  root.render(<div className="dashboard-loading" role="status">Restoring workspace…</div>);
  void import("./lib/workspaceBackup").then(({ restoreWorkspaceSeed }) => restoreWorkspaceSeed()).then(openApp, () => {
    root.render(<RestoreFailure />);
  });
} else {
  openApp();
}
