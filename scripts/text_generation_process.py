"""Own and reuse a model-specific text worker subprocess."""
from __future__ import annotations

import json
import os
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from text_runtime_errors import OUT_OF_MEMORY, has_memory_failure

if TYPE_CHECKING:
    import psutil


EVENT_PREFIX = "FERN_TEXT_EVENT:"
STOP_TIMEOUT = 0.8
UNLOAD_TIMEOUT = 6


class TextWorkerError(RuntimeError):
    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class _GenerationStopped(InterruptedError):
    pass


@dataclass
class _ActiveRequest:
    process: subprocess.Popen[str]
    cancel_event: threading.Event | None
    cancellable: bool = False
    stopping: bool = False
    timeout: threading.Timer | None = None


def terminate_tree(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/pid", str(process.pid), "/t", "/f"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired):
            pass  # Terminate the known child directly if taskkill is unavailable.
        if process.poll() is None:
            process.terminate()
    else:
        process.terminate()


def stop_unloaded_engine(engine: psutil.Process) -> None:
    import psutil

    try:
        if not engine.is_running() or engine.status() == psutil.STATUS_ZOMBIE:
            return
        engine.kill()
        try:
            engine.wait(timeout=2)
        except psutil.TimeoutExpired:
            # An orphan may remain a zombie until its new parent reaps it.
            if engine.is_running() and engine.status() != psutil.STATUS_ZOMBIE:
                raise
    except psutil.NoSuchProcess:
        pass
    except psutil.Error as error:
        raise OSError("The model engine did not exit.") from error


class TextGenerationProcess:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._control_lock = threading.Lock()
        self._active: _ActiveRequest | None = None
        self._process: subprocess.Popen[str] | None = None
        self._key: tuple[str, str, tuple[str, ...]] | None = None
        self._residency: tuple[subprocess.Popen[str], dict[str, Any]] | None = None

    def _live_residency(self) -> tuple[dict[str, Any], psutil.Process | None] | None:
        with self._control_lock:
            residency = self._residency
        if residency is None:
            return None
        worker, model = residency
        if worker.poll() is not None:
            return None
        engine = None
        if engine_pid := model.get("enginePid"):
            # GGUF weights live in the worker's server child, which can exit
            # independently while the Python worker remains available.
            try:
                import psutil
            except ImportError:
                return None
            try:
                engine = psutil.Process(engine_pid)
                parent_pid = engine.ppid()
                # A Windows virtualenv can launch the real Python worker through a redirector.
                is_child = parent_pid == worker.pid or (os.name == "nt" and psutil.Process(parent_pid).ppid() == worker.pid)
                if not is_child or engine.status() == psutil.STATUS_ZOMBIE:
                    return None
            except psutil.Error:
                return None
        with self._control_lock:
            if self._residency is residency and self._process is worker and worker.poll() is None:
                return model, engine
        return None

    def resident_model(self) -> dict[str, Any] | None:
        live = self._live_residency()
        if live is None:
            return None
        model, _ = live
        return {key: model[key] for key in ("modelId", "backend", "device", "gguf") if key in model}

    def _stop_unlocked(self) -> None:
        process = self._process
        with self._control_lock:
            self._residency = None
        self._process = None
        self._key = None
        if process is None:
            return
        terminate_tree(process)
        if process.poll() is None:
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=4)
        for stream in (process.stdin, process.stdout):
            if stream is not None:
                stream.close()

    def close(self) -> None:
        self.interrupt()
        with self._lock:
            self._stop_unlocked()

    def unload(self, model_id: str) -> None:
        with self._lock:
            live = self._live_residency()
            if live is None or live[0]["modelId"] != model_id:
                return
            _, engine = live
            process = self._process
            assert process is not None and process.stdin is not None
            try:
                # Let the idle worker reap its GGUF engine before it exits.
                process.stdin.write('{"op":"shutdown"}\n')
                process.stdin.flush()
                process.wait(timeout=UNLOAD_TIMEOUT)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
            finally:
                try:
                    self._stop_unlocked()
                finally:
                    # Keep the validated process handle across a worker crash or
                    # timeout, when the engine might already have a new parent.
                    if engine is not None:
                        stop_unloaded_engine(engine)

    def interrupt(self) -> None:
        # Terminating before acquiring _lock releases a request blocked on stdout.
        terminate_tree(self._process)

    def request_stop(self, cancel_event: threading.Event) -> None:
        with self._control_lock:
            active = self._active
            if active is None or active.cancel_event is not cancel_event or active.stopping:
                return
            active.stopping = True
            if active.cancellable:
                try:
                    assert active.process.stdin is not None
                    active.process.stdin.write('{"op":"cancel"}\n')
                    active.process.stdin.flush()
                except (OSError, ValueError):
                    pass
                else:
                    active.timeout = threading.Timer(STOP_TIMEOUT, self._force_stop, (active,))
                    active.timeout.daemon = True
                    active.timeout.start()
                    return
            terminate_tree(active.process)

    def _force_stop(self, active: _ActiveRequest) -> None:
        with self._control_lock:
            if self._active is active:
                terminate_tree(active.process)

    def generate(
        self,
        *,
        model_path: str,
        device: str,
        command: list[str],
        request: dict[str, Any],
        cwd: Path,
        env: dict[str, str],
        on_token: Callable[[str], None],
        on_phase: Callable[[str], None],
        on_reasoning: Callable[[str], None] | None = None,
        on_diagnostic: Callable[[dict[str, Any]], None] | None = None,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        key = (str(Path(model_path).resolve()), device, tuple(command))
        with self._lock:
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Generation stopped.")
            process = self._process
            if process is None or process.poll() is not None or self._key != key:
                self._stop_unlocked()
                if on_diagnostic is not None:
                    on_diagnostic({"stage": "starting-worker"})
                process = subprocess.Popen(
                    command,
                    cwd=str(cwd),
                    env=env,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                self._process = process
                self._key = key
                on_phase("Starting the text worker…")

            assert process is not None and process.stdin is not None and process.stdout is not None
            active = _ActiveRequest(process, cancel_event)
            with self._control_lock:
                if cancel_event is not None and cancel_event.is_set():
                    raise _GenerationStopped("Generation stopped.")
                self._active = active
            reset_worker = False
            reported_memory_failure = False
            try:
                process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
                process.stdin.flush()
                while True:
                    if cancel_event is not None and cancel_event.is_set():
                        self.request_stop(cancel_event)
                    raw = process.stdout.readline()
                    if not raw:
                        if reported_memory_failure:
                            raise TextWorkerError("The text runtime reported a memory allocation failure.", OUT_OF_MEMORY)
                        raise RuntimeError("The text worker exited before returning a result.")
                    line = raw.rstrip()
                    if not line.startswith(EVENT_PREFIX):
                        reported_memory_failure |= has_memory_failure(line)
                        on_phase(line[:300])
                        continue
                    event = json.loads(line[len(EVENT_PREFIX):])
                    kind = event.get("type")
                    cancelled = cancel_event is not None and cancel_event.is_set()
                    if cancelled and kind in ("token", "reasoning", "phase", "runtime"):
                        continue
                    if kind == "residency":
                        model = event.get("model")
                        with self._control_lock:
                            self._residency = (process, {**model, "modelId": request["modelId"]}) if model and request.get("modelId") else None
                    elif kind == "cancellable":
                        with self._control_lock:
                            active.cancellable = True
                    elif kind == "token":
                        on_token(str(event.get("text", "")))
                    elif kind == "reasoning" and on_reasoning is not None:
                        on_reasoning(str(event.get("text", "")))
                    elif kind == "phase":
                        if on_diagnostic is not None and "stage" in event:
                            on_diagnostic({"stage": event["stage"]})
                        if "text" in event:
                            on_phase(str(event["text"]))
                    elif kind == "runtime":
                        if on_diagnostic is not None:
                            on_diagnostic({"backend": event.get("backend"), "device": event.get("device")})
                    elif kind == "result":
                        if cancelled:
                            raise _GenerationStopped("Generation stopped.")
                        return event
                    elif kind == "cancelled" and cancelled:
                        raise _GenerationStopped("Generation stopped.")
                    elif kind == "error":
                        detail = str(event.get("error") or "Text generation failed.")
                        if event.get("traceback"):
                            on_phase(str(event["traceback"])[-5000:])
                        code = event.get("code") or (OUT_OF_MEMORY if reported_memory_failure else None)
                        raise TextWorkerError(detail, code)
                    else:
                        raise RuntimeError("The text worker sent an invalid response.")
            except _GenerationStopped:
                raise
            except (OSError, json.JSONDecodeError, RuntimeError):
                reset_worker = True
                raise
            finally:
                with self._control_lock:
                    self._active = None
                    if active.timeout is not None:
                        active.timeout.cancel()
                if reset_worker:
                    self._stop_unlocked()
