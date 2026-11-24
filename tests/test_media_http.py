import io
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from media_http import byte_range
import api_server
import gallery_store


class MediaRangeTests(unittest.TestCase):
    def test_full_and_partial_reads(self):
        self.assertIsNone(byte_range(None, 100))
        self.assertEqual(byte_range("bytes=0-0", 100), (0, 0))
        self.assertEqual(byte_range("bytes=40-", 100), (40, 99))
        self.assertEqual(byte_range("bytes=0-999", 100), (0, 99))
        self.assertEqual(byte_range("bytes=-20", 100), (80, 99))
        self.assertEqual(byte_range("bytes=-200", 100), (0, 99))

    def test_bad_and_unsatisfiable_ranges(self):
        for header in ("bytes=100-", "bytes=30-10", "bytes=-0", "bytes=-", "bytes=0-2,4-8", "garbage"):
            with self.subTest(header=header), self.assertRaises(ValueError):
                byte_range(header, 100)
        with self.assertRaises(ValueError):
            byte_range("bytes=0-", 0)


class GalleryMediaTests(unittest.TestCase):
    def test_serves_cached_thumbnails_and_keeps_versioned_assets_consistent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = root / "outputs"
            outputs.mkdir()
            original = outputs / "sample image.png"
            Image.new("RGBA", (1536, 768), (25, 70, 210, 128)).save(original)
            stamp = original.stat()

            with (
                patch.object(api_server, "OUTPUTS", outputs),
                patch.object(api_server, "CACHE_DIR", root / "cache"),
                patch.object(gallery_store, "GALLERY_PATH", root / "gallery.json"),
                ThreadingHTTPServer(("127.0.0.1", 0), api_server.Handler) as server,
            ):
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                base = f"http://127.0.0.1:{server.server_port}"
                try:
                    [record] = api_server.latest_images()
                    with urllib.request.urlopen(base + record["thumbnailUrl"]) as response:
                        self.assertEqual(response.headers["Content-Type"], "image/webp")
                        self.assertIn("immutable", response.headers["Cache-Control"])
                        thumbnail = response.read()
                    with Image.open(io.BytesIO(thumbnail)) as preview:
                        self.assertEqual(preview.size, (512, 256))
                        self.assertEqual(preview.getpixel((30, 30))[3], 128)

                    with patch.object(gallery_store.Image, "open", side_effect=AssertionError("Warm thumbnails should use the cache")):
                        with urllib.request.urlopen(base + record["thumbnailUrl"]) as response:
                            self.assertEqual(response.read(), thumbnail)

                    request = urllib.request.Request(base + record["url"], headers={"Range": "bytes=0-15"})
                    with urllib.request.urlopen(request) as response:
                        self.assertEqual(response.status, 206)
                        self.assertEqual(response.read(), original.read_bytes()[:16])

                    replacement = outputs / "replacement.png"
                    Image.new("RGB", (768, 1536), "orange").save(replacement)
                    os.utime(replacement, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                    replacement.replace(original)
                    updated = api_server.image_record(original)
                    self.assertNotEqual(updated["thumbnailUrl"], record["thumbnailUrl"])
                    with urllib.request.urlopen(base + record["thumbnailUrl"]) as response:
                        self.assertEqual(response.headers["Cache-Control"], "no-store")
                        with Image.open(io.BytesIO(response.read())) as preview:
                            self.assertEqual(preview.size, (256, 512))
                finally:
                    server.shutdown()
                    worker.join()
