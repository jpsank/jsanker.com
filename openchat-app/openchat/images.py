"""Upload sanitiser: size cap -> decode with Pillow -> pixel caps (before loading) -> re-encode.

Re-encoding discards every byte of the original file (EXIF, trailing payloads, polyglots). Only JPEG, PNG, GIF
(first frame) and WebP are accepted, and only JPEG or PNG is ever written. Mirrors the PHP OpenChat uploader.
"""
from __future__ import annotations

import io
import secrets
import shutil
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 5 * 1024 * 1024
MAX_SIDE = 8000
MAX_PIXELS = 16_000_000
OUT_SIDE = 1000
MIN_FREE_BYTES = 200 * 1024 * 1024
ACCEPTED = {"JPEG": "jpg", "PNG": "png", "GIF": "png", "WEBP": "png"}
OUTPUTS = {"jpg": "image/jpeg", "png": "image/png"}

Image.MAX_IMAGE_PIXELS = MAX_PIXELS  # Pillow also refuses (DecompressionBombError) above 2x this


class ImageRejected(ValueError):
    """Message is safe to show to the user."""


def sanitize(raw: bytes) -> tuple[bytes, str]:
    if not raw:
        raise ImageRejected("That image is empty.")
    if len(raw) > MAX_BYTES:
        raise ImageRejected("That image is too large (5 MB max).")
    try:
        img = Image.open(io.BytesIO(raw))
        fmt = img.format
        if fmt not in ACCEPTED:
            raise ImageRejected("Only JPEG, PNG, GIF and WebP images are allowed.")
        w, h = img.size
        if w < 1 or h < 1 or w > MAX_SIDE or h > MAX_SIDE or w * h > MAX_PIXELS:
            raise ImageRejected("That image has too many pixels (8000 px per side, 16 megapixels max).")
        img.seek(0)
        img.load()
        img = ImageOps.exif_transpose(img) if fmt == "JPEG" else img
        ext = ACCEPTED[fmt]
        img.thumbnail((OUT_SIDE, OUT_SIDE))
        if ext == "jpg":
            img = img.convert("RGB")
        else:
            img = img.convert("RGBA")
        out = io.BytesIO()
        if ext == "jpg":
            img.save(out, "JPEG", quality=85, optimize=True)
        else:
            img.save(out, "PNG", optimize=True)
        return out.getvalue(), ext
    except ImageRejected:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError, EOFError):
        raise ImageRejected("That image could not be read.") from None
    except MemoryError:
        raise ImageRejected("That image is too large to process.") from None


def save(raw: bytes, directory: Path) -> str:
    """Sanitise and store; returns the stored file name (random, extension jpg|png)."""
    if shutil.disk_usage(directory).free < MIN_FREE_BYTES:
        raise ImageRejected("The server is low on disk space; uploads are paused.")
    data, ext = sanitize(raw)
    name = f"{secrets.token_hex(16)}.{ext}"
    tmp = directory / f".{name}.tmp"
    tmp.write_bytes(data)
    tmp.replace(directory / name)
    return name
