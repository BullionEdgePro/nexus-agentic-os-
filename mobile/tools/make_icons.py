"""Draw the Nexus app icons (dev-only; run once, commit the PNGs).

The mark is the landing page's BrandMark (apps/web/app/landing.tsx): an outer
hexagon, an inner hexagon and a centre dot, drawn in white on the console's
button gradient (--btn-grad in apps/web/app/deck/deck.css). Rendered at 4x and
downsampled so the strokes are smooth.

Usage: python mobile/tools/make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[2] / "apps" / "web" / "public" / "icons"
TOP, MID, BOTTOM = (0x14, 0x86, 0xE0), (0x08, 0x73, 0xC9), (0x06, 0x5F, 0xA8)

OUTER = [(16, 2), (3, 9), (3, 23), (16, 30), (29, 23), (29, 9)]
INNER = [(16, 9), (9, 12.5), (9, 19.5), (16, 23), (23, 19.5), (23, 12.5)]


def gradient(size: int) -> Image.Image:
    """135-degree three-stop gradient, matching --btn-grad."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            a, b, u = (TOP, MID, t / 0.55) if t <= 0.55 else (MID, BOTTOM, (t - 0.55) / 0.45)
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * u) for i in range(3))
    return img


def icon(size: int, mark_fraction: float, rounded: bool) -> Image.Image:
    s = size * 4
    img = gradient(s).convert("RGBA")
    if rounded:
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=255)
        img.putalpha(mask)
    draw = ImageDraw.Draw(img)
    box = s * mark_fraction
    off = (s - box) / 2
    scale = box / 32

    def pt(p):
        return (off + p[0] * scale, off + p[1] * scale)

    white = (255, 255, 255, 255)
    # Closed polygons, not polylines: a polyline leaves a notch where it closes.
    draw.polygon([pt(p) for p in OUTER], outline=white, width=max(2, int(1.6 * scale)))
    draw.polygon([pt(p) for p in INNER], outline=white, width=max(2, int(1.4 * scale)))
    r = 2.2 * scale
    cx, cy = pt((16, 16))
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=white)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192, 0.62, rounded=False).save(OUT / "icon-192.png")
    icon(512, 0.62, rounded=False).save(OUT / "icon-512.png")
    # Maskable: the launcher crops to its own shape, so the mark stays well
    # inside the 80% safe zone and the gradient fills edge to edge.
    icon(512, 0.46, rounded=False).save(OUT / "icon-maskable-512.png")
    # iOS rounds the corners itself and ignores transparency, so a full square.
    icon(180, 0.62, rounded=False).convert("RGB").save(OUT / "apple-touch-icon.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
