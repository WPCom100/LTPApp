#!/usr/bin/env python3
"""Regenerate the PWA / home-screen icon set from the brand logo.

Source art: ../logos/primary.png — the full Luminary lockup (mask + wordmark).
We isolate just the superhero-mask mark (the top band of the lockup) and
composite it, centred, on the app's slate field (#131C21) to produce every
icon iOS / Android / the web manifest need.

To swap the brand mark later: replace SOURCE below (or the mask crop band) and
re-run `python assets/icons/generate_icons.py`. Requires only Pillow, which is
already a project dependency (see requirements.txt). Nothing here runs at
request time — icons are static files committed to the repo.

Outputs (all under assets/icons/ unless noted):
  icon-192.png, icon-512.png            — manifest "any" icons (art inset)
  icon-192-maskable.png, icon-512-maskable.png
                                        — manifest "maskable" (art in the 80% safe zone)
  apple-touch-icon.png (180x180)        — iOS home screen (opaque, iOS rounds corners)
  ../../favicon.ico (16/32/48)          — browser tab (root; already on the serve allowlist)
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", "logos", "primary.png")
SLATE = (19, 28, 33, 255)   # #131C21 — LTP_THEME.bg / body field

# The mask mark occupies the top band of primary.png; the wordmark + subtitle
# sit below it. These y bounds were measured from the alpha profile of the
# current art; adjust if the source lockup changes.
MASK_TOP, MASK_BOTTOM = 615, 1846


def load_mask():
    """Return the mask mark cropped tight to its own ink, as RGBA."""
    im = Image.open(SOURCE).convert("RGBA")
    band = im.crop((0, MASK_TOP, im.width, MASK_BOTTOM))
    bbox = band.getchannel("A").getbbox()  # trim transparent margins
    return band.crop(bbox)


def compose(mask, size, inset, opaque=True, bg=SLATE):
    """Slate square `size`x`size` with `mask` centred, scaled so its longest
    side is `inset` * size. `opaque` keeps the slate field (iOS/maskable);
    otherwise the field stays transparent (unused today, kept for flexibility)."""
    canvas = Image.new("RGBA", (size, size), bg if opaque else (0, 0, 0, 0))
    target = int(size * inset)
    w, h = mask.size
    scale = target / max(w, h)
    art = mask.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return canvas


def main():
    mask = load_mask()

    # Manifest "any" icons — generous inset, slate field.
    compose(mask, 192, 0.74).save(os.path.join(HERE, "icon-192.png"))
    compose(mask, 512, 0.74).save(os.path.join(HERE, "icon-512.png"))

    # Maskable — art kept within the ~80% safe zone so platform masks
    # (circle/squircle/rounded-rect) never clip the mark.
    compose(mask, 192, 0.60).save(os.path.join(HERE, "icon-192-maskable.png"))
    compose(mask, 512, 0.60).save(os.path.join(HERE, "icon-512-maskable.png"))

    # Apple touch icon — opaque (iOS shows black behind transparency) and iOS
    # applies its own rounded-rect mask, so keep the art comfortably inset.
    compose(mask, 180, 0.70).save(os.path.join(HERE, "apple-touch-icon.png"))

    # Favicon at the repo root (already permitted by the static serve allowlist).
    favicon = compose(mask, 48, 0.82)
    favicon.save(os.path.join(HERE, "..", "..", "favicon.ico"),
                 sizes=[(16, 16), (32, 32), (48, 48)])

    print("Icons written to assets/icons/ and favicon.ico at repo root.")


if __name__ == "__main__":
    main()
