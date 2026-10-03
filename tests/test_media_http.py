import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from media_http import byte_range


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
