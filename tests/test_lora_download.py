import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lora_download import LoraDownloadManager


class Response(io.BytesIO):
    def __init__(self, data):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))}


class LoraDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manager = LoraDownloadManager(Path(self.temp.name))

    def test_huggingface_file_link_and_civitai_model_page(self):
        resolved, name = self.manager._resolve("https://huggingface.co/a/b/blob/main/style.safetensors")
        self.assertEqual(resolved, "https://huggingface.co/a/b/resolve/main/style.safetensors")
        self.assertEqual(name, "style.safetensors")
        repository = {"sha": "a" * 40, "siblings": [{"rfilename": "nested/style.safetensors"}]}
        with patch("urllib.request.urlopen", return_value=Response(json.dumps(repository).encode())):
            self.assertEqual(self.manager._resolve("https://huggingface.co/a/b"), (f"https://huggingface.co/a/b/resolve/{'a' * 40}/nested/style.safetensors", "style.safetensors"))
        data = {"modelVersions": [{"id": 7, "files": [{"name": "bot.safetensors", "primary": True, "downloadUrl": "https://civitai.com/api/download/models/7"}]}]}
        with patch("urllib.request.urlopen", return_value=Response(json.dumps(data).encode())):
            self.assertEqual(self.manager._resolve("https://civitai.com/models/42/bot"), ("https://civitai.com/api/download/models/7", "bot.safetensors"))

    def test_download_validates_and_reuses_file(self):
        header = json.dumps({"transformer.layer.lora_A.weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
        data = len(header).to_bytes(8, "little") + header + b"1234"
        url = "https://huggingface.co/a/b/resolve/main/style.safetensors"
        with patch("urllib.request.urlopen", return_value=Response(data)) as open_url:
            self.manager.state = {"status": "checking", "downloaded": 0}
            self.manager._run(url, threading.Event())
            result = self.manager.snapshot()
            self.assertEqual(result["status"], "complete")
            self.assertEqual(Path(result["path"]).read_bytes(), data)
            self.manager.state = {"status": "checking", "downloaded": 0}
            self.manager._run(url, threading.Event())
            self.assertEqual(open_url.call_count, 1)

    def test_invalid_download_is_removed(self):
        with patch("urllib.request.urlopen", return_value=Response(b"<html>login</html>")):
            self.manager.state = {"status": "checking", "downloaded": 0}
            self.manager._run("https://huggingface.co/a/b/resolve/main/style.safetensors", threading.Event())
        self.assertEqual(self.manager.snapshot()["status"], "failed")
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_untrusted_source_is_rejected(self):
        with self.assertRaises(ValueError):
            self.manager.start("http://localhost/private.safetensors")

    def test_api_starts_and_reports_download(self):
        import api_server
        handler = object.__new__(api_server.Handler)
        handler.path = "/api/loras/download"
        handler.read_json_body = Mock(return_value={"url": "https://huggingface.co/a/b"})
        handler.send_json = Mock()
        with patch.object(api_server, "LORA_DOWNLOAD") as manager:
            manager.snapshot.return_value = {"status": "checking"}
            handler.handle_post()
        manager.start.assert_called_once_with("https://huggingface.co/a/b")
        handler.send_json.assert_called_once_with(202, {"status": "checking"})


if __name__ == "__main__":
    unittest.main()
