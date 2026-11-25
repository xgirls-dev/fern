import { ChildProcess, spawn } from "node:child_process";
import { getApiScriptPath, getPythonEnvironment, getPythonExecutable, getProjectRoot } from "./paths";

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 250;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export class PythonBackend {
  private process: ChildProcess | null = null;
  readonly port: number;

  constructor(port: number, private readonly onUnexpectedExit: () => void) {
    this.port = port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const python = getPythonExecutable();
    const script = getApiScriptPath();
    const root = getProjectRoot();

    this.process = spawn(
      python,
      [script, "--port", String(this.port), "--cors", "--desktop"],
      {
        cwd: root,
        env: getPythonEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );

    const proc = this.process;
    proc.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[python] ${chunk.toString("utf8")}`);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[python] ${chunk.toString("utf8")}`);
    });

    let spawnError: Error | undefined;
    proc.once("error", (error) => {
      spawnError = error;
      if (this.process === proc) this.process = null;
    });
    proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`Python backend exited with code ${code} (${signal ?? "no signal"})`);
      }
      if (this.process !== proc) return;
      this.process = null;
      // Workers can outlive the service. Windows gives the service a job
      // object, and Unix keeps its children in the service's process group.
      if (process.platform !== "win32" && proc.pid) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("Could not stop Fern's backend workers:", error);
        }
      }
      this.onUnexpectedExit();
    });

    const checkProcess = () => {
      if (spawnError) throw spawnError;
      if (this.process !== proc) throw new Error("Fern's Python backend exited during startup.");
    };
    await this.waitForHealth(checkProcess);
    checkProcess();
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc || proc.killed) {
      return;
    }

    this.process = null;

    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      const signalBackend = (signal: NodeJS.Signals) => {
        if (process.platform === "win32" || !proc.pid) {
          proc.kill(signal);
          return;
        }
        // Image and llama.cpp workers share this backend's process group.
        try {
          process.kill(-proc.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            console.error("Could not stop Fern's Python process group:", error);
            proc.kill(signal);
          }
        }
      };

      const timeout = setTimeout(() => {
        if (process.platform === "win32" && proc.pid) {
          spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { windowsHide: true });
        } else {
          signalBackend("SIGKILL");
        }
        finish();
      }, 2_000);
      timeout.unref();

      proc.once("close", () => {
        clearTimeout(timeout);
        if (process.platform !== "win32") signalBackend("SIGKILL");
        finish();
      });

      if (process.platform === "win32" && proc.pid) {
        // Graceful tree kill first; /f only via timeout fallback above.
        spawn("taskkill", ["/pid", String(proc.pid), "/t"], { windowsHide: true });
      } else {
        signalBackend("SIGTERM");
      }
    });
  }

  private async waitForHealth(checkProcess: () => void): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;

    while (Date.now() < deadline) {
      checkProcess();
      try {
        const response = await fetch(`${this.baseUrl}/api/health`, {
          signal: AbortSignal.timeout(Math.min(HEALTH_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now()))),
        });
        if (response.ok) return;
      } catch {
        // Backend still booting.
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
    }

    throw new Error(`Python API did not become ready on port ${this.port}`);
  }
}

