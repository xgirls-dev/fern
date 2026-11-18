"""Fit complete chat turns and recent visuals into a local model's context."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Callable


CONTEXT_SIZES = (4096, 8192, 16384)
DEFAULT_CONTEXT_SIZE = 8192
MAX_IMAGE_TOKENS = 280
RECENT_IMAGE_LIMIT = 2
SUMMARY_RESERVE = 384

Message = dict[str, Any]


@dataclass(frozen=True)
class CompactedHistory:
    dropped: int
    prefix_hash: str
    summary: str


def _prefix_hash(messages: list[Message]) -> str:
    return hashlib.sha256(json.dumps(messages, sort_keys=True).encode()).hexdigest()


def recent_images(messages: list[Message]) -> list[Message]:
    """Retain pixels for the latest two recent images while leaving older text intact."""
    positions = [index for index, turn in enumerate(messages) if turn.get("imagePath")]
    keep = {index for index in positions[-RECENT_IMAGE_LIMIT:] if index >= len(messages) - 8}
    return [
        turn if index in keep or "imagePath" not in turn
        else {key: value for key, value in turn.items() if key != "imagePath"}
        for index, turn in enumerate(messages)
    ]


def fit_context(
    messages: list[Message],
    measure: Callable[[list[Message]], int],
    summarize: Callable[[str], str],
    budget: int,
    *,
    previous: CompactedHistory | None = None,
    protected_tail: int = 1,
) -> tuple[list[Message], CompactedHistory | None]:
    if messages and messages[0]["role"] == "system":
        system, turns = messages[0]["content"], messages[1:]
    else:
        system, turns = "", messages

    def build(start: int, summary: str = "") -> list[Message]:
        text = "\n\n".join(filter(None, (system, f"Earlier conversation summary:\n{summary}" if summary else "")))
        return ([{"role": "system", "content": text}] if text else []) + turns[start:]

    start, summary = 0, ""
    if previous and previous.dropped <= len(turns) - protected_tail and (
        previous.prefix_hash == _prefix_hash(turns[:previous.dropped])
    ):
        start, summary = previous.dropped, previous.summary

    candidate = build(start, summary)
    if measure(candidate) <= budget:
        return candidate, previous if start else None

    # Keep the current turn, any tool exchange, and the latest preceding image.
    latest_boundary = len(turns) - protected_tail
    latest_image = next((index for index in range(len(turns) - 1, -1, -1) if turns[index].get("imagePath")), None)
    if latest_image is not None and latest_image >= len(turns) - 2:
        latest_boundary = min(latest_boundary, latest_image)
    boundaries = [index for index in range(start + 1, latest_boundary + 1) if turns[index]["role"] == "user"]
    low, high = 0, len(boundaries)
    while low < high:
        mid = (low + high) // 2
        if measure(build(boundaries[mid])) <= budget - SUMMARY_RESERVE:
            high = mid
        else:
            low = mid + 1
    if low == len(boundaries):
        raise ValueError("The latest message and its image context exceed this context size. Shorten the message or choose a larger context in Chat settings.")

    end = boundaries[low]
    transcript = "\n".join(f"{turn['role']}: {turn['content']}" for turn in turns[start:end])
    summary = summarize("\n\n".join(filter(None, (summary, transcript))))
    candidate = build(end, summary)
    if measure(candidate) > budget:
        raise ValueError("The compacted conversation exceeds this context size. Choose a larger context in Chat settings.")
    return candidate, CompactedHistory(end, _prefix_hash(turns[:end]), summary)
