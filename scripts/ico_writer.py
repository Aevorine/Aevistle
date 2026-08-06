"""
Write a Windows .ico with conventionally-encoded frames.

The rule this module implements:

    every frame up to and including 128x128 is written as BMP/DIB,
    and only the 256x256 frame is written as PNG.

That is how essentially every Windows icon toolchain emits an .ico, and Pillow
is the odd one out: `Image.save(..., format="ICO", sizes=[...])` PNG-compresses
*every* frame, including the 16px one. Pillow cannot emit BMP/DIB frames inside
an .ico at all — there is no flag for it — which is why the container is
assembled here by hand.

## Read this before you blame the encoding for a blank icon

This module was written while chasing a bug where the app's icon rendered blank
in the Start menu, on the taskbar and on the desktop shortcut. The all-PNG .ico
was the prime suspect, on the widely-repeated theory that the shell only honours
PNG frames at 256x256 and draws nothing when handed one at 16/32/48.

**That theory was tested and is false on Windows 11.** The 0.1.17 executable,
built from the old all-PNG icon, was interrogated with `PrivateExtractIcons` —
the API the shell itself uses — and returned correct, fully-opaque artwork at
16, 32 and 48 (252/256, 992/1024 and 2212/2304 non-transparent pixels). The
shell had no difficulty with those frames whatsoever.

The blank icon had nothing to do with this file. Its cause was the 285-character
`description` that electron-builder passed to the NSIS `CreateShortCut` call:
a .lnk stores its strings as a chain of length-prefixed UTF-16 runs, the name
field's count saturates at 260 (MAX_PATH), and every field after it — including
ICON_LOCATION — is then read from the wrong offset. The fix is the
`extraMetadata.description` override in `electron-builder.yml`; the cliff is
exactly between a 260- and a 261-character description.

So this module is kept because DIB-at-small-sizes is the conventional encoding
and costs nothing, **not** because it fixed anything. Do not cite it as the
cure for a blank icon, and do not let its existence send the next investigation
back down this same dead end.

## The format

    ICONDIR         6 bytes    reserved=0, type=1, image count
    ICONDIRENTRY    16 bytes   one per frame, immediately after the ICONDIR
    payloads                   at the offsets named by the entries

A BMP frame's payload is *not* a .bmp file: it has no BITMAPFILEHEADER, and its
BITMAPINFOHEADER declares `biHeight` as **twice** the real height. That doubling
is the format's oldest trap. It is not a mistake — it accounts for the two
stacked bitmaps in the payload: the XOR bitmap (the colour pixels) and, below
it, the 1-bit-per-pixel AND mask. Get it wrong and the icon renders squashed
into the top half of its box with garbage underneath.

256-as-PNG is kept because a 256x256 BMP frame is ~256 KB on its own, and the
shell has always supported PNG at that size.
"""

from __future__ import annotations

import io
import struct
from typing import Sequence

from PIL import Image

# The only size the Windows shell reliably decodes as PNG. Everything smaller
# has to be a BMP/DIB frame — see the module docstring.
PNG_SIZE = 256


def _and_mask(alpha: Image.Image) -> bytes:
    """The 1-bpp transparency mask that follows the colour bitmap.

    A 32-bit frame carries its own alpha channel, and that is what modern
    Windows composites with — but the mask is still a required part of the
    payload (the doubled `biHeight` promises it is there), and legacy paths in
    the shell do fall back to it. So it is derived from the real alpha rather
    than zero-filled.

    A set bit means "transparent". Only fully transparent pixels get one:
    the antialiased fringe around the squircle's corners has partial alpha and
    must stay opaque here, or the mask would chew a hard jagged edge into the
    very curve that generate_icons_lib.py goes to such lengths to smooth.

    Rows run bottom-up like the colour bitmap, and each is padded out to a
    4-byte boundary — the stride is computed from the width, not from the row
    it happens to produce.
    """
    width, height = alpha.size
    stride = ((width + 31) // 32) * 4
    pixels = alpha.tobytes()  # top-down, one byte per pixel

    rows = []
    for y in range(height - 1, -1, -1):
        row = bytearray(stride)
        base = y * width
        for x in range(width):
            if pixels[base + x] == 0:
                row[x >> 3] |= 0x80 >> (x & 7)
        rows.append(bytes(row))
    return b"".join(rows)


def _bmp_frame(image: Image.Image) -> bytes:
    """One BMP/DIB frame: BITMAPINFOHEADER, then XOR colours, then AND mask."""
    width, height = image.size

    # BGRA, because a DIB stores channels in that order, and bottom-up, because
    # a positive biHeight means the first row in the file is the *last* row of
    # the image. At 32bpp the stride is width*4, which is already 4-byte
    # aligned, so no per-row padding is needed here (unlike the AND mask).
    top_down = image.tobytes("raw", "BGRA")
    stride = width * 4
    xor = b"".join(
        top_down[y * stride : (y + 1) * stride] for y in range(height - 1, -1, -1)
    )

    mask = _and_mask(image.getchannel("A"))

    header = struct.pack(
        "<IiiHHIIiiII",
        40,                    # biSize
        width,                 # biWidth
        height * 2,            # biHeight — doubled: XOR bitmap + AND mask
        1,                     # biPlanes
        32,                    # biBitCount
        0,                     # biCompression = BI_RGB
        len(xor) + len(mask),  # biSizeImage
        0,                     # biXPelsPerMeter
        0,                     # biYPelsPerMeter
        0,                     # biClrUsed — 0 means "no palette", right for 32bpp
        0,                     # biClrImportant
    )
    return header + xor + mask


def _png_frame(image: Image.Image) -> bytes:
    """The 256x256 frame, stored as a PNG file verbatim inside the container."""
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def write_ico(path: str, frames: Sequence[Image.Image]) -> None:
    """Write `frames` to `path` as a multi-resolution .ico.

    Each frame must already be square and at its final size; nothing is
    resampled here, so the caller keeps control of how the small sizes are
    downscaled. Frames at PNG_SIZE are stored as PNG, everything else as
    BMP/DIB.
    """
    payloads = []
    for frame in frames:
        image = frame.convert("RGBA")
        width, height = image.size
        if width != height:
            raise ValueError(f"icon frames must be square, got {width}x{height}")
        if width > PNG_SIZE:
            raise ValueError(f"{width}px exceeds the {PNG_SIZE}px the format allows")
        payloads.append(
            _png_frame(image) if width == PNG_SIZE else _bmp_frame(image)
        )

    # ICONDIR, then the whole table of ICONDIRENTRY, then the payloads. Offsets
    # are absolute from the start of the file, so the table has to be sized
    # before the first one can be worked out.
    offset = 6 + 16 * len(payloads)
    directory = struct.pack("<HHH", 0, 1, len(payloads))

    entries = []
    for frame, payload in zip(frames, payloads):
        side = frame.size[0]
        entries.append(
            struct.pack(
                "<BBBBHHII",
                # 256 does not fit in a byte and is written as 0. This is the
                # format's own convention, not a sentinel we invented.
                0 if side == PNG_SIZE else side,  # bWidth
                0 if side == PNG_SIZE else side,  # bHeight
                0,                                # bColorCount — 0 above 8bpp
                0,                                # bReserved
                1,                                # wPlanes
                32,                               # wBitCount
                len(payload),                     # dwBytesInRes
                offset,                           # dwImageOffset
            )
        )
        offset += len(payload)

    with open(path, "wb") as handle:
        handle.write(directory)
        handle.write(b"".join(entries))
        handle.write(b"".join(payloads))
