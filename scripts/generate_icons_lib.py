"""
The Aevistle mark, prepared from the artwork in `build/source-icon.png`.

Shared by generate-icons.py (desktop + docs) and generate-android-icons.py
(launcher icons) so the two platforms can never drift apart.

The artwork ships as flat RGB with the squircle's corners painted *black*
rather than left transparent. Pasted straight into an .ico that reads as four
black wedges on the taskbar, so the corners are cut here instead: the radius is
fitted to the artwork (see corner_radius) and the mask is built at 4x and
downsampled, which gives a clean edge on both light and dark backgrounds.
"""

from __future__ import annotations

import os
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "build", "source-icon.png")

S = 1024  # master canvas

# Supersampling factor for the corner mask. The arc is the only curve in the
# icon that we draw ourselves, so it is the only place that would show stairs.
SS = 4

# The artwork's corners are black, not transparent. Anything this dark near an
# edge is corner padding rather than art.
DARK = 45


@lru_cache(maxsize=1)
def _source() -> Image.Image:
    if not os.path.exists(SOURCE):
        raise SystemExit(
            f"missing {os.path.relpath(SOURCE, ROOT)} — the icon artwork is an "
            "input to the build and lives in the repo so icons can be "
            "regenerated without it."
        )
    return Image.open(SOURCE).convert("RGB")


def squircle_alpha(size: int, radius: int) -> Image.Image:
    """Antialiased rounded-rectangle mask, drawn large and scaled down."""
    mask = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * SS - 1, size * SS - 1), radius * SS, fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


@lru_cache(maxsize=1)
def corner_radius() -> int:
    """The smallest corner radius, at master scale, that leaves no black behind.

    Reading the radius off where the arc meets an edge gets it wrong: the
    artwork's corners fade to black over a dozen pixels, so the geometric arc
    and the last *dark* pixel are not in the same place, and a mask fitted to
    the former keeps a black hairline all the way round — which is exactly what
    the first cut of this did. Instead the radius is grown until the corner
    boxes contain nothing dark, which is the property actually wanted.

    Fitted on a small copy because the answer only needs to be right to within
    the margin added at the end, and a 4x-supersampled mask at master scale is
    16 megapixels a try.
    """
    probe = 256
    small = _source().resize((probe, probe), Image.LANCZOS)
    px = small.load()

    def clean(radius: int) -> bool:
        alpha = squircle_alpha(probe, radius).load()
        corners = (
            (0, 0),
            (probe - radius, 0),
            (0, probe - radius),
            (probe - radius, probe - radius),
        )
        for ox, oy in corners:
            for y in range(oy, oy + radius):
                for x in range(ox, ox + radius):
                    if alpha[x, y] > 8 and sum(px[x, y]) < DARK * 4:
                        return False
        return True

    radius = round(probe * 0.19)
    limit = round(probe * 0.34)
    while radius < limit and not clean(radius):
        radius += 1
    # A pixel or two of margin at master scale. Losing them costs a sliver of
    # blue nobody can see; keeping them risks the hairline coming back if the
    # artwork is ever re-exported with a softer edge.
    return round(radius * S / probe) + 4


@lru_cache(maxsize=1)
def build_master() -> Image.Image:
    """The artwork at 1024px with its corners cut to transparency."""
    master = _source().resize((S, S), Image.LANCZOS).convert("RGBA")
    master.putalpha(squircle_alpha(S, corner_radius()))
    return master


def _wall_profile(px, columns: range | list[int], radius: int) -> list[tuple[int, int, int]]:
    """The field colour down one wall of the artwork, row by row."""
    raw: list[tuple[int, int, int]] = []
    for y in range(S):
        band = [px[x, y] for x in columns if sum(px[x, y]) > DARK]
        if not band:  # inside a corner arc — borrow the nearest sampled row
            band = [raw[-1]] if raw else [(0, 128, 248)]
        # By luminance, not by blue: every colour in this artwork pins the blue
        # channel near 250, so sorting on it orders the samples at random and
        # the "median" lands wherever. Luminance is what actually separates the
        # deep field at the bottom from the cyan swoosh crossing it.
        band.sort(key=sum)
        raw.append(band[len(band) // 2])

    # The corner rows carry only a sliver of wall, so hold them at the first
    # and last rows that had a full sample.
    for y in range(radius):
        raw[y] = raw[radius]
        raw[S - 1 - y] = raw[S - 1 - radius]

    window = 96
    return [
        tuple(
            sum(p[c] for p in raw[max(0, y - window) : min(S, y + window + 1)])
            // len(raw[max(0, y - window) : min(S, y + window + 1)])
            for c in range(3)
        )
        for y in range(S)
    ]


@lru_cache(maxsize=1)
def edge_profile() -> tuple[list[tuple[int, int, int]], list[tuple[int, int, int]]]:
    """The background behind the mark, sampled down the left and right walls.

    Two profiles rather than one: the artwork's field is not a vertical
    gradient. At mid-height the left wall sits around (84,184,253) and the
    right around (142,237,253), so a single median profile is wrong on both
    sides by half the difference — which is exactly the tonal step that showed
    up at the edge of Android's adaptive foreground layer. Interpolating
    between the two walls reproduces the field on both axes.

    The rows the cyan swoosh runs out to are smoothed over rather than
    special-cased; a hard window is enough because the swoosh crosses each wall
    once and the field either side of it agrees.
    """
    src = _source().resize((S, S), Image.LANCZOS)
    px = src.load()
    radius = corner_radius()
    return (
        _wall_profile(px, range(0, 12), radius),
        _wall_profile(px, range(S - 12, S), radius),
    )


def background_field(size: int, content_scale: float = 1.0) -> Image.Image:
    """A full-bleed rectangle of the artwork's own background gradient.

    `content_scale` is the fraction of the canvas that a copy of the artwork
    will be drawn over. The gradient is stretched to match that copy pixel for
    pixel and held flat beyond it, so the seam where the copy ends is exact
    rather than merely close.
    """
    left, right = edge_profile()
    span = size * content_scale
    start = (size - span) / 2

    # Built at the master's own resolution in one axis and stretched in the
    # other: the field has no detail, so bilinear costs nothing and the blur
    # afterwards removes the banding that integer channel steps would leave.
    field = Image.new("RGB", (2, size))
    px = field.load()
    for y in range(size):
        t = min(1.0, max(0.0, (y - start) / span))
        row = min(S - 1, round(t * (S - 1)))
        px[0, y] = left[row]
        px[1, y] = right[row]

    stretched = field.resize((size, size), Image.BILINEAR)
    if content_scale < 1.0:
        # The horizontal stretch put the two walls at the canvas edges, but the
        # copy's walls land at `start` and `start + span`. Scale up so they
        # coincide, then crop back.
        wide = round(size / content_scale)
        stretched = stretched.resize((wide, size), Image.BILINEAR).crop(
            ((wide - size) // 2, 0, (wide - size) // 2 + size, size)
        )
    return stretched.filter(ImageFilter.GaussianBlur(max(1, size // 128)))


def mid_background() -> tuple[int, int, int]:
    """One representative background colour, for places that want a hex."""
    left, right = edge_profile()
    return tuple((left[S // 2][c] + right[S // 2][c]) // 2 for c in range(3))
