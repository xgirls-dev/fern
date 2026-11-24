"""Recognize explicit allocation failures reported by the local text runtimes."""
import errno
import re

OUT_OF_MEMORY = "out-of-memory"
_MEMORY_FAILURE = re.compile(
    r"\bout of (?:(?:gpu|host|device) )?memory\b"
    r"|\b(?:VK_ERROR_OUT_OF_(?:DEVICE|HOST)_MEMORY|ErrorOutOf(?:Device|Host)Memory"
    r"|CL_MEM_OBJECT_ALLOCATION_FAILURE|CL_OUT_OF_HOST_MEMORY|std::bad_alloc)\b"
    r"|\bexceeded max size of memory object allocation\b",
    re.IGNORECASE,
)


class TextRuntimeMemoryError(RuntimeError):
    code = OUT_OF_MEMORY


def has_memory_failure(detail: str) -> bool:
    return bool(_MEMORY_FAILURE.search(detail))


def text_runtime_error_code(error: Exception) -> str | None:
    code = getattr(error, "code", None)
    if code:
        return code
    if (isinstance(error, MemoryError) or isinstance(error, OSError) and error.errno == errno.ENOMEM
            or has_memory_failure(str(error))):
        return OUT_OF_MEMORY
    return None
