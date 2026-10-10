#!/usr/bin/env python3
"""
generate-trading-props.py — draws the Dunder Mifflin Capital trading props.

Cartoon style to match the existing Office props: chunky dark outlines, flat
fills with a highlight, soft drop shadow, transparent background.
Everything is drawn at 4x and downsampled for clean anti-aliasing.

    python3 scripts/generate-trading-props.py            # writes public/sprites/office/props/*.png

Requires Pillow. Fonts: tries DejaVu / Liberation / Arial / Helvetica.
"""

import math
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "sprites", "office", "props")
S = 4  # supersample factor
INK = (38, 34, 40, 255)

FONT_CANDIDATES = {
    "bold": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
    "mono": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "C:/Windows/Fonts/consolab.ttf",
    ],
    "serif": [
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "C:/Windows/Fonts/georgiab.ttf",
    ],
}


def font(kind, size):
    for path in FONT_CANDIDATES[kind]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size * S)
    return ImageFont.load_default()


class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.img = Image.new("RGBA", (w * S, h * S), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    # coordinates are given in final-pixel units
    def p(self, pts):
        return [(x * S, y * S) for x, y in pts]

    def box(self, x0, y0, x1, y1):
        return [x0 * S, y0 * S, x1 * S, y1 * S]

    def rrect(self, x0, y0, x1, y1, r, fill, outline=INK, width=3):
        self.d.rounded_rectangle(self.box(x0, y0, x1, y1), radius=r * S, fill=fill, outline=outline, width=width * S if outline else 0)

    def rect(self, x0, y0, x1, y1, fill, outline=None, width=2):
        self.d.rectangle(self.box(x0, y0, x1, y1), fill=fill, outline=outline, width=width * S if outline else 0)

    def ellipse(self, x0, y0, x1, y1, fill, outline=INK, width=3):
        self.d.ellipse(self.box(x0, y0, x1, y1), fill=fill, outline=outline, width=width * S if outline else 0)

    def poly(self, pts, fill, outline=INK, width=3):
        self.d.polygon(self.p(pts), fill=fill)
        if outline:
            pp = self.p(pts)
            self.d.line(pp + [pp[0]], fill=outline, width=width * S, joint="curve")

    def line(self, pts, fill=INK, width=3):
        self.d.line(self.p(pts), fill=fill, width=width * S, joint="curve")

    def text(self, xy, s, f, fill=INK, anchor="mm"):
        self.d.text((xy[0] * S, xy[1] * S), s, font=f, fill=fill, anchor=anchor)

    def save(self, name, shadow=True):
        img = self.img
        if shadow:
            alpha = img.split()[3]
            sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
            sh.putalpha(alpha.point(lambda a: int(a * 0.35)))
            sh = sh.filter(ImageFilter.GaussianBlur(3 * S))
            base = Image.new("RGBA", img.size, (0, 0, 0, 0))
            base.alpha_composite(sh, (2 * S, 3 * S))
            base.alpha_composite(img)
            img = base
        img = img.resize((self.w, self.h), Image.LANCZOS)
        path = os.path.join(OUT, name)
        img.save(path)
        print("wrote", os.path.relpath(path, ROOT))


def candles(c, x0, y0, x1, y1, trend=1, n=7, seed=3):
    """Draw n candlesticks trending up (trend=1) or down (-1) inside a box."""
    import random
    rnd = random.Random(seed)
    w = (x1 - x0) / n
    # price level in [0,1], 1 = top of the box
    level = 0.12 if trend > 0 else 0.88

    def Y(v):
        v = min(max(v, 0.03), 0.97)
        return y1 - v * (y1 - y0)

    for i in range(n):
        step = 0.10 + rnd.random() * 0.06
        with_trend = rnd.random() > 0.2
        o = level
        cl = level + (trend * step if with_trend else -trend * step * 0.5)
        level = cl
        hi, lo = max(o, cl) + 0.05, min(o, cl) - 0.05
        cx = x0 + w * (i + 0.5)
        col = (46, 196, 102, 255) if cl >= o else (232, 72, 72, 255)
        c.line([(cx, Y(lo)), (cx, Y(hi))], fill=(220, 220, 220, 255), width=1)
        c.rect(cx - w * 0.28, Y(max(o, cl)), cx + w * 0.28, Y(min(o, cl)) + 1, fill=col)


# ---------------------------------------------------------------------------
# Props
# ---------------------------------------------------------------------------

def bear_market():
    c = Canvas(190, 160)
    # red down-trend arrow behind the bear
    c.line([(12, 30), (55, 62), (80, 48), (150, 120)], fill=(200, 40, 40, 255), width=9)
    c.poly([(132, 122), (166, 136), (160, 100)], fill=(200, 40, 40, 255), width=3)
    brown, dark, light = (128, 82, 50, 255), (92, 58, 36, 255), (205, 160, 112, 255)
    # ears
    c.ellipse(40, 28, 74, 62, brown); c.ellipse(48, 36, 66, 54, dark, outline=None)
    c.ellipse(112, 28, 146, 62, brown); c.ellipse(120, 36, 138, 54, dark, outline=None)
    # head
    c.ellipse(42, 40, 144, 140, brown)
    c.ellipse(60, 48, 100, 70, (150, 102, 66, 255), outline=None)  # highlight
    # muzzle
    c.ellipse(70, 92, 116, 132, light)
    c.ellipse(83, 96, 103, 110, INK, outline=None)  # nose
    c.line([(93, 110), (93, 118)], width=2)
    c.line([(84, 122), (93, 118), (102, 122)], width=2)
    # angry eyebrows + eyes (Dwight-level intensity)
    c.ellipse(70, 76, 80, 86, INK, outline=None); c.ellipse(106, 76, 116, 86, INK, outline=None)
    c.line([(64, 68), (84, 74)], width=4); c.line([(122, 68), (102, 74)], width=4)
    # tiny glasses — it's Dwight's bear
    c.line([(66, 81), (84, 81)], fill=(240, 240, 240, 140), width=1)
    c.save("bear-market.png")


def bull_market():
    c = Canvas(200, 160)
    # green up-trend arrow
    c.line([(10, 140), (60, 100), (90, 112), (165, 40)], fill=(30, 160, 80, 255), width=9)
    c.poly([(150, 34), (186, 22), (176, 58)], fill=(30, 160, 80, 255), width=3)
    tan, dark, horn = (150, 96, 58, 255), (110, 68, 40, 255), (245, 235, 210, 255)
    # horns
    c.poly([(58, 62), (30, 52), (22, 30), (40, 44), (66, 52)], fill=horn)
    c.poly([(132, 62), (160, 52), (168, 30), (150, 44), (124, 52)], fill=horn)
    # ears
    c.ellipse(42, 60, 70, 78, dark); c.ellipse(120, 60, 148, 78, dark)
    # head
    c.rrect(60, 46, 130, 128, 30, tan)
    c.ellipse(70, 52, 102, 72, (178, 120, 76, 255), outline=None)
    # snout + ring
    c.rrect(66, 104, 124, 140, 16, (225, 170, 140, 255))
    c.ellipse(78, 114, 88, 124, INK, outline=None); c.ellipse(102, 114, 112, 124, INK, outline=None)
    c.ellipse(86, 128, 104, 146, None, outline=(235, 190, 60, 255), width=3)
    # eyes
    c.ellipse(74, 82, 84, 92, INK, outline=None); c.ellipse(106, 82, 116, 92, INK, outline=None)
    c.save("bull-market.png")


def candlestick_chart():
    c = Canvas(210, 150)
    c.rrect(8, 8, 202, 142, 12, (30, 36, 48, 255), width=4)
    for i in range(1, 4):
        y = 8 + i * 134 / 4
        c.line([(20, y), (190, y)], fill=(70, 80, 100, 255), width=1)
    candles(c, 22, 22, 190, 128, trend=1, n=8, seed=7)
    c.text((60, 24), "DMC", font("bold", 13), fill=(240, 200, 80, 255))
    c.save("candlestick-chart.png")


def calculator_keleven():
    c = Canvas(140, 180)
    c.rrect(14, 8, 126, 172, 14, (120, 128, 140, 255), width=4)
    c.rrect(22, 16, 118, 164, 10, (150, 158, 170, 255), outline=None)
    c.rrect(26, 22, 114, 60, 6, (168, 196, 120, 255), width=3)
    c.text((106, 42), "11", font("mono", 26), fill=(40, 60, 30, 255), anchor="rm")
    c.text((34, 30), "KELEVEN", font("bold", 6), fill=(60, 80, 40, 255), anchor="lm")
    keys = [(34, 72), (62, 72), (90, 72)]
    for row in range(4):
        for col in range(3):
            x, y = 30 + col * 28, 70 + row * 24
            colr = (232, 120, 60, 255) if (row == 3 and col == 2) else (60, 64, 74, 255)
            c.rrect(x, y, x + 22, y + 18, 4, colr, width=2)
    # chili stain
    c.ellipse(86, 140, 112, 158, (150, 60, 30, 200), outline=None)
    c.ellipse(80, 150, 92, 160, (150, 60, 30, 200), outline=None)
    c.save("calculator-keleven.png")


def trade_ticket():
    c = Canvas(210, 130)
    pts = [(10, 14), (200, 14), (200, 116), (10, 116)]
    c.poly(pts, fill=(250, 246, 232, 255), width=3)
    for x in range(14, 200, 10):  # perforation
        c.ellipse(x, 10, x + 5, 15, (0, 0, 0, 0), outline=None)
    c.rect(10, 14, 200, 34, fill=(31, 78, 121, 255))
    c.text((105, 24), "DUNDER MIFFLIN CAPITAL · TRADE TICKET", font("bold", 8), fill=(255, 255, 255, 255))
    f = font("mono", 11)
    c.text((22, 50), "SIDE:  BUY", f, anchor="lm")
    c.text((22, 68), "QTY:   100", f, anchor="lm")
    c.text((22, 86), "TYPE:  LMT", f, anchor="lm")
    c.text((22, 104), "TRDR:  J.HALPERT", font("mono", 8), anchor="lm")
    # BUY stamp
    stamp = Image.new("RGBA", (80 * S, 44 * S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stamp)
    sd.rounded_rectangle([2 * S, 2 * S, 78 * S, 42 * S], radius=6 * S, outline=(30, 160, 80, 255), width=4 * S)
    sd.text((40 * S, 22 * S), "BUY", font=font("bold", 22), fill=(30, 160, 80, 255), anchor="mm")
    stamp = stamp.rotate(14, resample=Image.BICUBIC, expand=True)
    c.img.alpha_composite(stamp, (118 * S, 50 * S))
    c.save("trade-ticket.png")


def compliance_stamp():
    c = Canvas(180, 170)
    # ink impression
    imp = Image.new("RGBA", (150 * S, 56 * S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(imp)
    red = (200, 40, 50, 235)
    sd.rounded_rectangle([3 * S, 3 * S, 147 * S, 53 * S], radius=6 * S, outline=red, width=5 * S)
    sd.text((75 * S, 29 * S), "COMPLIANT", font=font("bold", 24), fill=red, anchor="mm")
    imp = imp.rotate(-10, resample=Image.BICUBIC, expand=True)
    c.img.alpha_composite(imp, (12 * S, 96 * S))
    # rubber stamp
    c.rrect(56, 66, 124, 92, 6, (160, 40, 45, 255))
    c.rrect(64, 54, 116, 70, 4, (110, 75, 45, 255))
    c.rrect(80, 26, 100, 58, 6, (140, 95, 55, 255))
    c.ellipse(70, 6, 110, 36, (160, 108, 62, 255))
    c.ellipse(78, 10, 94, 22, (190, 140, 90, 255), outline=None)
    c.save("compliance-stamp.png")


def wuphf_coin():
    c = Canvas(170, 170)
    gold, rim, shine = (240, 188, 50, 255), (196, 140, 24, 255), (255, 230, 140, 255)
    c.ellipse(10, 10, 160, 160, rim, width=4)
    c.ellipse(22, 22, 148, 148, gold, outline=(170, 118, 20, 255), width=3)
    c.ellipse(34, 30, 84, 66, shine, outline=None)
    c.text((85, 88), "W", font("bold", 58), fill=(150, 98, 10, 255))
    f = font("bold", 11)
    c.text((85, 38), "WUPHF", f, fill=(150, 98, 10, 255))
    c.text((85, 136), "TOKEN", f, fill=(150, 98, 10, 255))
    c.line([(132, 24), (140, 16)], fill=(255, 255, 255, 255), width=3)
    c.line([(140, 36), (152, 34)], fill=(255, 255, 255, 255), width=3)
    c.save("wuphf-coin.png")


def client_report():
    c = Canvas(180, 180)
    # back of folder
    c.poly([(16, 40), (70, 40), (80, 28), (164, 28), (164, 160), (16, 160)], fill=(40, 96, 160, 255))
    # paper
    c.rect(30, 18, 150, 150, fill=(252, 252, 248, 255), outline=INK, width=2)
    for y in (34, 44, 54):
        c.line([(42, y), (138, y)], fill=(160, 160, 170, 255), width=2)
    # pie chart on paper
    pie = [(0, 140, (46, 196, 102, 255)), (140, 230, (240, 188, 50, 255)), (230, 300, (232, 72, 72, 255)), (300, 360, (80, 140, 220, 255))]
    for a0, a1, col in pie:
        c.d.pieslice(c.box(48, 62, 100, 114), a0, a1, fill=col, outline=INK, width=2 * S)
    for i, h in enumerate((22, 34, 44)):
        c.rect(110 + i * 12, 112 - h, 118 + i * 12, 112, fill=(31, 78, 121, 255))
    # folder front
    c.poly([(10, 96), (170, 96), (164, 166), (16, 166)], fill=(52, 120, 196, 255))
    c.text((90, 128), "CLIENT REPORT", font("bold", 13), fill=(255, 255, 255, 255))
    c.text((90, 146), "by Pam B.", font("bold", 8), fill=(220, 235, 255, 255))
    c.save("client-report.png")


def ticker_terminal():
    c = Canvas(210, 170)
    c.poly([(90, 136), (120, 136), (130, 158), (80, 158)], fill=(70, 74, 84, 255))
    c.rrect(60, 154, 150, 164, 4, (60, 64, 74, 255))
    c.rrect(8, 8, 202, 140, 10, (44, 46, 54, 255), width=4)
    c.rect(18, 18, 192, 128, fill=(8, 12, 10, 255))
    rows = [("AAPL", "231.40", "+1.2%", 1), ("NVDA", "118.75", "-2.3%", -1), ("TLT", "92.10", "+0.4%", 1), ("BTC", "64,210", "+3.8%", 1), ("DMC", "∞", "+11%", 1)]
    f = font("mono", 10)
    for i, (t, px, ch, up) in enumerate(rows):
        y = 32 + i * 20
        c.text((26, y), t, f, fill=(255, 176, 0, 255), anchor="lm")
        c.text((120, y), px, f, fill=(230, 230, 230, 255), anchor="rm")
        c.text((184, y), ("▲" if up > 0 else "▼") + ch, f, fill=(60, 220, 110, 255) if up > 0 else (240, 80, 80, 255), anchor="rm")
    c.save("ticker-terminal.png")


def gold_bar():
    c = Canvas(190, 130)
    def bar(dx, dy):
        top = [(30 + dx, 40 + dy), (130 + dx, 40 + dy), (150 + dx, 60 + dy), (50 + dx, 60 + dy)]
        front = [(50 + dx, 60 + dy), (150 + dx, 60 + dy), (160 + dx, 96 + dy), (40 + dx, 96 + dy)]
        side = [(30 + dx, 40 + dy), (50 + dx, 60 + dy), (40 + dx, 96 + dy), (20 + dx, 76 + dy)]
        c.poly(side, fill=(196, 140, 24, 255))
        c.poly(front, fill=(240, 188, 50, 255))
        c.poly(top, fill=(255, 220, 110, 255))
        c.text((100 + dx, 79 + dy), "999.9", font("bold", 12), fill=(150, 98, 10, 255))
    bar(14, 22)
    bar(-4, -16)
    c.line([(150, 18), (158, 10)], fill=(255, 255, 255, 255), width=3)
    c.save("gold-bar.png")


def bond_certificate():
    c = Canvas(210, 150)
    c.rect(8, 8, 202, 142, fill=(246, 238, 210, 255), outline=INK, width=3)
    c.rect(16, 16, 194, 134, fill=None, outline=(46, 110, 80, 255), width=3)
    c.rect(21, 21, 189, 129, fill=None, outline=(46, 110, 80, 180), width=1)
    c.text((105, 36), "TREASURY BOND", font("serif", 15), fill=(30, 80, 56, 255))
    c.text((105, 54), "PAYS COUPONS · GOES HOME AT 5", font("bold", 6), fill=(80, 90, 80, 255))
    c.ellipse(26, 66, 66, 106, (200, 60, 60, 255), width=2)
    c.text((46, 86), "$", font("serif", 18), fill=(255, 240, 220, 255))
    c.text((140, 88), "$1,000", font("serif", 20), fill=(30, 80, 56, 255))
    for i in range(5):  # coupon strip
        x = 26 + i * 33
        c.rect(x, 110, x + 29, 128, fill=(236, 226, 190, 255), outline=(46, 110, 80, 255), width=1)
        c.text((x + 14.5, 119), f"C{i + 1}", font("bold", 7), fill=(46, 110, 80, 255))
    c.save("bond-certificate.png")


def capital_logo():
    src = os.path.join(OUT, "dunder-mifflin-logo.png")
    if not os.path.exists(src):
        print("skip logo: source missing")
        return
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    big = im.resize((w * S, h * S), Image.LANCZOS)
    d = ImageDraw.Draw(big)
    # The bottom band ("PAPER COMPANY") sits on white; paint it over and re-letter it.
    band = (int(14 * S), int(h * 0.70 * S), int((w - 14) * S), int((h - 13) * S))
    d.rectangle(band, fill=(255, 255, 255, 255))
    navy = (28, 44, 92, 255)
    f = font("bold", 15)
    d.text(((band[0] + band[2]) / 2, (band[1] + band[3]) / 2), "CAPITAL PARTNERS", font=f, fill=navy, anchor="mm")
    big.resize((w, h), Image.LANCZOS).save(os.path.join(OUT, "dunder-mifflin-capital-logo.png"))
    print("wrote public/sprites/office/props/dunder-mifflin-capital-logo.png")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for fn in (bear_market, bull_market, candlestick_chart, calculator_keleven, trade_ticket,
               compliance_stamp, wuphf_coin, client_report, ticker_terminal, gold_bar,
               bond_certificate, capital_logo):
        fn()
