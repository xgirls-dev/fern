from __future__ import annotations

import json
import struct
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps" / "desktop"


class BrandingTests(unittest.TestCase):
    def test_public_product_identity_is_fern(self) -> None:
        root_package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        desktop_package = json.loads(
            (DESKTOP / "package.json").read_text(encoding="utf-8")
        )

        self.assertEqual(root_package["name"], "fern")
        self.assertEqual(desktop_package["name"], "@fern/desktop")
        self.assertEqual(desktop_package["build"]["productName"], "Fern")
        self.assertEqual(
            desktop_package["build"]["win"]["artifactName"],
            "Fern-Setup-${version}.${ext}",
        )
        self.assertNotIn(
            "signAndEditExecutable",
            desktop_package["build"]["win"],
        )

    def test_public_surfaces_do_not_use_retired_names(self) -> None:
        public_files = [
            ROOT / "README.md",
            ROOT / "CONTRIBUTING.md",
            ROOT / ".github" / "workflows" / "release.yml",
            DESKTOP / "src" / "renderer" / "index.html",
            DESKTOP / "src" / "renderer" / "src" / "App.tsx",
            DESKTOP / "src" / "renderer" / "src" / "components" / "TitleBar.tsx",
        ]
        for path in public_files:
            text = path.read_text(encoding="utf-8").lower()
            self.assertNotIn("praxilume", text, path)
            self.assertNotIn("iris", text, path)

    def test_windows_icon_contains_required_sizes(self) -> None:
        icon_data = (DESKTOP / "resources" / "icon.ico").read_bytes()
        reserved, image_type, image_count = struct.unpack_from("<HHH", icon_data)
        self.assertEqual((reserved, image_type), (0, 1))

        sizes: set[tuple[int, int]] = set()
        for index in range(image_count):
            width, height = struct.unpack_from(
                "<BB",
                icon_data,
                6 + index * 16,
            )
            sizes.add((width or 256, height or 256))
        self.assertTrue({(16, 16), (32, 32), (48, 48), (256, 256)} <= sizes)


if __name__ == "__main__":
    unittest.main()
