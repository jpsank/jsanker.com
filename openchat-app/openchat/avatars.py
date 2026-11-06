"""Deterministic identicon avatars, generated locally (replaces Gravatar, which leaked an email hash per user)."""
from __future__ import annotations

import colorsys
import hashlib


def identicon_svg(name: str) -> str:
    digest = hashlib.sha256(name.lower().encode("utf-8")).digest()
    hue = digest[0] / 255
    r, g, b = (round(c * 255) for c in colorsys.hls_to_rgb(hue, 0.5, 0.55))
    color = f"#{r:02x}{g:02x}{b:02x}"
    cells = []
    bit = 0
    for row in range(5):
        for col in range(3):  # left half + centre column; mirrored to the right
            on = (digest[1 + bit // 8] >> (bit % 8)) & 1
            bit += 1
            if on:
                for c in {col, 4 - col}:
                    cells.append(f'<rect x="{c + 1}" y="{row + 1}" width="1" height="1"/>')
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" shape-rendering="crispEdges">'
        '<rect width="7" height="7" fill="#f0f0f0"/>'
        f'<g fill="{color}">{"".join(cells)}</g></svg>'
    )
