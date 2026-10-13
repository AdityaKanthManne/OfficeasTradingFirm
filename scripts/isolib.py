"""isolib.py — tiny isometric drawing kit used by build-scranton-iso.py.

World: u runs west→east (screen up-right), v runs north→south (screen down-right),
h is height. One tile = 2 ft. Everything is drawn at SS× and downsampled, so the
outlines come out smooth like the original Claude Office art.
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SPR = ROOT / "public" / "sprites"

TW, TH, VZ = 48, 24, 29.0       # tile width/height on screen, px per tile of height
SS = 2                          # supersampling
LW = 3                          # outline width at SS
OUT = (46, 42, 54, 255)         # outline colour (dark plum-grey, like the original sprites)

# Set by configure()
OX, OY = 0.0, 0.0


def configure(ox, oy):
    global OX, OY
    OX, OY = ox, oy


def P(u, v, h=0.0):
    """world → base-resolution screen px"""
    return (OX + (u + v) * TW / 2, OY + (v - u) * TH / 2 - h * VZ)


def mul(c, k):
    a = c[3] if len(c) > 3 else 255
    return (max(0, min(255, int(c[0] * k))), max(0, min(255, int(c[1] * k))), max(0, min(255, int(c[2] * k))), a)


def mix(c1, c2, t):
    return tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3)) + (255,)


def rgba(c, a=255):
    return (c[0], c[1], c[2], a)


_sprite_cache = {}


def sprite(name):
    if name not in _sprite_cache:
        p = Path(name)
        if not p.is_absolute():
            p = SPR / name
        im = Image.open(p).convert("RGBA")
        bb = im.getbbox()
        _sprite_cache[name] = im.crop(bb) if bb else im
    return _sprite_cache[name]


_fonts = {}


def font(size, bold=True):
    key = (size, bold)
    if key not in _fonts:
        f = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
        _fonts[key] = ImageFont.truetype(f, size)
    return _fonts[key]


def composite(dst, src, x, y):
    """alpha-composite src onto dst at (x,y), clipping to dst bounds"""
    x, y = int(round(x)), int(round(y))
    sx0, sy0 = max(0, -x), max(0, -y)
    dx0, dy0 = max(0, x), max(0, y)
    w = min(src.width - sx0, dst.width - dx0)
    h = min(src.height - sy0, dst.height - dy0)
    if w <= 0 or h <= 0:
        return
    part = src.crop((sx0, sy0, sx0 + w, sy0 + h))
    dst.alpha_composite(part, (dx0, dy0))


class Painter:
    """Draws world-space primitives onto an SS-scaled canvas whose top-left is (ox, oy) in base px."""

    def __init__(self, img, ox=0.0, oy=0.0):
        self.img = img
        self.d = ImageDraw.Draw(img, "RGBA")
        self.ox, self.oy = ox, oy

    def p(self, u, v, h=0.0):
        x, y = P(u, v, h)
        return ((x - self.ox) * SS, (y - self.oy) * SS)

    # ---- primitives -------------------------------------------------------
    def poly(self, pts, fill, outline=OUT, lw=LW):
        q = [self.p(*t) for t in pts]
        if fill is not None:
            self.d.polygon(q, fill=fill)
        if outline:
            self.d.line(q + [q[0]], fill=outline, width=lw, joint="curve")

    def line(self, pts, fill=OUT, lw=LW):
        q = [self.p(*t) for t in pts]
        self.d.line(q, fill=fill, width=lw, joint="curve")

    def box(self, u0, v0, u1, v1, h0, h1, col, top=None, outline=OUT, lw=LW, faces="wst", south=None, west=None):
        """Axis-aligned box: draws the faces the camera can see (west, south, top)."""
        col = rgba(col) if len(col) == 3 else col
        if "w" in faces:
            self.poly([(u0, v0, h0), (u0, v1, h0), (u0, v1, h1), (u0, v0, h1)], west or mul(col, 0.74), outline, lw)
        if "s" in faces:
            self.poly([(u0, v1, h0), (u1, v1, h0), (u1, v1, h1), (u0, v1, h1)], south or mul(col, 0.87), outline, lw)
        if "t" in faces:
            self.poly([(u0, v0, h1), (u1, v0, h1), (u1, v1, h1), (u0, v1, h1)], top or col, outline, lw)

    def ellipse_pts(self, uc, vc, r, h, n=40, rv=None):
        rv = r if rv is None else rv
        return [(uc + r * math.cos(t), vc + rv * math.sin(t), h) for t in (2 * math.pi * i / n for i in range(n))]

    def cyl(self, uc, vc, r, h0, h1, col, top=None, outline=OUT, rv=None):
        col = rgba(col) if len(col) == 3 else col
        bot = [self.p(*q) for q in self.ellipse_pts(uc, vc, r, h0, rv=rv)]
        tp = [self.p(*q) for q in self.ellipse_pts(uc, vc, r, h1, rv=rv)]
        # side silhouette: leftmost..rightmost along the front (lower) half
        il = min(range(len(bot)), key=lambda i: bot[i][0])
        ir = max(range(len(bot)), key=lambda i: bot[i][0])
        n = len(bot)
        # walk from ir to il through the lower half (larger y)
        def arc(a, b, pts):
            out, i = [], a
            while True:
                out.append(pts[i])
                if i == b:
                    break
                i = (i + 1) % n
            return out
        a1, a2 = arc(ir, il, bot), arc(il, ir, bot)
        lower = a1 if sum(p[1] for p in a1) / len(a1) > sum(p[1] for p in a2) / len(a2) else a2
        lower_top = [tp[bot.index(p)] for p in lower]
        side = lower + lower_top[::-1]
        self.d.polygon(side, fill=mul(col, 0.82))
        if outline:
            self.d.line(lower, fill=outline, width=LW, joint="curve")
            self.d.line([lower[0], lower_top[0]], fill=outline, width=LW)
            self.d.line([lower[-1], lower_top[-1]], fill=outline, width=LW)
        self.d.polygon(tp, fill=top or col)
        if outline:
            self.d.line(tp + [tp[0]], fill=outline, width=LW, joint="curve")

    def disc(self, uc, vc, r, h, fill, outline=None, rv=None):
        q = [self.p(*t) for t in self.ellipse_pts(uc, vc, r, h, rv=rv)]
        self.d.polygon(q, fill=fill)
        if outline:
            self.d.line(q + [q[0]], fill=outline, width=LW, joint="curve")

    # ---- images -----------------------------------------------------------
    def sprite(self, name, u, v, width_px, h=0.0, dy=0.0, flip=False, img=None):
        """Paste a pre-drawn iso sprite with its bottom-centre at world (u, v, h)."""
        im = img if img is not None else sprite(name)
        if flip:
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        w = max(1, int(round(width_px * SS)))
        hh = max(1, int(round(im.height * w / im.width)))
        im = im.resize((w, hh), Image.LANCZOS)
        x, y = self.p(u, v, h)
        composite(self.img, im, x - w / 2, y - hh + dy * SS)

    def on_face(self, src, TL, TR, BL):
        """Affine-map src onto the parallelogram TL,TR,BL (world points)."""
        TL, TR, BL = self.p(*TL), self.p(*TR), self.p(*BL)
        tw = math.hypot(TR[0] - TL[0], TR[1] - TL[1])
        th = math.hypot(BL[0] - TL[0], BL[1] - TL[1])
        if src.width > tw * 1.5:
            src = src.resize((max(1, int(tw)), max(1, int(th))), Image.LANCZOS)
        W, H = src.size
        ax, ay = (TR[0] - TL[0]) / W, (TR[1] - TL[1]) / W
        bx, by = (BL[0] - TL[0]) / H, (BL[1] - TL[1]) / H
        det = ax * by - bx * ay
        BR = (TR[0] + BL[0] - TL[0], TR[1] + BL[1] - TL[1])
        xs = [TL[0], TR[0], BL[0], BR[0]]
        ys = [TL[1], TR[1], BL[1], BR[1]]
        x0, y0 = math.floor(min(xs)), math.floor(min(ys))
        x1, y1 = math.ceil(max(xs)), math.ceil(max(ys))
        dx, dy = x0 - TL[0], y0 - TL[1]
        a, b = by / det, -bx / det
        c = (by * dx - bx * dy) / det
        d, e = -ay / det, ax / det
        f = (-ay * dx + ax * dy) / det
        out = src.transform((x1 - x0, y1 - y0), Image.AFFINE, (a, b, c, d, e, f), resample=Image.BICUBIC)
        composite(self.img, out, x0, y0)

    def face_n(self, src, u0, u1, h0, h1, v=0.0):
        """image on a wall facing south (plane v = const)"""
        self.on_face(src, (u0, v, h1), (u1, v, h1), (u0, v, h0))

    def face_w(self, src, v0, v1, h0, h1, u=0.0):
        """image on a wall facing west (plane u = const)"""
        self.on_face(src, (u, v0, h1), (u, v1, h1), (u, v0, h0))

    def text_img(self, text, size, fill, bg=None, pad=6, bold=True):
        f = font(size * SS, bold)
        bb = f.getbbox(text)
        w, h = bb[2] - bb[0] + pad * 2 * SS, bb[3] - bb[1] + pad * 2 * SS
        im = Image.new("RGBA", (w, h), bg or (0, 0, 0, 0))
        ImageDraw.Draw(im).text((pad * SS - bb[0], pad * SS - bb[1]), text, font=f, fill=fill)
        return im
