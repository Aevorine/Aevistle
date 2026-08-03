"""
Generate the GitHub social preview card — `python scripts/generate-social-preview.py`.

This is the image GitHub shows when the repository is linked on X, Reddit,
Slack, Discord or a chat app. A repository without one renders as a grey box
with an avatar, which is the difference between a link people click and a link
they scroll past.

GitHub wants 1280x640 (2:1) and crops anything else, so the safe area is kept
well inside the edges. Output: docs/assets/social-preview.png.

Upload it under Settings -> General -> Social preview; there is no API for it.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "docs" / "assets"
OUT = ASSETS / "social-preview.png"

W, H = 1280, 640
INK = (14, 17, 24)
MUTED = (110, 120, 138)
ACCENT = (79, 70, 229)
CARD = (255, 255, 255)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    """Fall back to whatever exists rather than dying on a missing font."""
    for candidate in (name, "segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


BOLD = "segoeuib.ttf"
REG = "segoeui.ttf"


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def main() -> None:
    img = Image.new("RGB", (W, H), CARD)
    draw = ImageDraw.Draw(img)

    # A soft diagonal wash instead of a flat white: it reads as designed rather
    # than as a default, and stays legible in both light and dark chat clients.
    for y in range(H):
        t = y / H
        draw.line(
            [(0, y), (W, y)],
            fill=(
                int(255 - 12 * t),
                int(255 - 12 * t),
                int(255 - 6 * t),
            ),
        )

    # Accent bar down the left edge.
    draw.rectangle([0, 0, 10, H], fill=ACCENT)

    x = 96
    y = 118

    logo_path = ASSETS / "logo.png"
    if logo_path.exists():
        logo = Image.open(logo_path).convert("RGBA").resize((112, 112), Image.LANCZOS)
        img.paste(logo, (x, y - 8), logo)
        x_text = x + 112 + 28
    else:
        x_text = x

    draw.text((x_text, y + 6), "Aevistle", font=font(BOLD, 76), fill=INK)
    draw.text((x_text, y + 92), "v0.1.0  ·  MIT", font=font(REG, 26), fill=MUTED)

    draw.text(
        (x, 300),
        "Scheduled email reminders that actually arrive",
        font=font(BOLD, 44),
        fill=INK,
    )
    draw.text(
        (x, 362),
        "Attach files, images or archives. Set a recurring or cron schedule.",
        font=font(REG, 30),
        fill=MUTED,
    )
    draw.text(
        (x, 402),
        "It sends on time — even with the window closed.",
        font=font(REG, 30),
        fill=MUTED,
    )

    chips = ["Windows", "Android", "6 languages", "No server", "No account"]
    cx = x
    cy = 486
    chip_font = font(REG, 24)
    for chip in chips:
        w = draw.textlength(chip, font=chip_font)
        rounded(draw, [cx, cy, cx + w + 36, cy + 46], 23, (238, 239, 246))
        draw.text((cx + 18, cy + 10), chip, font=chip_font, fill=(70, 78, 98))
        cx += w + 36 + 14

    img.save(OUT, "PNG", optimize=True)
    print(f"{OUT}  {OUT.stat().st_size / 1024:.1f} KB  ({W}x{H})")


if __name__ == "__main__":
    main()
