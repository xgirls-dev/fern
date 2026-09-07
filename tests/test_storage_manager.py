from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import storage_manager


class StorageManagerTests(unittest.TestCase):
    def test_cleanup_removes_expired_cache_and_keeps_recent_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / ".cache"
            expired = cache / "expired.blob"
            recent = cache / "recent.blob"
            cache.mkdir()
            expired.write_bytes(b"old")
            recent.write_bytes(b"new")
            old_time = time.time() - (storage_manager.CACHE_RETENTION_DAYS + 1) * 86400
            os.utime(expired, (old_time, old_time))

            result = storage_manager.cleanup_cache(root, cache)

            self.assertFalse(expired.exists())
            self.assertTrue(recent.exists())
            self.assertEqual(result["removedFiles"], 1)
            self.assertEqual(result["afterBytes"], 3)

    def test_force_cleanup_clears_nested_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / ".cache"
            nested = cache / "openvino" / "model"
            nested.mkdir(parents=True)
            (nested / "compiled.blob").write_bytes(b"cache")

            result = storage_manager.cleanup_cache(root, cache, force=True)

            self.assertEqual(result["afterBytes"], 0)
            self.assertEqual(result["removedFiles"], 1)
            self.assertFalse((nested / "compiled.blob").exists())

    def test_cleanup_prunes_oldest_files_to_the_disk_aware_cap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / ".cache"
            cache.mkdir()
            oldest = cache / "oldest.blob"
            newest = cache / "newest.blob"
            oldest.write_bytes(b"1234")
            newest.write_bytes(b"5678")
            now = time.time()
            os.utime(oldest, (now - 60, now - 60))
            os.utime(newest, (now, now))

            with patch.object(
                storage_manager,
                "cache_policy",
                return_value={"retentionDays": 30, "maxBytes": 5, "reserveBytes": 0},
            ):
                result = storage_manager.cleanup_cache(root, cache)

            self.assertFalse(oldest.exists())
            self.assertTrue(newest.exists())
            self.assertEqual(result["afterBytes"], 4)

    def test_storage_status_separates_models_from_managed_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / ".cache"
            outputs = root / "outputs"
            data = root / "data"
            models = root / "models"
            for path in (cache, outputs, data, models):
                path.mkdir()
            (cache / "cache.bin").write_bytes(b"12")
            (outputs / "image.png").write_bytes(b"345")
            (data / "gallery.json").write_bytes(b"6789")
            (models / "model.bin").write_bytes(b"model")

            status = storage_manager.storage_status(
                root,
                cache_dir=cache,
                outputs_dir=outputs,
                data_dir=data,
                models_dir=models,
            )

            self.assertEqual(status["managedBytes"], 9)
            self.assertEqual(status["models"]["bytes"], 5)
            self.assertTrue(status["models"]["preservedOnReset"])


if __name__ == "__main__":
    unittest.main()
