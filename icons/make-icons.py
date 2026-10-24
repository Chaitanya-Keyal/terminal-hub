#!/usr/bin/env python3
"""Draw terminal-hub's app icon (needs Pillow): a green terminal window with a session list,
first row picked. Usage: make-icons.py [OUTDIR]   (default: this script's directory; writes
app-512.png, app-192.png, app-32.png)"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw


def draw(d: ImageDraw.ImageDraw, s: int) -> None:
    green, dim = (126, 231, 135), (58, 108, 64)
    # window, kept inside the maskable safe zone (the central ~80% circle)
    d.rounded_rectangle([s * .21, s * .25, s * .79, s * .75], radius=s * .05, outline=green, width=s // 28)
    lw = s // 30
    # the picked row: > and a bright bar; two dim rows under it
    d.line([(s * .30, s * .36), (s * .36, s * .41), (s * .30, s * .46)], fill=green, width=lw, joint="curve")
    d.line([(s * .42, s * .41), (s * .69, s * .41)], fill=green, width=lw)
    d.line([(s * .42, s * .53), (s * .63, s * .53)], fill=dim, width=lw)
    d.line([(s * .42, s * .64), (s * .67, s * .64)], fill=dim, width=lw)


def render(size: int) -> Image.Image:
    big = 1024
    img = Image.new("RGB", (big, big), (11, 13, 16))
    draw(ImageDraw.Draw(img), big)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
    out.mkdir(parents=True, exist_ok=True)
    for size in (512, 192, 32):
        render(size).save(out / f"app-{size}.png", optimize=True)
    print(f"wrote icons to {out}")
