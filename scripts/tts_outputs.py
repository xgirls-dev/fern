"""Locate and validate completed speech takes."""
from __future__ import annotations

import os
import re
import wave
from pathlib import Path


def valid_job_id(value: object) -> bool:
    # Existing sessions can have a millisecond timestamp instead of a UUID.
    return isinstance(value, str) and re.fullmatch(
        r"(?:[0-9]{13}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})", value
    ) is not None


def take_name(job_id: str) -> str:
    return f"qwen3-tts-{job_id}.wav"


def read_take(path: Path, *, published_name: str | None = None) -> dict[str, str | int | float] | None:
    try:
        if path.is_symlink():
            return None
        with path.open("rb") as file, wave.open(file, "rb") as audio:
            frames, rate = audio.getnframes(), audio.getframerate()
            if not frames or not rate or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
                return None
            # A truncated file can still have a readable header and frame count.
            audio.setpos(frames - 1)
            if len(audio.readframes(1)) != 2:
                return None
            created_at = os.fstat(file.fileno()).st_mtime_ns // 1_000_000
    except (FileNotFoundError, IsADirectoryError, ValueError, EOFError, wave.Error):
        return None
    name = published_name or path.name
    return {"name": name, "url": f"/outputs/{name}", "sampleRate": rate, "duration": frames / rate, "createdAt": created_at}
