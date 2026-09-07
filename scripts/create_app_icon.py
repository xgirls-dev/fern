from __future__ import annotations

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "apps" / "desktop" / "resources"
SOURCE = RESOURCES / "brand" / "fern-icon.png"
PNG_TARGET = RESOURCES / "icon.png"
ICO_TARGET = RESOURCES / "icon.ico"
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)


def build_icon() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    alpha_box = source.getchannel("A").getbbox()
    if not alpha_box:
        raise RuntimeError(f"Icon source has no visible pixels: {SOURCE}")

    cropped = source.crop(alpha_box)
    side = max(cropped.size)
    padding = max(8, round(side * 0.035))
    canvas_side = side + padding * 2
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.alpha_composite(
        cropped,
        ((canvas_side - cropped.width) // 2, (canvas_side - cropped.height) // 2),
    )

    master = canvas.resize((512, 512), Image.Resampling.LANCZOS)
    master.save(PNG_TARGET, optimize=True)
    master.save(ICO_TARGET, format="ICO", sizes=[(size, size) for size in ICON_SIZES])
    print(f"Created {PNG_TARGET}")
    print(f"Created {ICO_TARGET} with sizes: {', '.join(map(str, ICON_SIZES))}")


if __name__ == "__main__":
    build_icon()
