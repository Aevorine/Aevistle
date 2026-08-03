"""
Generate the Android launcher icons from the same master artwork as the
desktop icon, so both platforms cannot drift apart.

Writes, for every density:
    mipmap-*/ic_launcher.png             legacy square icon
    mipmap-*/ic_launcher_round.png       legacy round icon
    mipmap-*/ic_launcher_foreground.png  adaptive-icon foreground layer
    mipmap-*/ic_launcher_background.png  adaptive-icon background layer

The background is a bitmap rather than the flat colour it used to be. The
artwork's field is a gradient, so a flat fill left a visible step wherever the
foreground square ended. Painting the background from the artwork's own edge
profile (see generate_icons_lib.edge_profile) makes that boundary disappear.

The foreground is the master at 94% of the 108dp canvas. Android only
guarantees the middle 72dp is visible, and the envelope-and-clock core of the
artwork spans about 66% of its own width — 0.94 x 0.66 x 108dp lands at 67dp,
just inside that guarantee. The cyan swoosh does run past it and gets clipped
by the launcher mask, which is what it is drawn to do.
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_icons_lib import background_field, build_master, mid_background  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")

# Legacy launcher icon sizes, in px, per density bucket.
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# Adaptive layers are always 108dp square.
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

SAFE_FRACTION = 0.94

ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
"""


def round_icon(master: Image.Image, size: int) -> Image.Image:
    scaled = master.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(scaled, (0, 0), mask.resize((size, size), Image.LANCZOS))
    return out


def adaptive_foreground(master: Image.Image, size: int) -> Image.Image:
    inner = round(size * SAFE_FRACTION)
    mark = master.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - inner) // 2
    canvas.paste(mark, (offset, offset), mark)
    return canvas


def main() -> None:
    master = build_master()

    for density, size in LEGACY.items():
        directory = os.path.join(RES, f"mipmap-{density}")
        os.makedirs(directory, exist_ok=True)
        master.resize((size, size), Image.LANCZOS).save(
            os.path.join(directory, "ic_launcher.png")
        )
        round_icon(master, size).save(os.path.join(directory, "ic_launcher_round.png"))

    for density, size in ADAPTIVE.items():
        directory = os.path.join(RES, f"mipmap-{density}")
        adaptive_foreground(master, size).save(
            os.path.join(directory, "ic_launcher_foreground.png")
        )
        background_field(size, SAFE_FRACTION).save(
            os.path.join(directory, "ic_launcher_background.png")
        )

    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        path = os.path.join(RES, "mipmap-anydpi-v26", name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(ADAPTIVE_XML)

    # Kept as a fallback for anything that still resolves the colour resource
    # (the splash theme does), and so the two never disagree about the hue.
    background = "#%02X%02X%02X" % mid_background()
    values = os.path.join(RES, "values", "ic_launcher_background.xml")
    with open(values, "w", encoding="utf-8") as handle:
        handle.write(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<resources>\n"
            f'    <color name="ic_launcher_background">{background}</color>\n'
            "</resources>\n"
        )

    total = 0
    count = 0
    for density in LEGACY:
        directory = os.path.join(RES, f"mipmap-{density}")
        for name in (
            "ic_launcher.png",
            "ic_launcher_round.png",
            "ic_launcher_foreground.png",
            "ic_launcher_background.png",
        ):
            total += os.path.getsize(os.path.join(directory, name))
            count += 1
    print(f"  wrote {count} launcher icons ({total} bytes total)")
    print(f"  adaptive background bitmap + colour fallback {background}")


if __name__ == "__main__":
    main()
