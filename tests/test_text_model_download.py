import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import text_model_download as download


class FakeResponse:
    def __init__(self, body: bytes, status: int, headers: dict[str, str] | None = None):
        self.body = body
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def getcode(self):
        return self.status

    def read(self, _size: int = -1):
        body, self.body = self.body, b""
        return body


class TextModelDownloadTests(unittest.TestCase):
    def test_recommended_manifest_is_pinned_and_complete(self):
        spec = download.model_spec(download.DEFAULT_MODEL_ID)
        self.assertEqual(spec["repo"], "xgirls/Qwen3-4B-Instruct-2507-openvino")
        self.assertEqual(spec["revision"], "e347e3317a5e964cd15583e4ef8fb56900ad01c5")
        self.assertGreater(sum(item["size"] for item in spec["files"]), 4_000_000_000)

    def test_git_blob_and_sha256_checksums(self):
        content = b"small reproducible model file"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "file"
            path.write_bytes(content)
            git_spec = {
                "size": len(content), "algorithm": "git-sha1",
                "digest": hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest(),
            }
            lfs_spec = {"size": len(content), "algorithm": "sha256", "digest": hashlib.sha256(content).hexdigest()}
            self.assertTrue(download.verified(path, git_spec))
            self.assertTrue(download.verified(path, lfs_spec))
            self.assertFalse(download.verified(path, {**lfs_spec, "digest": "0" * 64}))

    def test_download_resumes_only_at_manifest_range_and_verifies_checksum(self):
        content = b"abcdef"
        file = {"path": "small.bin", "size": len(content), "algorithm": "sha256", "digest": hashlib.sha256(content).hexdigest()}
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / file["path"]
            target.with_name(target.name + ".part").write_bytes(content[:3])
            response = FakeResponse(content[3:], 206, {"Content-Range": "bytes 3-5/6"})
            with patch.object(download.urllib.request, "urlopen", return_value=response):
                download.download_file("https://example.invalid/file", target, file, lambda _text: None)
            self.assertEqual(target.read_bytes(), content)
            self.assertTrue(download.verified(target, file))

    def test_rejects_incorrect_resume_range(self):
        content = b"abcdef"
        file = {"path": "small.bin", "size": len(content), "algorithm": "sha256", "digest": hashlib.sha256(content).hexdigest()}
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / file["path"]
            target.with_name(target.name + ".part").write_bytes(content[:3])
            response = FakeResponse(content[3:], 206, {"Content-Range": "bytes 2-5/6"})
            with patch.object(download.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "invalid or incomplete download range"):
                    download.download_file("https://example.invalid/file", target, file, lambda _text: None)


if __name__ == "__main__":
    unittest.main()
