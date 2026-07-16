#!/usr/bin/env python3
"""Regenerate the DEV-variant PWA icon set.

Same brand mark as the production icons (generate_icons.py), but composited on a
distinct violet dev field with a "DEV" tag, so an installed dev PWA is
unmistakable next to production on the home screen. These are served ONLY when
the deployment sets LTP_APP_VARIANT=dev (see backend/main.py); production is
never affected.

Run: python assets/icons/generate_dev_icons.py
Outputs under assets/icons/dev/ (mirrors the prod filenames) + dev/favicon.ico.
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", "logos", "primary.png")
OUT = os.path.join(HERE, "dev")
FONT_PATH = os.path.join(HERE, "..", "fonts", "Roboto-Bold.ttf")

# Distinct dev field — a strong violet, clearly not the slate (#131C21) prod
# field. The whole square is filled so the difference reads even under a
# circular/squircle platform mask.
DEV_FIELD = (91, 33, 182, 255)   # #5B21B6
TAG_INK = (255, 255, 255, 255)

# Mask mark occupies the top band of primary.png (see generate_icons.py).
MASK_TOP, MASK_BOTTOM = 615, 1846


def load_mask():
    im = Image.open(SOURCE).convert("RGBA")
    band = im.crop((0, MASK_TOP, im.width, MASK_BOTTOM))
    return band.crop(band.getchannel("A").getbbox())


def _draw_tag(canvas, size):
    """Bold 'DEV' near the bottom, within the maskable safe zone."""
    d = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype(FONT_PATH, int(size * 0.19))
    except Exception:
        font = ImageFont.load_default()
    text = "DEV"
    bbox = d.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    x = (size - tw) // 2 - bbox[0]
    y = int(size * 0.70) - bbox[1]
    d.text((x, y), text, font=font, fill=TAG_INK)


def compose(mask, size, inset, tag=True):
    canvas = Image.new("RGBA", (size, size), DEV_FIELD)
    target = int(size * inset)
    w, h = mask.size
    scale = target / max(w, h)
    art = mask.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    # Nudge the mark up so the DEV tag has room below it.
    oy = int(size * -0.07) if tag else 0
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2 + oy))
    if tag:
        _draw_tag(canvas, size)
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)
    mask = load_mask()
    # Mirror the prod filenames so the backend can swap by basename.
    compose(mask, 192, 0.56).save(os.path.join(OUT, "icon-192.png"))
    compose(mask, 512, 0.56).save(os.path.join(OUT, "icon-512.png"))
    compose(mask, 192, 0.48).save(os.path.join(OUT, "icon-192-maskable.png"))
    compose(mask, 512, 0.48).save(os.path.join(OUT, "icon-512-maskable.png"))
    compose(mask, 180, 0.52).save(os.path.join(OUT, "apple-touch-icon.png"))
    # Favicon: too small for the tag — just the dev field + mark distinguishes the tab.
    fav = compose(mask, 48, 0.66, tag=False)
    fav.save(os.path.join(OUT, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    print("Dev icons written to assets/icons/dev/")


if __name__ == "__main__":
    main()
