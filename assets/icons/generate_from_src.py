#!/usr/bin/env python3
"""Regenerate the prod + dev PWA icon sets from the provided source art.

Source-of-truth art lives in assets/icons/src/:
  app-icon-prod.png  → the production icon set (assets/icons/ + /favicon.ico)
  app-icon-dev.png   → the dev variant set    (assets/icons/dev/)

Each source is a finished, square icon (the LTP mask lockup; the dev one adds a
"DEV" tag). From each we emit every size the manifest / iOS / the browser need:
the full-bleed "any" icons, padded "maskable" variants (art kept in the ~80%
safe zone so platform circle/squircle masks never clip it), the apple-touch
icon, and a favicon. The dev set is served only when LTP_APP_VARIANT=dev
(see backend/main.py).

To update the art: replace the PNG(s) in assets/icons/src/ with new square
masters (ideally 512x512+ for crisp large icons) and re-run:

    python assets/icons/generate_from_src.py

Requires only Pillow (already a project dependency).
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.realpath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(HERE, "src")


def _bg(im):
    """Field color, taken as the most common of the four corner pixels."""
    w, h = im.size
    pts = [im.getpixel((1, 1)), im.getpixel((w - 2, 1)),
           im.getpixel((1, h - 2)), im.getpixel((w - 2, h - 2))]
    return max(set(pts), key=pts.count)


def generate(src_path, out_dir, favicon_path):
    os.makedirs(out_dir, exist_ok=True)
    src = Image.open(src_path).convert("RGB")
    bg = _bg(src)

    def full(size):
        """Full-bleed 'any' / apple-touch — the art as designed, edge to edge."""
        return src.resize((size, size), Image.LANCZOS)

    def maskable(size, safe=0.80):
        """Art scaled into the central safe zone on the field, so a platform
        mask (circle/squircle/rounded-rect) can't clip the mark or the tag."""
        canvas = Image.new("RGB", (size, size), bg)
        inner = int(round(size * safe))
        art = src.resize((inner, inner), Image.LANCZOS)
        off = (size - inner) // 2
        canvas.paste(art, (off, off))
        return canvas

    full(192).save(os.path.join(out_dir, "icon-192.png"))
    full(512).save(os.path.join(out_dir, "icon-512.png"))
    maskable(192).save(os.path.join(out_dir, "icon-192-maskable.png"))
    maskable(512).save(os.path.join(out_dir, "icon-512-maskable.png"))
    full(180).save(os.path.join(out_dir, "apple-touch-icon.png"))
    full(180).save(favicon_path, sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"  {os.path.relpath(out_dir, ROOT)}: field={bg} — 6 icons + favicon "
          f"({os.path.relpath(favicon_path, ROOT)})")


def main():
    print("Production:")
    generate(os.path.join(SRC, "app-icon-prod.png"),
             os.path.join(ROOT, "assets", "icons"),
             os.path.join(ROOT, "favicon.ico"))
    print("Dev:")
    generate(os.path.join(SRC, "app-icon-dev.png"),
             os.path.join(ROOT, "assets", "icons", "dev"),
             os.path.join(ROOT, "assets", "icons", "dev", "favicon.ico"))
    print("Done.")


if __name__ == "__main__":
    main()
