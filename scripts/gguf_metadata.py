"""Read the small set of GGUF metadata Fern needs without loading the weights."""
from __future__ import annotations

import mmap
import struct
from functools import lru_cache
from pathlib import Path


_FIXED_SIZE = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
_KEYS = {"general.architecture", "general.name", "general.type", "tokenizer.chat_template"}


def read_metadata(path: Path) -> dict[str, str | int]:
    info = path.stat()
    return _read_metadata(path, info.st_size, info.st_mtime_ns)


@lru_cache(maxsize=64)
def _read_metadata(path: Path, size: int, modified: int) -> dict[str, str | int]:
    if not path.is_file() or path.suffix.lower() != ".gguf" or size < 24:
        raise ValueError("Choose a valid .gguf file.")
    with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        version, tensors, entries = struct.unpack_from("<IQQ", data, 4)
        if data[:4] != b"GGUF" or version not in (2, 3) or not tensors or entries > 100_000:
            raise ValueError("The file is not a supported GGUF v2 or v3 model.")
        offset = 24

        def take(length: int) -> int:
            nonlocal offset
            start = offset
            offset += length
            if offset > size:
                raise ValueError("The GGUF metadata is incomplete.")
            return start

        def integer(fmt: str) -> int:
            return struct.unpack_from(fmt, data, take(struct.calcsize(fmt)))[0]

        def string(read: bool) -> str:
            length = integer("<Q")
            start = take(length)
            if read and length > 1024 * 1024:
                raise ValueError("The GGUF text metadata is too large.")
            return data[start:offset].decode("utf-8") if read else ""

        def skip(kind: int) -> None:
            if kind in _FIXED_SIZE:
                take(_FIXED_SIZE[kind])
            elif kind == 8:
                string(False)
            elif kind == 9:
                element, count = integer("<I"), integer("<Q")
                if element in _FIXED_SIZE:
                    take(count * _FIXED_SIZE[element])
                elif element == 8 and count <= (size - offset) // 8:
                    for _ in range(count):
                        string(False)
                else:
                    raise ValueError("The GGUF array metadata is invalid.")
            else:
                raise ValueError("The GGUF metadata contains an unsupported value type.")

        values = {}
        for _ in range(entries):
            key = string(True)
            kind = integer("<I")
            if kind == 8 and key in _KEYS:
                values[key] = string(True)
            elif kind == 4 and key.endswith(".context_length"):
                values[key] = integer("<I")
            else:
                skip(kind)
        if not values.get("general.architecture"):
            raise ValueError("The GGUF file does not declare a model architecture.")
        return values


def is_projector(metadata: dict[str, str | int]) -> bool:
    return metadata["general.architecture"] == "clip" or metadata.get("general.type") == "mmproj"
