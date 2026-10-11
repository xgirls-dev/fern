"""Keep one long-running inference process warm between requests."""
from __future__ import annotations

import json
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable


EVENT_PREFIX = "FERN_TTS_EVENT:"
PROGRESS_PREFIX = "FERN_TTS_PROGRESS:"


class TtsGenerationWorker:
    def __init__(self, idle_timeout_seconds: float = 300) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._key: tuple[str, str] | None = None
        self._idle_timeout_seconds = idle_timeout_seconds
        self._idle_timer: threading.Timer | None = None
        self._epoch = 0

    def _expire_if_idle(self, epoch: int) -> None:
        with self._lock:
            if epoch == self._epoch:
                self._stop_unlocked()

    def _schedule_idle_close_unlocked(self) -> None:
        if self._process is None or self._process.poll() is not None:
            return
        timer = threading.Timer(self._idle_timeout_seconds, self._expire_if_idle, args=(self._epoch,))
        timer.daemon = True
        self._idle_timer = timer
        timer.start()

    def _stop_unlocked(self) -> None:
        process = self._process
        self._process = None
        self._key = None
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        for stream in (process.stdin, process.stdout):
            if stream is not None:
                stream.close()

    def close(self) -> None:
        # Interrupt a blocked stdout read during app shutdown before taking the
        # request lock; an inference can otherwise hold that lock for minutes.
        process = self._process
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass
        with self._lock:
            self._epoch += 1
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
            self._stop_unlocked()

    def interrupt(self) -> None:
        """Unblock an in-flight request without waiting for its read lock."""
        process = self._process
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass

    def generate(
        self, *, key: tuple[str, str], command: list[str], request: dict[str, Any],
        cwd: Path, env: dict[str, str], log: Callable[[str], None],
        runtime_label: str = "Qwen3-TTS",
        progress_prefix: str = PROGRESS_PREFIX,
    ) -> dict[str, Any]:
        with self._lock:
            self._epoch += 1
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
            if self._process is None or self._process.poll() is not None or self._key != key:
                self._stop_unlocked()
                self._process = subprocess.Popen(
                    command, cwd=str(cwd), env=env, stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                    encoding="utf-8", errors="replace", bufsize=1,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                self._key = key
                log(progress_prefix + f"Starting {runtime_label} runtime.")
            else:
                log(progress_prefix + f"Reusing the loaded {runtime_label} model.")

            process = self._process
            assert process.stdin is not None and process.stdout is not None
            try:
                process.stdin.write(json.dumps(request) + "\n")
                process.stdin.flush()
                for raw in process.stdout:
                    line = raw.rstrip()
                    if not line:
                        continue
                    qwen_prefix = "FERN_QWEN_EVENT:"
                    if line.startswith(EVENT_PREFIX) or line.startswith(qwen_prefix):
                        prefix = EVENT_PREFIX if line.startswith(EVENT_PREFIX) else qwen_prefix
                        event = json.loads(line[len(prefix):])
                        if isinstance(event, dict) and "error" in event:
                            if event.get("traceback"):
                                log(str(event["traceback"]))
                            raise RuntimeError(str(event["error"]))
                        if isinstance(event, dict) and ("url" in event or "path" in event):
                            return event
                        raise RuntimeError("The generation worker sent an invalid result.")
                    log(line)
                raise RuntimeError("The generation worker exited before returning a result.")
            except (BrokenPipeError, OSError, json.JSONDecodeError):
                self._stop_unlocked()
                raise
            except RuntimeError:
                if process.poll() is not None:
                    self._stop_unlocked()
                raise
            finally:
                self._schedule_idle_close_unlocked()
