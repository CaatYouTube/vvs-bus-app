#!/usr/bin/env python3
"""Erzeugt die App-Icons (benötigt Pillow): python3 scripts/make_icons.py"""
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "web", "icons")
GREEN = (11, 107, 58, 255)
WHITE = (255, 255, 255, 255)


def bus(size, scale, rounded):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=GREEN)
    else:
        d.rectangle([0, 0, size, size], fill=GREEN)
    u = size * scale / 100.0
    ox = oy = (size - size * scale) / 2.0

    def box(x0, y0, x1, y1):
        return [ox + x0 * u, oy + y0 * u, ox + x1 * u, oy + y1 * u]

    d.rounded_rectangle(box(12, 14, 88, 78), radius=int(10 * u), fill=WHITE)  # Karosserie
    for x in (18, 40, 62):  # Fenster
        d.rounded_rectangle(box(x, 22, x + 20, 44), radius=int(3 * u), fill=GREEN)
    d.rectangle(box(12, 52, 88, 56), fill=GREEN)  # Zierstreifen
    d.ellipse(box(20, 62, 30, 72), fill=GREEN)  # Scheinwerfer
    d.ellipse(box(70, 62, 80, 72), fill=GREEN)
    for cx in (28, 72):  # Räder
        d.ellipse(box(cx - 9, 72, cx + 9, 90), fill=WHITE, outline=GREEN, width=max(2, int(2 * u)))
        d.ellipse(box(cx - 3, 78, cx + 3, 84), fill=GREEN)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    big = bus(1024, 0.86, True).resize((512, 512), Image.LANCZOS)
    big.save(os.path.join(OUT, "icon-512.png"))
    big.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"))
    bus(1024, 0.62, False).resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-maskable-512.png"))
    with open(os.path.join(OUT, "icon.svg"), "w", encoding="utf-8") as f:
        f.write(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            '<rect width="100" height="100" rx="22" fill="#0b6b3a"/>'
            '<rect x="14" y="16" width="72" height="58" rx="9" fill="#fff"/>'
            '<g fill="#0b6b3a"><rect x="20" y="24" width="17" height="19" rx="3"/>'
            '<rect x="41" y="24" width="17" height="19" rx="3"/><rect x="62" y="24" width="17" height="19" rx="3"/>'
            '<rect x="14" y="50" width="72" height="4"/><circle cx="25" cy="64" r="4.5"/><circle cx="75" cy="64" r="4.5"/></g>'
            '<g fill="#fff" stroke="#0b6b3a" stroke-width="2"><circle cx="30" cy="80" r="8"/><circle cx="70" cy="80" r="8"/></g>'
            '</svg>\n'
        )
    print("Icons geschrieben nach", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
