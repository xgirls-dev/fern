from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Iterable


GIB = 1024**3
MIB = 1024**2
CACHE_RETENTION_DAYS = 30
CACHE_HARD_MAX_BYTES = 4 * GIB
CACHE_MIN_BYTES = 1 * GIB
MIN_FREE_FLOOR_BYTES = 5 * GIB
MIN_FREE_CEILING_BYTES = 20 * GIB

STORAGE_LOCK = threading.Lock()


def _files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [path for path in root.rglob("*") if path.is_file()]


def _size(paths: Iterable[Path]) -> int:
    total = 0
    for path in paths:
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return total


def directory_size(root: Path) -> int:
    return _size(_files(root))


def _remove_empty_directories(root: Path) -> None:
    if not root.exists():
        return
    directories = (item for item in root.rglob("*") if item.is_dir())
    for path in sorted(directories, key=lambda item: len(item.parts), reverse=True):
        try:
            path.rmdir()
        except OSError:
            continue


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return float("inf")


def _unlink(path: Path) -> tuple[bool, int]:
    try:
        size = path.stat().st_size
        path.unlink(missing_ok=True)
        return True, size
    except OSError:
        return False, 0


def cache_policy(root: Path) -> dict[str, int]:
    disk = shutil.disk_usage(root)
    max_bytes = min(
        CACHE_HARD_MAX_BYTES,
        max(CACHE_MIN_BYTES, int(disk.total * 0.05)),
    )
    reserve_bytes = min(
        MIN_FREE_CEILING_BYTES,
        max(MIN_FREE_FLOOR_BYTES, int(disk.total * 0.10)),
    )
    return {
        "retentionDays": CACHE_RETENTION_DAYS,
        "maxBytes": max_bytes,
        "reserveBytes": reserve_bytes,
    }


def cleanup_cache(root: Path, cache_dir: Path, *, force: bool = False) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    with STORAGE_LOCK:
        policy = cache_policy(root)
        files = _files(cache_dir)
        before_bytes = _size(files)
        removed_bytes = 0
        removed_files = 0

        if force:
            candidates = sorted(files, key=_mtime)
        else:
            cutoff = time.time() - policy["retentionDays"] * 24 * 60 * 60
            expired = []
            retained = []
            for path in files:
                try:
                    target = expired if path.stat().st_mtime < cutoff else retained
                    target.append(path)
                except OSError:
                    continue

            for path in sorted(expired, key=_mtime):
                deleted, removed = _unlink(path)
                if deleted:
                    removed_bytes += removed
                    removed_files += 1

            candidates = sorted(retained, key=_mtime)

        remaining_bytes = max(0, before_bytes - removed_bytes)
        for path in candidates:
            free_bytes = shutil.disk_usage(root).free
            if not force and (
                remaining_bytes <= policy["maxBytes"]
                and free_bytes >= policy["reserveBytes"]
            ):
                break
            deleted, removed = _unlink(path)
            if deleted:
                removed_bytes += removed
                removed_files += 1
                remaining_bytes = max(0, remaining_bytes - removed)

        _remove_empty_directories(cache_dir)
        disk = shutil.disk_usage(root)
        return {
            "beforeBytes": before_bytes,
            "afterBytes": directory_size(cache_dir),
            "removedBytes": removed_bytes,
            "removedFiles": removed_files,
            "freeBytes": disk.free,
            "totalBytes": disk.total,
            "policy": policy,
        }


def touch_cache(cache_dir: Path) -> None:
    now = time.time()
    with STORAGE_LOCK:
        for path in _files(cache_dir):
            try:
                # Windows can preserve creation time; mtime is the retention signal.
                os.utime(path, (now, now))
            except OSError:
                continue


def clear_directory(root: Path) -> tuple[int, int]:
    removed_bytes = 0
    removed_files = 0
    root.mkdir(parents=True, exist_ok=True)
    for path in _files(root):
        deleted, removed = _unlink(path)
        if deleted:
            removed_bytes += removed
            removed_files += 1
    _remove_empty_directories(root)
    return removed_files, removed_bytes


def storage_status(
    root: Path,
    *,
    cache_dir: Path,
    outputs_dir: Path,
    data_dir: Path,
    models_dir: Path,
) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(root)
    policy = cache_policy(root)
    cache_files = _files(cache_dir)
    cache_bytes = _size(cache_files)
    outputs = _files(outputs_dir)
    output_bytes = _size(outputs)
    data_files = _files(data_dir)
    model_files = _files(models_dir)
    data_bytes = _size(data_files)
    model_bytes = _size(model_files)
    return {
        "cache": {
            "bytes": cache_bytes,
            "fileCount": len(cache_files),
            "retentionDays": policy["retentionDays"],
            "maxBytes": policy["maxBytes"],
        },
        "outputs": {
            "bytes": output_bytes,
            "fileCount": len(outputs),
        },
        "metadata": {
            "bytes": data_bytes,
        },
        "models": {
            "bytes": model_bytes,
            "preservedOnReset": True,
        },
        "disk": {
            "freeBytes": disk.free,
            "totalBytes": disk.total,
            "reserveBytes": policy["reserveBytes"],
        },
        "managedBytes": cache_bytes + output_bytes + data_bytes,
    }
