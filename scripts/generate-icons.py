"""
Generate the Aevistle desktop and documentation icons.

Every output derives from `build/source-icon.png`, which is the one piece of
artwork in the project. Keeping it in the repo means the whole icon set can be
rebuilt on any machine — no hand-exported binaries that nobody can regenerate.

Outputs:
    build/icon.ico          Windows installer + executable (7 sizes)
    build/icon.png          1024px master, used by the Linux/macOS targets
    build/tray.png          32px tray icon
    build/tray@2x.png       64px tray icon, for scaled displays
    docs/assets/logo.png    512px, for the README
    src/assets/brand.png    128px, the mark in the sidebar
    public/favicon.png      64px, the document icon (Vite serves public/ at /)

Android launcher icons come from generate-android-icons.py, which shares the
same master artwork.
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageEnhance, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_icons_lib import background_field, build_master, squircle_alpha  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
DOCS = os.path.join(ROOT, "docs", "assets")
ASSETS = os.path.join(ROOT, "src", "assets")
PUBLIC = os.path.join(ROOT, "public")

# How much of the master the tray icon keeps. The artwork breathes — the mark
# sits inside a wide field of background — and at 16px that padding is most of
# the icon. Cropping to the mark buys back roughly a third of the pixel budget,
# which is the difference between a recognisable envelope and a blue smudge.
TRAY_CROP = 0.80


def tray(size: int) -> Image.Image:
    """The mark, cropped in and re-sharpened for the notification area."""
    master = build_master()
    side = round(master.width * TRAY_CROP)
    offset = (master.width - side) // 2
    cropped = master.crop((offset, offset, offset + side, offset + side))

    # Two-step downscale: straight to 32px from 819px loses the thin clock
    # hands entirely, because LANCZOS averages them away against the dial.
    out = cropped.resize((size * 4, size * 4), Image.LANCZOS).resize(
        (size, size), Image.LANCZOS
    )

    # Unsharp, then a nudge of contrast. Tray icons are viewed at a glance
    # against an unpredictable background; edge definition matters more than
    # fidelity to the original at this size.
    out = out.filter(ImageFilter.UnsharpMask(radius=1.1, percent=110, threshold=2))
    rgb, alpha = out.convert("RGB"), out.getchannel("A")
    rgb = ImageEnhance.Contrast(rgb).enhance(1.12)
    rgb.putalpha(alpha)

    # Cropping into the artwork leaves four square corners, which read as a
    # blue box in the notification area rather than as an icon. Round them
    # back off at the proportion the artwork itself uses.
    rgb.putalpha(squircle_alpha(size, round(size * 0.23)))
    return rgb


def installer_sidebar(width: int, height: int) -> Image.Image:
    """The welcome/finish panel of the Windows installer.

    NSIS wants a bitmap with no alpha channel, so the icon is composited onto
    the artwork's own gradient rather than left transparent — which also makes
    the panel and the icon read as one object instead of a logo pasted on a
    background.
    """
    field = background_field(max(width, height)).resize((width, height), Image.LANCZOS)
    panel = field.convert("RGBA")
    mark = build_master().resize((round(width * 0.62),) * 2, Image.LANCZOS)
    panel.alpha_composite(
        mark, ((width - mark.width) // 2, round(height * 0.30) - mark.height // 2)
    )
    return panel.convert("RGB")


def installer_header(width: int, height: int) -> Image.Image:
    """The strip along the top of every installer page after the first.

    White, because NSIS draws it against the wizard's own white header and a
    coloured block there looks like a rendering fault rather than branding.
    """
    header = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    side = height - 10
    mark = build_master().resize((side, side), Image.LANCZOS)
    header.alpha_composite(mark, (width - side - 8, (height - side) // 2))
    return header.convert("RGB")


def main() -> None:
    for directory in (BUILD, DOCS, ASSETS, PUBLIC):
        os.makedirs(directory, exist_ok=True)

    master = build_master()

    master.save(os.path.join(BUILD, "icon.png"), optimize=True)
    master.resize((512, 512), Image.LANCZOS).save(
        os.path.join(DOCS, "logo.png"), optimize=True
    )
    master.resize((128, 128), Image.LANCZOS).save(
        os.path.join(ASSETS, "brand.png"), optimize=True
    )
    master.resize((64, 64), Image.LANCZOS).save(
        os.path.join(PUBLIC, "favicon.png"), optimize=True
    )
    tray(32).save(os.path.join(BUILD, "tray.png"), optimize=True)
    tray(64).save(os.path.join(BUILD, "tray@2x.png"), optimize=True)

    # Pillow builds the multi-resolution .ico itself; listing the sizes keeps
    # the small ones sharp instead of letting Windows downscale the 256px one.
    master.save(
        os.path.join(BUILD, "icon.ico"),
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    # NSIS wizard art. The sizes are fixed by NSIS itself, not by taste.
    installer_header(150, 57).save(os.path.join(BUILD, "installerHeader.bmp"))
    sidebar = installer_sidebar(164, 314)
    sidebar.save(os.path.join(BUILD, "installerSidebar.bmp"))
    sidebar.save(os.path.join(BUILD, "uninstallerSidebar.bmp"))

    written = [
        (BUILD, "icon.png"),
        (BUILD, "icon.ico"),
        (BUILD, "tray.png"),
        (BUILD, "tray@2x.png"),
        (BUILD, "installerHeader.bmp"),
        (BUILD, "installerSidebar.bmp"),
        (BUILD, "uninstallerSidebar.bmp"),
        (DOCS, "logo.png"),
        (ASSETS, "brand.png"),
        (PUBLIC, "favicon.png"),
    ]
    for directory, name in written:
        path = os.path.join(directory, name)
        print(f"  {name:22} {os.path.getsize(path):>8} bytes")


if __name__ == "__main__":
    main()
