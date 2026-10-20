"""Own and reuse a model-specific text worker subprocess."""
from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable


EVENT_PREFIX = "FERN_TEXT_EVENT:"


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


class TextGenerationProcess:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._key: tuple[str, str] | None = None

    def _stop_unlocked(self) -> None:
        process = self._process
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

    def interrupt(self) -> None:
        # Terminating before acquiring _lock releases a request blocked on stdout.
        terminate_tree(self._process)

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
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        key = (str(Path(model_path).resolve()), device)
        with self._lock:
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("Generation stopped.")
            process = self._process
            if process is None or process.poll() is not None or self._key != key:
                self._stop_unlocked()
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
                on_phase("Starting the OpenVINO text worker…")

            assert process is not None and process.stdin is not None and process.stdout is not None
            try:
                if cancel_event is not None and cancel_event.is_set():
                    self._stop_unlocked()
                    raise InterruptedError("Generation stopped.")
                process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
                process.stdin.flush()
                while True:
                    if cancel_event is not None and cancel_event.is_set():
                        self._stop_unlocked()
                        raise InterruptedError("Generation stopped.")
                    raw = process.stdout.readline()
                    if not raw:
                        raise RuntimeError("The text worker exited before returning a result.")
                    line = raw.rstrip()
                    if not line.startswith(EVENT_PREFIX):
                        on_phase(line[:300])
                        continue
                    event = json.loads(line[len(EVENT_PREFIX):])
                    kind = event.get("type")
                    if kind == "token":
                        on_token(str(event.get("text", "")))
                    elif kind == "phase":
                        on_phase(str(event.get("text", "")))
                    elif kind == "result":
                        return event
                    elif kind == "error":
                        detail = str(event.get("error") or "Text generation failed.")
                        if event.get("traceback"):
                            on_phase(str(event["traceback"])[-5000:])
                        raise RuntimeError(detail)
                    else:
                        raise RuntimeError("The text worker sent an invalid response.")
            except (BrokenPipeError, OSError, json.JSONDecodeError):
                self._stop_unlocked()
                raise
            except RuntimeError:
                self._stop_unlocked()
                raise
