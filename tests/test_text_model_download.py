import hashlib
import json
import sys
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from threading import Event, Thread
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

    read1 = read


class TextModelDownloadTests(unittest.TestCase):
    def test_repair_reuses_verified_gguf_and_replaces_same_length_corruption(self):
        model_id = "gemma-4-e4b-gguf"
        spec = download.model_spec(model_id)
        good = {spec["modelFile"]: b"verified model", spec["projectorFile"]: b"verified projector"}
        spec = {**spec, "files": [
            {"path": name, "size": len(data), "algorithm": "sha256", "digest": hashlib.sha256(data).hexdigest()}
            for name, data in good.items()
        ]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            folder = root / spec["folder"]
            folder.mkdir()
            main, projector = download.model_files(folder, spec)
            main.write_bytes(good[main.name])
            damaged = b"!" * len(good[projector.name])
            projector.write_bytes(damaged)
            marker = folder / download.INSTALL_MARKER
            marker.write_text(json.dumps({"modelId": model_id, "verifiedChecksums": True,
                                          **{key: spec[key] for key in ("repo", "revision", "format")}}), encoding="utf-8")
            notes = folder / "notes.txt"
            notes.write_text("Keep this", encoding="utf-8")
            disk = SimpleNamespace(free=download.MINIMUM_FREE_BYTES + len(damaged))
            with (
                patch.object(download, "model_spec", return_value=spec),
                patch.object(download.shutil, "disk_usage", return_value=disk),
                patch.object(download.urllib.request, "urlopen") as fetch,
                patch.object(download, "inspect_model") as inspect_model,
            ):
                fetch.return_value = FakeResponse(damaged, 200)
                with self.assertRaisesRegex(RuntimeError, "Checksum verification failed"):
                    download.install_model(model_id, root, lambda _: None, repair=True)
                self.assertEqual(projector.read_bytes(), damaged)
                inspect_model.assert_not_called()
                fetch.reset_mock()
                fetch.return_value = FakeResponse(good[projector.name], 200)
                self.assertEqual(download.install_model(model_id, root, lambda _: None, repair=True), folder)
                fetch.assert_called_once()
                self.assertTrue(fetch.call_args.args[0].full_url.endswith("/" + projector.name))
                staged = root / (spec["folder"] + ".download")
                inspect_model.assert_called_once_with(main, projector_path=staged / projector.name, validate_ir=True)
                self.assertEqual(main.read_bytes(), good[main.name])
                self.assertEqual(projector.read_bytes(), good[projector.name])
                self.assertEqual(notes.read_text(encoding="utf-8"), "Keep this")
                self.assertEqual(list(staged.iterdir()), [])

    def test_gguf_removal_checks_shared_projector_and_can_retry_after_io_failure(self):
        catalog_id = "gemma-4-e4b-gguf"
        spec = download.model_spec(catalog_id)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            folder = root / spec["folder"]
            folder.mkdir()
            main, projector = download.model_files(folder, spec)
            main.write_bytes(b"model")
            projector.write_bytes(b"projector")
            marker = folder / download.INSTALL_MARKER
            marker.write_text(json.dumps({"modelId": catalog_id, "verifiedChecksums": True,
                                          **{key: spec[key] for key in ("repo", "revision", "format")}}), encoding="utf-8")
            model = {"id": "gemma", "path": str(main)}
            other = {"id": "other", "name": "Another model", "path": str(root / "another.gguf"),
                     "projectorPath": str(projector)}
            removed = []
            with self.assertRaisesRegex(ValueError, "Another model"):
                download.remove_download(root, model, [model, other], removed.append)
            self.assertTrue(main.is_file() and projector.is_file())
            unlink = Path.unlink

            def fail_on_projector(path, *args, **kwargs):
                if path == projector:
                    raise PermissionError("in use")
                return unlink(path, *args, **kwargs)

            with patch.object(Path, "unlink", fail_on_projector):
                with self.assertRaisesRegex(ValueError, "Close any app using it and retry"):
                    download.remove_download(root, model, [model], removed.append)
            self.assertFalse(main.exists())
            self.assertTrue(projector.is_file() and marker.is_file())
            self.assertEqual(removed, [])
            download.remove_download(root, model, [model], removed.append)
            self.assertEqual(removed, ["gemma"])
            self.assertFalse(folder.exists())

    def test_removal_refuses_a_replaced_download_file_before_deleting_any_bytes(self):
        catalog_id = "gemma-4-e4b-gguf"
        spec = download.model_spec(catalog_id)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            folder = root / spec["folder"]
            folder.mkdir()
            main, projector = download.model_files(folder, spec)
            main.write_bytes(b"model")
            projector.mkdir()
            marker = folder / download.INSTALL_MARKER
            marker.write_text(json.dumps({"modelId": catalog_id, "verifiedChecksums": True,
                                          **{key: spec[key] for key in ("repo", "revision", "format")}}), encoding="utf-8")
            model = {"id": "gemma", "path": str(main)}
            with self.assertRaisesRegex(ValueError, "file was moved or replaced"):
                download.remove_download(root, model, [model], lambda _: self.fail("Model still has files"))
            self.assertEqual(main.read_bytes(), b"model")
            self.assertTrue(marker.is_file())

    def test_fresh_install_requirements_match_the_disk_check_and_projector_payload(self):
        model_id = "gemma-4-e4b-gguf"
        spec = download.model_spec(model_id)
        requirements = download.model_download_details(spec)
        projector = next(file for file in spec["files"] if file["path"] == spec["projectorFile"])
        self.assertEqual(requirements["bytes"], sum(file["size"] for file in spec["files"]))
        self.assertEqual(requirements["projectorBytes"], projector["size"])
        self.assertNotIn("projectorBytes", download.model_download_details(download.model_spec(download.DEFAULT_MODEL_ID)))
        with tempfile.TemporaryDirectory() as directory, patch.object(download, "download_file") as fetch:
            with patch.object(download.shutil, "disk_usage", return_value=SimpleNamespace(free=requirements["minimumFreeBytes"] - 1)):
                with self.assertRaisesRegex(RuntimeError, r"Free at least 5\.69 GB"):
                    download._install_model(model_id, directory, lambda _: None)
            fetch.assert_not_called()
            fetch.side_effect = RuntimeError("First download started")
            with patch.object(download.shutil, "disk_usage", return_value=SimpleNamespace(free=requirements["minimumFreeBytes"])):
                with self.assertRaisesRegex(RuntimeError, "First download started"):
                    download._install_model(model_id, directory, lambda _: None)
            fetch.assert_called_once()

    def test_paused_download_keeps_partial_bytes_and_resumes_at_the_saved_range(self):
        content = b"abcdef"
        filename = "small.bin"
        file = {"path": filename, "size": len(content), "algorithm": "sha256", "digest": hashlib.sha256(content).hexdigest()}
        spec = {"folder": "fixture", "files": [file]}
        pause = Event()
        ranges = []

        class DownloadHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                requested = self.headers.get("Range")
                ranges.append(requested)
                self.send_response(206 if requested else 200)
                self.send_header("Content-Length", "3" if requested else "6")
                if requested:
                    self.send_header("Content-Range", "bytes 3-5/6")
                self.end_headers()
                self.wfile.write(content[3:] if requested else content[:3])

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as tmp, ThreadingHTTPServer(("127.0.0.1", 0), DownloadHandler) as server:
            serving = Thread(target=server.serve_forever, daemon=True)
            serving.start()
            url = f"http://127.0.0.1:{server.server_port}/file"
            try:
                root = Path(tmp)
                target = root / "fixture.download" / filename
                partial = target.with_name(filename + ".part")
                partial.parent.mkdir()
                partial.touch()
                self.assertFalse(download.has_partial_download(root, spec))
                with self.assertRaises(download.TextModelDownloadPaused):
                    download.download_file(url, target, file, lambda _: pause.set(), pause=pause)
                self.assertEqual(partial.read_bytes(), b"abc")
                self.assertTrue(download.has_partial_download(root, spec))
                self.assertFalse(target.exists())
                download.download_file(url, target, file, lambda _: None, pause=Event())
                self.assertEqual(ranges, [None, "bytes=3-"])
                self.assertEqual(target.read_bytes(), content)
                self.assertTrue(download.verified(target, file))
                self.assertFalse(partial.exists())
            finally:
                server.shutdown()
                serving.join(5)

    def test_timeout_after_pause_is_not_a_failed_download(self):
        content = b"abcdef"
        file = {"path": "small.bin", "size": len(content), "algorithm": "sha256", "digest": hashlib.sha256(content).hexdigest()}
        pause = Event()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / file["path"]
            partial = target.with_name(target.name + ".part")
            partial.write_bytes(content[:3])
            response = FakeResponse(b"", 206, {"Content-Range": "bytes 3-5/6"})

            def timeout(_size):
                pause.set()
                raise TimeoutError("peer stopped sending")

            response.read1 = timeout
            with patch.object(download.urllib.request, "urlopen", return_value=response):
                with self.assertRaises(download.TextModelDownloadPaused):
                    download.download_file("https://example.invalid/file", target, file, lambda _: None, pause=pause)
            self.assertEqual(partial.read_bytes(), content[:3])

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
