"""Every raster icon of the app, drawn from the logo's vector (LOGO_PATH in
src/components/ui/Spinner.tsx) at 8x and scaled down, so none is blurry or
blocky: the web app's icons, the Android app's, the Windows .ico and the
1024 px one the Mac build makes its .icns from.

    python scripts/make-icons.py
"""

import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SS = 8  # drawn this many times bigger, then scaled down
BG = (15, 18, 24, 255)  # #0f1218
MARK = (242, 68, 44, 255)  # #f2442c
WHITE = (255, 255, 255, 255)


def logo_path() -> str:
    src = (ROOT / "src/components/ui/Spinner.tsx").read_text(encoding="utf-8")
    m = re.search(r'export const LOGO_PATH =\s*"([^"]+)"', src)
    if not m:
        raise SystemExit("LOGO_PATH not found in Spinner.tsx")
    return m.group(1)


def flatten(d: str, steps: int = 48) -> list[list[tuple[float, float]]]:
    """The path's outlines as points (M, L, H, V, C, S, Z, absolute and relative)."""
    tokens = re.findall(r"[MmLlHhVvCcSsZz]|-?(?:\d+\.\d*|\.\d+|\d+)(?:e-?\d+)?", d)
    shapes: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    x = y = sx = sy = 0.0
    last_c2: tuple[float, float] | None = None
    i, cmd = 0, ""

    def num() -> float:
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    def bez(p0, p1, p2, p3):
        for k in range(1, steps + 1):
            t = k / steps
            u = 1 - t
            cur.append((
                u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
            ))

    while i < len(tokens):
        if re.fullmatch(r"[A-Za-z]", tokens[i]):
            cmd = tokens[i]
            i += 1
        rel = cmd.islower()
        c = cmd.upper()
        if c == "Z":
            if cur:
                shapes.append(cur)
            cur = []
            x, y = sx, sy
            last_c2 = None
            continue
        if c == "M":
            nx, ny = num(), num()
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            if cur:
                shapes.append(cur)
            cur = [(x, y)]
            sx, sy = x, y
            cmd = "l" if rel else "L"
            last_c2 = None
        elif c == "L":
            nx, ny = num(), num()
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            cur.append((x, y))
            last_c2 = None
        elif c == "H":
            nx = num()
            x = x + nx if rel else nx
            cur.append((x, y))
            last_c2 = None
        elif c == "V":
            ny = num()
            y = y + ny if rel else ny
            cur.append((x, y))
            last_c2 = None
        elif c in ("C", "S"):
            if c == "C":
                a = (num(), num())
                p1 = (x + a[0], y + a[1]) if rel else a
            else:
                p1 = (2 * x - last_c2[0], 2 * y - last_c2[1]) if last_c2 else (x, y)
            b = (num(), num())
            e = (num(), num())
            p2 = (x + b[0], y + b[1]) if rel else b
            p3 = (x + e[0], y + e[1]) if rel else e
            bez((x, y), p1, p2, p3)
            last_c2 = p2
            x, y = p3
    if cur:
        shapes.append(cur)
    return shapes


SHAPES = flatten(logo_path())
XS = [p[0] for s in SHAPES for p in s]
YS = [p[1] for s in SHAPES for p in s]
LW, LH = max(XS) - min(XS), max(YS) - min(YS)


def icon(size: int, mark_w: float, color=MARK, bg=None, radius: float = 0.0) -> Image.Image:
    """size px; the mark mark_w of the width, centred; bg: a square (radius: of the size) or none."""
    big = size * SS
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    if bg:
        if radius:
            dr.rounded_rectangle([0, 0, big - 1, big - 1], radius=round(radius * big), fill=bg)
        else:
            dr.rectangle([0, 0, big, big], fill=bg)
    k = mark_w * big / LW
    ox = (big - LW * k) / 2 - min(XS) * k
    oy = (big - LH * k) / 2 - min(YS) * k
    for s in SHAPES:
        dr.polygon([(ox + px * k, oy + py * k) for px, py in s], fill=color)
    return im.resize((size, size), Image.LANCZOS)


def save(im: Image.Image, rel: str) -> None:
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, optimize=True)
    print(f"{rel} {im.size[0]}x{im.size[1]}")


ROUND = 0.22  # the app icon's corners, of its size
# The web app (manifest, browser tab, home screens, notifications).
save(icon(32, 0.94), "public/icons/favicon-32.png")
save(icon(180, 0.65, bg=BG), "public/icons/apple-touch-icon.png")
save(icon(192, 0.70, bg=BG, radius=ROUND), "public/icons/icon-192.png")
save(icon(512, 0.70, bg=BG, radius=ROUND), "public/icons/icon-512.png")
save(icon(1024, 0.70, bg=BG, radius=ROUND), "public/icons/icon-1024.png")
save(icon(512, 0.557, bg=BG), "public/icons/icon-maskable-512.png")
save(icon(96, 0.875, color=WHITE), "public/icons/badge-96.png")
# The Android app: the launcher art (inset by the adaptive icon), Ikli's picture.
save(icon(1024, 0.557, bg=BG), "android/app/src/main/res/drawable-nodpi/ic_launcher_art.png")
save(icon(512, 0.70, bg=BG, radius=ROUND), "android/app/src/main/res/drawable-nodpi/ikli.png")
save(icon(192, 0.70, bg=BG, radius=ROUND), "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png")
# Windows: every size Explorer and the taskbar ask for, each drawn on its own.
sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
ico = [icon(s, 0.70, bg=BG, radius=ROUND) for s in sizes]
ico[-1].save(ROOT / "desktop/iklipse.ico", sizes=[(s, s) for s in sizes], append_images=ico[:-1])
print("desktop/iklipse.ico " + ",".join(map(str, sizes)))
