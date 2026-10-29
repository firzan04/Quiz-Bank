"""Generate the launcher icons (legacy, round and adaptive foreground) with Pillow.

Run from the repository root:  python3 tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

RES = Path(__file__).resolve().parents[1] / "app" / "src" / "main" / "res"
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
BG = (11, 15, 25, 255)
BRAND_A = (224, 40, 38)
BRAND_B = (255, 87, 34)
SS = 4  # supersampling factor


def gradient(size: int) -> Image.Image:
    """Diagonal brand gradient (red -> orange)."""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(int(a + (b - a) * t) for a, b in zip(BRAND_A, BRAND_B)) + (255,)
    return img


def font(px: int) -> ImageFont.FreeTypeFont:
    for name in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        if Path(name).exists():
            return ImageFont.truetype(name, px)
    return ImageFont.load_default()


def mark(size: int, scale: float) -> Image.Image:
    """The emblem: a gradient diamond with a white 'Q' and a check tick.

    Args:
        size: Canvas size in pixels.
        scale: Diamond half-diagonal as a fraction of the canvas.
    """
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    c = size / 2
    r = size * scale
    diamond = Image.new("L", (size, size), 0)
    ImageDraw.Draw(diamond).polygon([(c, c - r), (c + r, c), (c, c + r), (c - r, c)], fill=255)
    diamond = diamond.filter(ImageFilter.GaussianBlur(size * 0.004))
    # soft glow
    glow = diamond.filter(ImageFilter.GaussianBlur(size * 0.05))
    glow_layer = Image.new("RGBA", (size, size), BRAND_A + (0,))
    glow_layer.putalpha(glow.point(lambda v: int(v * 0.55)))
    canvas.alpha_composite(glow_layer)
    grad = gradient(size)
    grad.putalpha(diamond)
    canvas.alpha_composite(grad)
    draw = ImageDraw.Draw(canvas)
    f = font(int(r * 0.95))
    text = "Q"
    box = draw.textbbox((0, 0), text, font=f)
    tw, th = box[2] - box[0], box[3] - box[1]
    draw.text((c - tw / 2 - box[0], c - th / 2 - box[1] - r * 0.04), text, font=f, fill=(255, 255, 255, 255))
    return canvas


def legacy(px: int, round_icon: bool) -> Image.Image:
    big = px * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    shape = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(shape)
    inset = int(big * 0.04)
    if round_icon:
        d.ellipse([inset, inset, big - inset, big - inset], fill=255)
    else:
        d.rounded_rectangle([inset, inset, big - inset, big - inset], radius=int(big * 0.22), fill=255)
    bg = Image.new("RGBA", (big, big), BG)
    bg.putalpha(shape)
    img.alpha_composite(bg)
    img.alpha_composite(mark(big, 0.34))
    return img.resize((px, px), Image.LANCZOS)


def foreground(px: int) -> Image.Image:
    big = px * SS
    # 108dp canvas; keep the emblem inside the 66dp safe zone.
    return mark(big, 0.25).resize((px, px), Image.LANCZOS)


def main() -> None:
    for density, factor in DENSITIES.items():
        folder = RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        legacy(int(48 * factor), False).save(folder / "ic_launcher.png", optimize=True)
        legacy(int(48 * factor), True).save(folder / "ic_launcher_round.png", optimize=True)
        foreground(int(108 * factor)).save(folder / "ic_launcher_foreground.png", optimize=True)
    preview = legacy(512, False)
    preview.save(Path(__file__).resolve().parent / "icon_preview.png")
    print("icons written")


if __name__ == "__main__":
    main()
