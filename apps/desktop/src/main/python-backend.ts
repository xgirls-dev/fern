import { ChildProcess, spawn } from "node:child_process";
import { getApiScriptPath, getPythonEnvironment, getPythonExecutable, getProjectRoot } from "./paths";

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 250;

export class PythonBackend {
  private process: ChildProcess | null = null;
  readonly port: number;

  constructor(port: number) {
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
      [script, "--port", String(this.port), "--cors"],
      {
        cwd: root,
        env: getPythonEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const proc = this.process;
    proc.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[python] ${chunk.toString("utf8")}`);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[python] ${chunk.toString("utf8")}`);
    });

    proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`Python backend exited with code ${code} (${signal ?? "no signal"})`);
      }
      this.process = null;
    });

    await this.waitForHealth();
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc || proc.killed) {
      return;
    }

    this.process = null;

    await new Promise<void>((resolve) => {
      const finish = () => resolve();

      const timeout = setTimeout(() => {
        if (process.platform === "win32" && proc.pid) {
          spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { windowsHide: true });
        } else {
          proc.kill("SIGKILL");
        }
        finish();
      }, 2_000);
      timeout.unref();

      proc.once("exit", () => {
        clearTimeout(timeout);
        finish();
      });

      if (process.platform === "win32" && proc.pid) {
        // Graceful tree kill first; /f only via timeout fallback above.
        spawn("taskkill", ["/pid", String(proc.pid), "/t"], { windowsHide: true });
      } else {
        proc.kill("SIGTERM");
      }
    });
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/api/health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Backend still booting.
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
    }

    throw new Error(`Python API did not become ready on port ${this.port}`);
  }
}

