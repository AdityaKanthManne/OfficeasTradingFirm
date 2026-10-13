#!/usr/bin/env python3
"""
build-scranton-iso.py — the Dunder Mifflin Scranton floor, drawn tile by tile in
the original Claude Office style (cream walls, dark outlines, slate carpet, the
original standing desks / plants / filing cabinets / printer / coffee machine).

Layers
  base   floors, the three back walls (north, east, elevator hall), anything
         standing against those walls, the warehouse stairwell, floor shadows
  atlas  every other wall (cut into 1-tile slices) and every piece of furniture,
         each with its own z so people walk behind and in front of it
  grid   0.5-tile walkability grid (A* in the browser) + Michael's collisions

Usage:  python3 scripts/build-scranton-iso.py [--preview]
Writes  public/rooms/scranton-iso-{day,night}.png, public/rooms/scranton-iso-atlas-{day,night}.png,
        public/rooms/scranton-iso-mini.png, firm/scranton-floor.json,
        docs/reference/scranton-iso-preview.png (with --preview)
"""
import json
import math
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import isolib as L  # noqa: E402
from isolib import P, mul, rgba, OUT  # noqa: E402

ROOT = L.ROOT
SS = L.SS
TW, TH, VZ = L.TW, L.TH, L.VZ
random.seed(7)

# ---------------------------------------------------------------------------
# Palette (sampled from the original office art)
# ---------------------------------------------------------------------------
NAVY = (27, 31, 48)
CREAM = (234, 224, 198)
CAP = (247, 241, 226)
BASEB = (118, 90, 66)
SLAB = (84, 92, 112)
WOOD = (178, 126, 74)
WOOD_D = (128, 86, 50)
WOOD_L = (204, 156, 102)
METAL = (156, 162, 172)
STEEL = (196, 202, 210)
DARK = (58, 62, 74)
WHITE = (240, 242, 244)
FABRIC = (118, 132, 150)
GLASS = (196, 226, 242, 64)

CARPET = {
    "bullpen": (104, 117, 131), "hall": (88, 95, 110), "michael": (122, 112, 104), "conference": (96, 110, 132),
    "annex": (106, 116, 128), "accounting": (112, 118, 128), "ryan": (118, 110, 104), "waiting": (100, 112, 126),
}
LINO = ((224, 216, 192), (210, 200, 174))
TILE = ((228, 234, 238), (212, 220, 226))
SUPPLY = ((186, 182, 172), (176, 172, 162))
STAIR_CARPET = (132, 52, 58)

H_BACK, H_MID, H_LOW, H_PART = 4.6, 1.7, 0.5, 1.35
WALL_T = 0.25

# ---------------------------------------------------------------------------
# Projection / canvas
# ---------------------------------------------------------------------------
OUTLINE = [(0, 6), (16, 6), (16, 0), (100, 0), (100, 34), (80, 34), (80, 37), (66, 37), (66, 34), (34, 34),
           (34, 42), (16, 42), (16, 14), (0, 14)]
MARGIN = 70
_s = [(u + v) for u, v in OUTLINE]
_d = [(v - u) for u, v in OUTLINE]
OXv = MARGIN - min(_s) * TW / 2
OYv = MARGIN + H_BACK * VZ + 8 - min(_d) * TH / 2
L.configure(OXv, OYv)
IW = int(math.ceil(OXv + max(_s) * TW / 2 + MARGIN))
IH = int(math.ceil(OYv + max(_d) * TH / 2 + 0.6 * VZ + MARGIN))

FLOOR_RECTS = [(0, 6, 16, 14), (16, 0, 66, 34), (16, 34, 34, 42), (66, 0, 100, 34), (66, 34, 80, 37)]


def pct(u, v, h=0.0):
    x, y = P(u, v, h)
    return round(x / IW * 100, 3), round(y / IH * 100, 3)


# ---------------------------------------------------------------------------
# Objects
# ---------------------------------------------------------------------------
class Obj:
    def __init__(self, name, draw, ref, box, block=None, base=False, shadow=True, zbias=0.0):
        self.name, self.draw, self.ref, self.box = name, draw, ref, box
        self.block = block if block is not None else [box[:4]]
        self.base, self.shadow, self.zbias = base, shadow, zbias


OBJS: list[Obj] = []
SPOTS = {}          # id -> dict(u, v, type, facing, room)
DESK_OWNERS = {}    # spot id -> [slugs]


def add(o):
    OBJS.append(o)
    return o


NO_SIT = {"meet-front", "desk-darryl", "desk-roy", "float-break-hall", "float-supply"}


def spot(sid, u, v, stype, facing, room, owners=None):
    """sit: people sit down here (there's a chair, couch or stool) — desks, meeting rows, tables, couches"""
    sit = stype in ("desk", "meeting-seat", "lounge") and sid not in NO_SIT and not sid.startswith("meet-stand")
    SPOTS[sid] = dict(u=u, v=v, type=stype, facing=facing, room=room, sit=sit)
    if owners is not None:
        DESK_OWNERS[sid] = owners


# ---- small helpers --------------------------------------------------------
def prop_on(p, name, u, v, h, w_px, flip=False):
    p.sprite("office/props/" + name + ".png", u, v, w_px, h=h, flip=flip)


def chair(u, v, back, col=(64, 70, 86), name="chair", z_behind=0.45, seat_h=0.72):
    """Office chair. `back` = side the backrest is on: n/s/e/w."""
    def draw(p):
        p.disc(u, v, 0.34, 0.02, (0, 0, 0, 50))
        p.box(u - 0.05, v - 0.05, u + 0.05, v + 0.05, 0.08, seat_h, DARK, outline=None)
        p.box(u - 0.3, v - 0.04, u + 0.3, v + 0.04, 0.03, 0.09, DARK)
        p.box(u - 0.04, v - 0.3, u + 0.04, v + 0.3, 0.03, 0.09, DARK)
        bw = {"n": (u - 0.32, v - 0.36, u + 0.32, v - 0.26), "s": (u - 0.32, v + 0.26, u + 0.32, v + 0.36),
              "w": (u - 0.36, v - 0.32, u - 0.26, v + 0.32), "e": (u + 0.26, v - 0.32, u + 0.36, v + 0.32)}[back]
        if back in "ne":
            p.box(*bw, seat_h, seat_h + 0.85, col)
            p.box(u - 0.33, v - 0.33, u + 0.33, v + 0.33, seat_h - 0.1, seat_h, col)
        else:
            p.box(u - 0.33, v - 0.33, u + 0.33, v + 0.33, seat_h - 0.1, seat_h, col)
            p.box(*bw, seat_h, seat_h + 0.85, col)
    # depth: a backrest on the far side (n/e) sits behind whoever is in the chair; one on the
    # camera side (s/w) is drawn in front of them, so a seated person shows head and shoulders over it
    d = 0.5 * z_behind
    ref = (u + d, v - d) if back in "ne" else (u - 0.3, v + 0.3)
    return add(Obj(name, draw, ref, (u - 0.4, v - 0.4, u + 0.4, v + 0.4, 1.8), block=[], shadow=False))


def plant(kind, u, v, w=1.0, base=False):
    sprite = {"monstera": "decoration/monstera-plant.png", "snake": "decoration/snake-plant.png",
              "money": "decoration/money-tree.png"}[kind]
    px = {"monstera": 46, "snake": 34, "money": 40}[kind] * w

    def draw(p):
        p.sprite(sprite, u, v, px, dy=4)
    return add(Obj("plant", draw, (u, v), (u - 0.45, v - 0.45, u + 0.45, v + 0.45, 3.2), base=base))


def desk(kind, u0, v0, owner_spot=None, owners=None, room="bullpen", props=(), chair_col=(64, 70, 86)):
    """The original standing desk sprites. kind = left-front | left-rear | right-front | right-rear.
    Returns the seat (u, v, facing)."""
    long_u = kind.startswith("left")
    u1, v1 = (u0 + 2.5, v0 + 1.25) if long_u else (u0 + 1.25, v0 + 2.5)
    uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
    seat, facing, back = {
        "left-front": ((uc, v1 + 0.72), "rear-left", "s"),
        "left-rear": ((uc, v0 - 0.72), "front-left", "n"),
        "right-front": ((u0 - 0.72, vc), "rear-right", "w"),
        "right-rear": ((u1 + 0.72, vc), "front-right", "e"),
    }[kind]

    def draw(p):
        p.sprite(f"furniture/standing-desk-{kind}.png", uc, vc, 92, dy=(2.5 + 1.25) * TH / 4 + 2)
        for i, pr in enumerate(props):
            # props sit on the user-side front corner of the desk top
            if kind == "left-front":
                pu, pv = u0 + 0.45 + i * 0.7, v1 - 0.3
            elif kind == "left-rear":
                pu, pv = u1 - 0.45 - i * 0.7, v0 + 0.55
            elif kind == "right-front":
                pu, pv = u0 + 0.35, v1 - 0.45 - i * 0.7
            else:
                pu, pv = u1 - 0.35, v0 + 0.55 + i * 0.7
            prop_on(p, pr, pu, pv, 1.32, 17)
    add(Obj(f"desk-{kind}", draw, (uc, vc), (u0, v0, u1, v1, 2.9), block=[(u0 + 0.1, v0 + 0.1, u1 - 0.1, v1 - 0.1)]))
    chair(seat[0], seat[1], back, chair_col)
    if owner_spot:
        spot(owner_spot, seat[0], seat[1], "desk", facing, room, owners)
    return seat


def filing(u, v, flip=False, base=False):
    """Original filing-cabinet sprite. Unflipped the drawers face west; flipped they face south."""
    def draw(p):
        p.sprite("furniture/filling-closed.png", u, v, 34, dy=3, flip=flip)
    return add(Obj("filing", draw, (u, v), (u - 0.42, v - 0.42, u + 0.42, v + 0.42, 2.6), base=base))


def round_table(uc, vc, r=0.9, col=WOOD_L):
    def draw(p):
        p.disc(uc, vc, r * 0.55, 0.02, (0, 0, 0, 40))
        p.cyl(uc, vc, 0.09, 0.05, 1.0, DARK, outline=None)
        p.cyl(uc, vc, 0.45, 0.0, 0.06, DARK)
        p.cyl(uc, vc, r, 0.95, 1.06, col)
    return add(Obj("table", draw, (uc, vc), (uc - r, vc - r, uc + r, vc + r, 1.2),
                   block=[(uc - r * 0.8, vc - r * 0.8, uc + r * 0.8, vc + r * 0.8)]))


def couch(u0, v0, u1, v1, facing, col=(132, 138, 150), base=False):
    """facing = side people sit facing: s or w"""
    def draw(p):
        seat_h, back_h, arm_h = 0.75, 1.55, 1.05
        if facing == "s":
            p.box(u0, v0, u1, v0 + 0.45, 0.1, back_h, col)                 # back
            p.box(u0, v0 + 0.3, u1, v1, 0.1, seat_h, col)                   # seat
            for a in (u0, u1 - 0.35):
                p.box(a, v0 + 0.2, a + 0.35, v1, 0.1, arm_h, mul(col, 0.95))
            n = max(2, int((u1 - u0) / 1.3))
            for i in range(1, n):
                uu = u0 + (u1 - u0) * i / n
                p.line([(uu, v0 + 0.5, seat_h), (uu, v1, seat_h)], fill=mul(col, 0.7), lw=2)
        else:  # facing west: back on the east side
            p.box(u1 - 0.45, v0, u1, v1, 0.1, back_h, col)
            p.box(u0, v0, u1 - 0.3, v1, 0.1, seat_h, col)
            for a in (v0, v1 - 0.35):
                p.box(u0, a, u1 - 0.2, a + 0.35, 0.1, arm_h, mul(col, 0.95))
    return add(Obj("couch", draw, ((u0 + u1) / 2, (v0 + v1) / 2), (u0, v0, u1, v1, 1.7), base=base))


def water_cooler(u, v, base=False):
    def draw(p):
        p.box(u - 0.3, v - 0.3, u + 0.3, v + 0.3, 0, 1.45, WHITE)
        p.box(u - 0.12, v + 0.3, u + 0.12, v + 0.34, 0.85, 1.0, (60, 120, 200))
        p.cyl(u, v, 0.26, 1.45, 2.35, (150, 200, 240), top=(185, 220, 245))
        p.cyl(u, v, 0.1, 2.35, 2.45, (90, 150, 220))
    return add(Obj("cooler", draw, (u, v), (u - 0.35, v - 0.35, u + 0.35, v + 0.35, 2.6), base=base))


def trash(u, v):
    def draw(p):
        p.cyl(u, v, 0.2, 0, 0.55, (90, 96, 108), top=(40, 42, 50))
    return add(Obj("trash", draw, (u, v), (u - 0.22, v - 0.22, u + 0.22, v + 0.22, 0.7)))


def paper_boxes(u, v, n=2, base=False):
    def draw(p):
        for i in range(n):
            p.sprite("office/props/dunder-mifflin-paper-box.png", u, v, 30, h=i * 0.62, dy=2)
    return add(Obj("boxes", draw, (u, v), (u - 0.4, v - 0.4, u + 0.4, v + 0.4, 0.8 * n + 0.6), base=base))


def bookshelf(u0, v0, u1, v1, h, along="u", base=True, boxes=False):
    def draw(p):
        p.box(u0, v0, u1, v1, 0, h, WOOD_D)
        shelves = 4
        for i in range(shelves):
            h0 = 0.12 + i * (h - 0.2) / shelves
            h1 = h0 + (h - 0.2) / shelves - 0.12
            if along == "u":  # shelf face is the south face
                x = u0 + 0.12
                while x < u1 - 0.25:
                    w = random.uniform(0.12, 0.28) if not boxes else random.uniform(0.45, 0.7)
                    w = min(w, u1 - 0.12 - x)
                    bh = h1 - h0 - (random.uniform(0, 0.12) if not boxes else 0.02)
                    col = random.choice([(170, 60, 50), (60, 90, 150), (210, 170, 70), (80, 130, 90), (230, 225, 210), (120, 70, 120)])
                    if boxes:
                        col = random.choice([(232, 232, 228), (214, 208, 196), (60, 92, 160)])
                    p.poly([(x, v1, h0), (x + w, v1, h0), (x + w, v1, h0 + bh), (x, v1, h0 + bh)], rgba(col), lw=2)
                    x += w + 0.02
            else:  # face is the west face
                x = v0 + 0.12
                while x < v1 - 0.25:
                    w = random.uniform(0.45, 0.7) if boxes else random.uniform(0.12, 0.28)
                    w = min(w, v1 - 0.12 - x)
                    bh = h1 - h0 - 0.02
                    col = random.choice([(232, 232, 228), (214, 208, 196), (60, 92, 160)]) if boxes else \
                        random.choice([(170, 60, 50), (60, 90, 150), (210, 170, 70), (80, 130, 90)])
                    p.poly([(u0, x, h0), (u0, x + w, h0), (u0, x + w, h0 + bh), (u0, x, h0 + bh)], mul(rgba(col), 0.85), lw=2)
                    x += w + 0.02
            # shelf board
            if along == "u":
                p.poly([(u0, v1, h1 + 0.02), (u1, v1, h1 + 0.02), (u1, v1, h1 + 0.1), (u0, v1, h1 + 0.1)], rgba(WOOD), lw=2)
            else:
                p.poly([(u0, v0, h1 + 0.02), (u0, v1, h1 + 0.02), (u0, v1, h1 + 0.1), (u0, v0, h1 + 0.1)], mul(rgba(WOOD), 0.8), lw=2)
    return add(Obj("shelf", draw, ((u0 + u1) / 2, (v0 + v1) / 2), (u0, v0, u1, v1, h + 0.3), base=base))


# ---------------------------------------------------------------------------
# Walls
# ---------------------------------------------------------------------------
# (axis, const, a, b, kind, deco)   axis 'u' = wall runs along u at v=const; 'v' = along v at u=const
RUNS = []
DECO = {}   # run index -> list of (t0, t1, h0, h1, image)


def run(axis, c, a, b, kind, deco=()):
    RUNS.append((axis, c, a, b, kind))
    DECO[len(RUNS) - 1] = list(deco)


def sign_img(text, size=14, fg=(250, 250, 250), bg=(36, 52, 92)):
    p = L.Painter(Image.new("RGBA", (4, 4)))
    im = p.text_img(text, size, fg, bg=rgba(bg), pad=5)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, im.width - 1, im.height - 1], outline=(30, 30, 40), width=SS * 2)
    return im


def framed(name, pad=10, frame=(70, 54, 40)):
    im = L.sprite("office/props/" + name + ".png")
    out = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), rgba(frame))
    ImageDraw.Draw(out).rectangle([pad // 2, pad // 2, out.width - pad // 2, out.height - pad // 2], fill=(245, 242, 232, 255))
    out.alpha_composite(im, (pad, pad))
    return out


# Low exterior walls (the near side of the building — cut away so you can see in)
for r in [("v", 0, 6, 14), ("u", 14, 0, 16), ("v", 16, 14, 42), ("u", 42, 16, 34), ("v", 34, 34, 42),
          ("u", 34, 34, 66), ("v", 66, 34, 37), ("u", 37, 66, 80), ("v", 80, 34, 37), ("u", 34, 80, 100)]:
    run(*r, "low")
# Glass: the entrance, Michael's office, the conference room
run("v", 16, 6, 8.5, "glass")
run("v", 16, 11.5, 14, "glass")
run("v", 24, 0, 12, "glass")
run("u", 12, 24, 25, "glass")
run("u", 12, 27, 36, "glass", deco=[(27.25, 29.6, 1.95, 2.35, sign_img("MICHAEL SCOTT · MANAGING PARTNER", 11, (30, 30, 30), (232, 214, 150)))])
run("u", 12, 36, 42.6, "glass", deco=[(38.0, 41.6, 2.05, 2.45, sign_img("CONFERENCE ROOM", 12))])
run("u", 12, 44.6, 50, "glass")
# Interior walls
run("v", 36, 0, 12, "mid")
run("v", 50, 0, 12, "mid")
run("u", 8, 52.0, 55, "mid", deco=[(52.4, 54.6, 1.05, 1.5, sign_img("SUPPLY", 11))])
run("v", 55, 0, 12, "mid")
run("u", 12, 55, 56.2, "mid")
run("u", 12, 59.8, 62, "mid", deco=[(60.0, 61.8, 1.0, 1.45, sign_img("WAREHOUSE ▼", 10, (20, 20, 20), (240, 200, 60)))])
run("v", 62, 0, 12, "mid")
run("u", 12, 62, 70, "mid", deco=[(65.6, 66.2, 0.6, 1.35, None), (66.8, 69.6, 1.0, 1.45, sign_img("BREAK ROOM", 11))])
run("u", 12, 73, 80, "mid", deco=[(76.2, 79.4, 1.0, 1.45, sign_img("THE ANNEX →", 11))])
run("u", 15, 62, 66, "mid")
run("u", 15, 69, 80, "mid", deco=[(72.4, 75.2, 0.35, 1.55, L.sprite("office/props/pretzel-day.png"))])
run("v", 62, 15, 19, "mid")
run("v", 62, 22.5, 27, "mid")
run("v", 80, 15, 34, "mid")
run("u", 27, 62, 67.5, "mid")
run("u", 27, 69.5, 75.5, "mid", deco=[(70.2, 71.0, 0.45, 1.25, "urinal"), (71.6, 72.4, 0.45, 1.25, "urinal")])
run("u", 27, 77.5, 80, "mid")
run("v", 66, 27, 37, "mid")
run("v", 73, 27, 37, "mid", deco=[(29.0, 31.6, 1.05, 1.6, "mirror")])
run("v", 92, 0, 7, "mid")
run("u", 7, 92, 93, "mid")
run("u", 7, 94.6, 100, "mid", deco=[(95.4, 98.6, 0.9, 1.45, sign_img("RYAN · WUPHF.com HQ", 9, (20, 20, 20), (250, 250, 250)))])
# Accounting partitions (fabric cubicle walls)
run("u", 28, 16, 26.8, "part", deco=[(18.0, 22.4, 0.7, 1.15, sign_img("ACCOUNTING", 11, (250, 250, 250), (70, 90, 70)))])
run("v", 34, 28, 31.6, "part")

DOOR_GAPS = [  # (axis, const, a, b) — kept walkable
    ("v", 16, 8.5, 11.5), ("u", 12, 25, 27), ("u", 12, 42.6, 44.6), ("u", 8, 50, 52.0), ("u", 12, 56.2, 59.8),
    ("u", 12, 70, 73), ("u", 15, 66, 69), ("v", 62, 19, 22.5), ("u", 27, 67.5, 69.5), ("u", 27, 75.5, 77.5),
    ("u", 7, 93, 94.6), ("v", 34, 31.6, 34), ("u", 28, 26.8, 34),
]


def wall_heights(kind):
    return {"low": H_LOW, "mid": H_MID, "glass": 2.75, "part": H_PART}[kind]


def draw_run(p, axis, c, a, b, kind, deco):
    t = WALL_T / 2
    h = wall_heights(kind)
    col = CREAM if kind != "part" else FABRIC
    if axis == "u":
        box = (a, c - t, b, c + t)
    else:
        box = (c - t, a, c + t, b)
    u0, v0, u1, v1 = box
    if kind == "glass":
        hs = 0.95
        p.box(u0, v0, u1, v1, 0, hs, CREAM, top=rgba(CAP))
        # glass pane on the visible plane + blinds + mullions
        if axis == "u":
            pane = [(a, c, hs), (b, c, hs), (b, c, 2.65), (a, c, 2.65)]
        else:
            pane = [(c, a, hs), (c, b, hs), (c, b, 2.65), (c, a, 2.65)]
        p.poly(pane, GLASS, outline=None)
        for k in range(10):
            hh = 1.75 + k * 0.09
            if axis == "u":
                p.line([(a, c, hh), (b, c, hh)], fill=(240, 244, 248, 70), lw=2)
            else:
                p.line([(c, a, hh), (c, b, hh)], fill=(240, 244, 248, 70), lw=2)
        # glare streaks
        for k in range(int((b - a) / 2.2) + 1):
            g0 = a + 0.4 + k * 2.2
            if g0 + 0.5 > b:
                break
            if axis == "u":
                p.poly([(g0, c, 1.1), (g0 + 0.25, c, 1.1), (g0 + 0.75, c, 2.5), (g0 + 0.5, c, 2.5)], (255, 255, 255, 46), outline=None)
            else:
                p.poly([(c, g0, 1.1), (c, g0 + 0.25, 1.1), (c, g0 + 0.75, 2.5), (c, g0 + 0.5, 2.5)], (255, 255, 255, 46), outline=None)
        # mullions every ~2 tiles + ends + top frame
        posts = [a] + [a + k * 2.0 for k in range(1, int((b - a) / 2.0) + 1) if a + k * 2.0 < b - 0.4] + [b - 0.08]
        for m in posts:
            if axis == "u":
                p.box(m, c - 0.05, m + 0.08, c + 0.05, hs, 2.75, STEEL, lw=2)
            else:
                p.box(c - 0.05, m, c + 0.05, m + 0.08, hs, 2.75, STEEL, lw=2)
        if axis == "u":
            p.box(a, c - 0.06, b, c + 0.06, 2.65, 2.78, STEEL, lw=2)
        else:
            p.box(c - 0.06, a, c + 0.06, b, 2.65, 2.78, STEEL, lw=2)
        return
    p.box(u0, v0, u1, v1, 0, h, col, top=rgba(CAP) if kind != "part" else rgba((170, 176, 186)))
    # baseboard on the visible long face
    bb = 0.16 if kind != "part" else 0.1
    if axis == "u":
        p.poly([(u0, v1, 0), (u1, v1, 0), (u1, v1, bb), (u0, v1, bb)], rgba(BASEB if kind != "part" else DARK), lw=2)
    else:
        p.poly([(u0, v0, 0), (u0, v1, 0), (u0, v1, bb), (u0, v0, bb)], mul(rgba(BASEB if kind != "part" else DARK), 0.85), lw=2)
    if kind == "part":
        # fabric texture stripes
        for k in range(int((b - a) / 0.5)):
            tt = a + 0.25 + k * 0.5
            if axis == "u":
                p.line([(tt, v1, 0.15), (tt, v1, h - 0.05)], fill=(255, 255, 255, 22), lw=2)
            else:
                p.line([(u0, tt, 0.15), (u0, tt, h - 0.05)], fill=(255, 255, 255, 18), lw=2)
    for (t0, t1, h0, h1, im) in deco:
        if im is None:  # fire extinguisher
            if axis == "u":
                p.box(t0 + 0.12, v1, t0 + 0.42, v1 + 0.22, h0, h1, (200, 40, 40))
        elif im == "urinal":
            p.box(t0, v1, t1, v1 + 0.35, h0, h1, WHITE)
        elif im == "mirror":
            p.poly([(u0, t0, h0), (u0, t1, h0), (u0, t1, h1), (u0, t0, h1)], (200, 220, 230, 255))
        else:
            if axis == "u":
                p.face_n(im, t0, t1, h0, h1, v=v1 + 0.01)
            else:
                p.face_w(im, t0, t1, h0, h1, u=u0 - 0.01)


# ---------------------------------------------------------------------------
# Layout — every room of the Scranton branch
# ---------------------------------------------------------------------------
LABELS = []


def label(lid, name, sub, u, v):
    LABELS.append(dict(id=lid, name=name, sub=sub, u=u, v=v))


# ---- Elevator hall ----------------------------------------------------------
label("elevators", "Elevators", "2nd floor lobby", 6.5, 11.2)
spot("door", 3.3, 7.3, "door", "rear-left", "elevators")
add(Obj("bench", lambda p: (p.box(10.4, 6.25, 14.2, 7.15, 0.0, 0.62, WOOD_D),
                            p.box(10.5, 6.25, 14.1, 7.05, 0.62, 0.78, WOOD_L)),
        (12.3, 6.7), (10.4, 6.25, 14.2, 7.15, 0.9), base=True))
plant("snake", 0.9, 13.0)
plant("monstera", 15.0, 7.0)

# ---- Waiting area -----------------------------------------------------------
label("waiting", "Waiting Area", "", 19.5, 7.5)
couch(17.0, 0.35, 21.2, 1.75, "s", col=(128, 134, 146), base=True)
spot("float-waiting-couch", 19.1, 2.25, "lounge", "front-left", "waiting")
add(Obj("armchair", lambda p: (p.box(22.3, 4.0, 23.7, 5.4, 0.1, 0.7, (150, 116, 90)),
                               p.box(23.3, 4.0, 23.7, 5.4, 0.1, 1.45, (150, 116, 90)),
                               p.box(22.3, 4.0, 23.7, 4.3, 0.1, 1.0, (140, 108, 84)),
                               p.box(22.3, 5.1, 23.7, 5.4, 0.1, 1.0, (140, 108, 84))),
        (23.3, 4.7), (22.3, 4.0, 23.7, 5.4, 1.6), block=[]))
spot("float-waiting-chair", 22.85, 4.7, "lounge", "front-right", "waiting")
add(Obj("coffee-table", lambda p: (p.box(18.0, 3.5, 20.5, 4.6, 0.0, 0.48, WOOD),
                                   p.poly([(18.4, 3.7, 0.49), (19.2, 3.75, 0.49), (19.15, 4.3, 0.49), (18.35, 4.25, 0.49)], rgba((220, 80, 70)), lw=2),
                                   p.poly([(19.5, 3.8, 0.49), (20.2, 3.75, 0.49), (20.25, 4.35, 0.49), (19.55, 4.4, 0.49)], rgba((90, 140, 210)), lw=2)),
        (19.25, 4.05), (18.0, 3.5, 20.5, 4.6, 0.6)))
plant("monstera", 23.3, 0.9, base=True)

# ---- Reception (Pam / Erin) -------------------------------------------------
label("reception", "Reception", "Order intake", 24.3, 18.6)


def reception(p):
    oak = (190, 140, 88)
    # inner (lower) desk surfaces
    p.box(22.3, 12.5, 23.1, 16.2, 0, 1.0, oak)
    p.box(22.3, 15.4, 26.6, 16.2, 0, 1.0, oak)
    # Pam's monitor + keyboard
    p.box(22.55, 14.3, 22.75, 14.4, 1.0, 1.15, DARK)
    p.box(22.45, 13.85, 22.6, 15.15, 1.15, 1.95, DARK, top=rgba((40, 44, 54)))
    p.poly([(22.6, 13.95, 1.22), (22.6, 15.05, 1.22), (22.6, 15.05, 1.88), (22.6, 13.95, 1.88)], rgba((120, 180, 230)), lw=2)
    # tall counter: west leg then south leg
    p.box(21.4, 12.5, 22.3, 17.1, 0, 1.45, (172, 122, 74), top=rgba((214, 176, 120)))
    p.box(21.4, 16.2, 27.0, 17.1, 0, 1.45, (172, 122, 74), top=rgba((214, 176, 120)))
    p.face_n(L.sprite("office/props/dunder-mifflin-capital-logo.png"), 23.2, 25.6, 0.25, 1.25, v=17.11)
    # candy jar + bell + phone on the counter
    p.cyl(24.6, 16.65, 0.2, 1.45, 1.85, (220, 236, 245), top=(240, 120, 140))
    for (du, dv, cc) in [(-0.08, 0, (240, 70, 70)), (0.06, 0.05, (80, 170, 240)), (0.02, -0.07, (250, 210, 60))]:
        p.disc(24.6 + du, 16.65 + dv, 0.05, 1.62, rgba(cc))
    p.box(26.0, 16.4, 26.5, 16.85, 1.45, 1.6, (40, 40, 46))
    prop_on(p, "client-report", 21.85, 14.0, 1.45, 18)


add(Obj("reception", reception, (22.6, 16.0), (21.4, 12.5, 27.0, 17.1, 2.2),
        block=[(21.4, 12.5, 22.3, 17.1), (21.4, 16.2, 27.0, 17.1), (22.3, 12.5, 23.1, 16.2), (22.3, 15.4, 26.6, 16.2)]))
chair(24.4, 14.25, "e", (70, 74, 92))
spot("desk-pam", 24.4, 14.25, "desk", "front-right", "reception", ["pam-beesly", "erin-hannon"])
add(Obj("mat", lambda p: p.poly([(16.3, 8.6), (18.4, 8.6), (18.4, 11.4), (16.3, 11.4)], rgba((70, 60, 58)), lw=2),
        (17.3, 10), (16.3, 8.6, 18.4, 11.4, 0.05), block=[], base=True, shadow=False))

# ---- Michael's office -------------------------------------------------------
label("michael", "Michael's Office", "Managing Partner", 30.0, 9.5)


def michael_desk(p):
    u0, v0, u1, v1 = 27.6, 3.4, 32.8, 5.3
    p.box(u0 + 0.1, v0 + 0.1, u0 + 1.2, v1 - 0.05, 0, 1.12, WOOD_D)   # pedestal
    p.box(u1 - 1.2, v0 + 0.1, u1 - 0.1, v1 - 0.05, 0, 1.12, WOOD_D)
    p.box(u0 + 1.2, v1 - 0.25, u1 - 1.2, v1 - 0.1, 0.4, 1.12, mul(rgba(WOOD_D), 0.9))  # modesty panel
    p.box(u0, v0, u1, v1, 1.12, 1.3, WOOD, top=rgba((196, 146, 92)))
    for i in range(3):  # drawers
        hh = 0.2 + i * 0.3
        p.poly([(u1 - 1.1, v1 - 0.05, hh), (u1 - 0.2, v1 - 0.05, hh), (u1 - 0.2, v1 - 0.05, hh + 0.22), (u1 - 1.1, v1 - 0.05, hh + 0.22)],
               mul(rgba(WOOD), 0.92), lw=2)
    # monitor (facing Michael, north) + keyboard + papers + mug + nameplate
    p.box(29.4, 4.6, 31.4, 4.75, 1.3, 2.4, DARK, top=rgba((40, 44, 54)))
    p.box(30.25, 4.55, 30.55, 4.8, 1.3, 1.45, DARK)
    p.poly([(28.2, 3.7, 1.31), (29.0, 3.65, 1.31), (29.05, 4.3, 1.31), (28.25, 4.35, 1.31)], rgba((248, 248, 244)), lw=2)
    p.poly([(28.35, 3.85, 1.32), (29.15, 3.8, 1.32), (29.2, 4.45, 1.32), (28.4, 4.5, 1.32)], rgba((240, 238, 230)), lw=2)
    prop_on(p, "worlds-best-boss-mug", 32.2, 4.0, 1.3, 15)
    prop_on(p, "dundie-award", 27.95, 4.9, 1.3, 9)
    p.box(31.0, 5.0, 32.0, 5.18, 1.3, 1.48, (40, 34, 30), top=rgba((210, 180, 90)))


add(Obj("michael-desk", michael_desk, (30.2, 4.35), (27.6, 3.4, 32.8, 5.3, 2.6)))
chair(30.2, 2.5, "n", (40, 36, 34), name="exec-chair")
spot("spot-1", 30.2, 2.5, "desk", "front-left", "michael", ["michael-scott"])
bookshelf(24.5, 0.25, 27.3, 1.1, 3.3, base=True)


def credenza(p):
    p.box(31.4, 0.25, 35.6, 1.2, 0, 1.2, WOOD_D, top=rgba(WOOD))
    for k in range(3):
        a = 31.6 + k * 1.35
        p.poly([(a, 1.2, 0.15), (a + 1.2, 1.2, 0.15), (a + 1.2, 1.2, 1.05), (a, 1.2, 1.05)], mul(rgba(WOOD_D), 1.1), lw=2)
    prop_on(p, "serenity-by-jan-candle", 32.0, 0.75, 1.2, 12)
    prop_on(p, "bull-market", 33.3, 0.7, 1.2, 18)
    prop_on(p, "bear-market", 34.6, 0.7, 1.2, 18)


add(Obj("credenza", credenza, (33.5, 0.7), (31.4, 0.25, 35.6, 1.2, 2.0), base=True))
chair(29.0, 7.0, "s", (120, 60, 52), name="guest-chair")
chair(31.6, 7.0, "s", (120, 60, 52), name="guest-chair")
spot("float-mo-guest-1", 29.0, 7.0, "lounge", "rear-left", "michael")
spot("float-mo-guest-2", 31.6, 7.0, "lounge", "rear-left", "michael")
couch(34.3, 6.0, 35.75, 10.0, "w", col=(110, 70, 52))


def rug(p):
    p.poly([(27.0, 6.0), (33.4, 6.0), (33.4, 10.4), (27.0, 10.4)], rgba((118, 46, 52)), lw=2)
    p.poly([(27.4, 6.4), (33.0, 6.4), (33.0, 10.0), (27.4, 10.0)], None, outline=rgba((214, 180, 110)), lw=3)


add(Obj("rug", rug, (30, 8), (27, 6, 33.4, 10.4, 0.05), block=[], base=True, shadow=False))
plant("money", 25.0, 11.0)
add(Obj("door-michael", lambda p: p.box(26.85, 10.25, 27.0, 11.95, 0, 2.6, (150, 104, 62), top=rgba((180, 130, 80))),
        (26.9, 11.1), (26.85, 10.25, 27.0, 11.95, 2.7)))

# ---- Conference room --------------------------------------------------------
label("conference", "Conference Room", "Meetings & desk huddles", 43.6, 6.3)
add(Obj("whiteboard", lambda p: p.sprite("decoration/white-board.png", 38.5, 1.3, 62, dy=3),
        (38.5, 1.3), (37.6, 0.6, 39.4, 2.0, 3.6), block=[(37.7, 0.7, 39.3, 1.9)], base=True))
plant("snake", 49.1, 0.9, base=True)
spot("meet-front", 43.6, 2.55, "meeting-seat", "front-left", "conference")
MEET_SEATS = ["meet-front"]
for ri, vv in enumerate([5.0, 6.8, 8.6, 10.4]):
    for ci, uu in enumerate([37.9, 39.6, 41.3, 45.9, 47.6, 49.2]):
        sid = f"meet-r{ri}-{ci}"
        chair(uu, vv, "s", (78, 98, 140), name="conf-chair")
        spot(sid, uu, vv, "meeting-seat", "rear-left", "conference")
        MEET_SEATS.append(sid)
MEET_STAND = []
for i, (uu, vv) in enumerate([(37.0, 2.7), (40.6, 2.4), (46.8, 2.4), (49.2, 2.8), (41.9, 11.25), (45.3, 11.25),
                              (36.9, 11.3), (49.3, 11.4)]):
    sid = f"meet-stand-{i}"
    spot(sid, uu, vv, "meeting-seat", "rear-left" if vv > 6 else "front-left", "conference")
    MEET_STAND.append(sid)
add(Obj("door-conf", lambda p: p.box(44.5, 10.25, 44.65, 11.95, 0, 2.6, (150, 104, 62), top=rgba((180, 130, 80))),
        (44.55, 11.1), (44.5, 10.25, 44.65, 11.95, 2.7)))

# ---- Supply closet ----------------------------------------------------------
label("supply", "Supply Closet", "", 52.6, 4.6)
bookshelf(50.3, 0.25, 54.7, 1.25, 3.3, base=True, boxes=True)
bookshelf(53.95, 2.0, 54.8, 6.8, 2.6, along="v", base=False, boxes=True)
filing(51.4, 4.8, flip=True)
spot("spot-filing", 51.4, 5.95, "filing", "rear-left", "supply")
paper_boxes(52.9, 3.3, 2)
spot("float-supply", 52.7, 5.9, "lounge", "rear-right", "supply")

# ---- Copy alcove (between the conference room and the stairs) ----------------
def copier(p):
    p.sprite("decoration/printer-working.png", 53.4, 8.95, 60, dy=4, flip=True)


add(Obj("copier", copier, (53.4, 8.9), (52.7, 8.3, 54.1, 9.5, 2.4), block=[(52.75, 8.3, 54.05, 9.45)]))
spot("copier", 53.4, 10.3, "printer", "rear-left", "bullpen")
paper_boxes(51.0, 8.8, 1)

# ---- Warehouse stairs -------------------------------------------------------
label("stairs", "Stairs to Warehouse", "Trade Ops (downstairs)", 58.4, 10.9)
WELL = (56.2, 0.6, 60.8, 7.4)
spot("desk-darryl", 57.4, 8.55, "desk", "rear-left", "stairs", ["darryl-philbin"])
spot("desk-roy", 59.7, 9.2, "desk", "rear-left", "stairs", ["roy-anderson"])
paper_boxes(61.2, 11.0, 2)


def railing(u0, v0, u1, v1):
    def draw(p):
        n = max(2, int(max(u1 - u0, v1 - v0) / 0.8) + 1)
        for i in range(n):
            t = i / (n - 1)
            uu, vv = u0 + (u1 - u0) * t, v0 + (v1 - v0) * t
            p.box(uu - 0.04, vv - 0.04, uu + 0.04, vv + 0.04, 0, 1.15, STEEL, lw=2)
        p.box(min(u0, u1) - 0.06, min(v0, v1) - 0.06, max(u0, u1) + 0.06, max(v0, v1) + 0.06, 1.1, 1.2, (110, 116, 126), lw=2)
    return add(Obj("rail", draw, ((u0 + u1) / 2, (v0 + v1) / 2), (u0 - 0.1, v0 - 0.1, u1 + 0.1, v1 + 0.1, 1.3), block=[]))


railing(56.1, 0.7, 56.1, 7.4)
railing(60.9, 0.7, 60.9, 7.4)

# ---- Break room -------------------------------------------------------------
label("break", "Break Room", "Vending machines", 71.4, 9.6)


def vending(u0, front, accent, drinks=False):
    def draw(p):
        u1 = u0 + 2.1
        v0, v1 = 0.25, 1.75
        p.box(u0, v0, u1, v1, 0, 3.25, front, top=rgba(mul(front, 1.05)))
        # glass window with goods
        g = [(u0 + 0.2, v1, 1.0), (u1 - 0.65, v1, 1.0), (u1 - 0.65, v1, 3.0), (u0 + 0.2, v1, 3.0)]
        p.poly(g, rgba((40, 46, 60)), lw=2)
        rows = 5
        for r in range(rows):
            hh = 1.12 + r * 0.38
            for k in range(4):
                a = u0 + 0.3 + k * 0.29
                c = random.choice([(240, 80, 70), (250, 200, 60), (90, 170, 240), (120, 200, 110), (240, 140, 60)])
                if drinks:
                    c = random.choice([(220, 40, 40), (40, 90, 200), (240, 240, 240), (60, 170, 80)])
                p.poly([(a, v1 + 0.01, hh), (a + 0.2, v1 + 0.01, hh), (a + 0.2, v1 + 0.01, hh + 0.27), (a, v1 + 0.01, hh + 0.27)], rgba(c), lw=1)
        p.poly([(u0 + 0.2, v1 + 0.02, 1.0), (u0 + 0.7, v1 + 0.02, 1.0), (u1 - 0.9, v1 + 0.02, 3.0), (u1 - 1.3, v1 + 0.02, 3.0)],
               (255, 255, 255, 40), outline=None)
        # keypad + coin slot + pickup bin
        p.poly([(u1 - 0.55, v1, 2.2), (u1 - 0.15, v1, 2.2), (u1 - 0.15, v1, 2.8), (u1 - 0.55, v1, 2.8)], rgba(accent), lw=2)
        p.poly([(u0 + 0.3, v1, 0.3), (u1 - 0.8, v1, 0.3), (u1 - 0.8, v1, 0.7), (u0 + 0.3, v1, 0.7)], rgba((24, 26, 32)), lw=2)
    return add(Obj("vending", draw, (u0 + 1, 1), (u0, 0.25, u0 + 2.1, 1.75, 3.4), base=True))


vending(62.6, (60, 64, 76), (240, 200, 60))
vending(65.0, (196, 40, 44), (250, 250, 250), drinks=True)
water_cooler(79.0, 0.95, base=True)
spot("water-break", 78.2, 1.95, "water", "rear-right", "break")
add(Obj("finer-things", lambda p: p.face_n(L.sprite("office/props/finer-things-club.png"), 70.4, 73.6, 1.7, 3.5, v=0.02),
        (72, 0.2), (70.3, 0, 73.7, 0.3, 3.6), block=[], base=True, shadow=False))
round_table(69.2, 5.4)
for (du, dv, back) in [(-1.25, 0, "w"), (0, 1.25, "s"), (1.25, 0, "e"), (0, -1.25, "n")]:
    chair(69.2 + du, 5.4 + dv, back, (200, 120, 60), name="cafe-chair")
spot("float-break-1", 67.95, 5.4, "lounge", "rear-right", "break")
spot("float-break-2", 69.2, 6.65, "lounge", "rear-left", "break")
round_table(75.0, 7.2)
for (du, dv, back) in [(-1.25, 0, "w"), (0, 1.25, "s"), (1.25, 0, "e")]:
    chair(75.0 + du, 7.2 + dv, back, (200, 120, 60), name="cafe-chair")
spot("float-break-3", 73.75, 7.2, "lounge", "rear-right", "break")
trash(68.2, 0.9)
spot("float-break-hall", 64.2, 13.6, "lounge", "rear-left", "break")
plant("monstera", 79.2, 13.0)

# ---- Kitchen ----------------------------------------------------------------
label("kitchen", "Kitchen", "", 70.8, 25.0)


def counter(p):
    u0, u1, v0, v1 = 78.55, 79.85, 15.55, 23.6
    p.box(u0, v0, u1, v1, 0, 1.18, (238, 236, 230))
    for k in range(5):  # cupboard doors on the west face
        a = v0 + 0.15 + k * 1.6
        p.poly([(u0, a, 0.15), (u0, a + 1.4, 0.15), (u0, a + 1.4, 1.0), (u0, a, 1.0)], rgba((214, 210, 200)), lw=2)
    p.box(u0 - 0.05, v0, u1, v1, 1.18, 1.3, (120, 124, 132), top=rgba((168, 172, 180)))
    p.poly([(78.8, 19.5, 1.31), (79.6, 19.5, 1.31), (79.6, 20.9, 1.31), (78.8, 20.9, 1.31)], rgba((190, 200, 210)), lw=2)  # sink
    p.box(79.45, 20.05, 79.6, 20.3, 1.3, 1.75, STEEL, lw=2)  # tap
    p.sprite("appliances/coffee-on.png", 79.2, 16.75, 30, h=1.3, dy=2)
    p.box(78.75, 21.8, 79.75, 23.05, 1.3, 1.95, (230, 230, 232))  # microwave
    p.poly([(78.75, 21.95, 1.42), (78.75, 22.75, 1.42), (78.75, 22.75, 1.85), (78.75, 21.95, 1.85)], rgba((40, 46, 56)), lw=2)


add(Obj("counter", counter, (79.2, 19.5), (78.55, 15.55, 79.85, 23.6, 2.2)))
spot("coffee", 77.85, 16.75, "coffee", "rear-right", "kitchen")


def fridge(p):
    p.box(78.3, 24.1, 79.85, 26.6, 0, 3.3, (214, 218, 224), top=rgba((232, 234, 238)))
    p.line([(78.3, 24.1, 2.2), (78.3, 26.6, 2.2)], lw=2)
    p.box(78.25, 24.4, 78.3, 24.55, 1.1, 2.0, (120, 124, 132), lw=2)
    p.box(78.25, 24.4, 78.3, 24.55, 2.4, 3.0, (120, 124, 132), lw=2)
    for (vv, hh, c) in [(25.2, 2.7, (240, 90, 80)), (25.7, 2.5, (250, 210, 70)), (25.4, 1.6, (80, 160, 230))]:
        p.poly([(78.29, vv, hh), (78.29, vv + 0.3, hh), (78.29, vv + 0.3, hh + 0.25), (78.29, vv, hh + 0.25)], rgba(c), lw=1)


add(Obj("fridge", fridge, (79.1, 25.35), (78.3, 24.1, 79.85, 26.6, 3.4)))
round_table(70.8, 21.0, r=1.1)
for (du, dv, back) in [(-1.45, 0, "w"), (0, 1.45, "s"), (1.45, 0, "e"), (0, -1.45, "n")]:
    chair(70.8 + du, 21.0 + dv, back, (90, 120, 160), name="kitchen-chair")
spot("float-kitchen-1", 69.35, 21.0, "lounge", "rear-right", "kitchen")
spot("float-kitchen-2", 70.8, 22.45, "lounge", "rear-left", "kitchen")
water_cooler(63.0, 26.1)
spot("water-kitchen", 63.9, 25.3, "water", "front-right", "kitchen")
trash(77.6, 26.3)

# ---- Restrooms --------------------------------------------------------------
label("restrooms", "Restrooms", "", 73.0, 35.2)


def stalls(u0, u1, v0, v1):
    def draw(p):
        n = 2
        w = (u1 - u0) / n
        for i in range(n):
            a = u0 + i * w
            # toilet
            p.box(a + w / 2 - 0.3, v1 - 1.1, a + w / 2 + 0.3, v1 - 0.25, 0, 0.55, WHITE)
            p.box(a + w / 2 - 0.3, v1 - 0.4, a + w / 2 + 0.3, v1 - 0.15, 0.55, 1.1, WHITE)
        for i in range(n + 1):
            a = u0 + i * w
            p.box(a - 0.05, v0, a + 0.05, v1, 0.15, 1.6, (150, 170, 190), lw=2)
        p.box(u0, v0 - 0.05, u1, v0 + 0.05, 0.15, 1.6, (150, 170, 190), lw=2)
    return add(Obj("stalls", draw, ((u0 + u1) / 2, v0), (u0, v0, u1, v1, 1.8)))


stalls(66.3, 70.4, 33.4, 36.9)
stalls(75.6, 79.8, 33.4, 36.9)
for (u0, u1) in [(72.0, 72.85), (79.0, 79.85)]:
    add(Obj("sink", (lambda a, b: lambda p: (p.box(a, 29.0, b, 31.6, 0, 0.95, (232, 232, 230)),
                                              p.disc((a + b) / 2, 29.7, 0.22, 0.96, rgba((190, 205, 215))),
                                              p.disc((a + b) / 2, 30.9, 0.22, 0.96, rgba((190, 205, 215)))))(u0, u1),
            ((u0 + u1) / 2, 30.3), (u0, 29.0, u1, 31.6, 1.2)))

# ---- The Annex --------------------------------------------------------------
label("annex", "The Annex", "Compliance · Intel · Digital Assets", 89.5, 31.4)
for i in range(4):
    filing(81.4 + i * 0.86, 0.75, flip=True, base=True)
seat = desk("left-rear", 95.6, 2.9, props=("wuphf-coin",))
spot("desk-ryan", seat[0], seat[1], "desk", "front-left", "annex", ["ryan-howard"])
bookshelf(92.4, 0.25, 94.9, 1.0, 2.4, base=True, boxes=True)
seat = desk("left-front", 82.6, 17.2, props=("golden-ticket-box",))
spot("desk-kelly", seat[0], seat[1], "desk", "rear-left", "annex", ["kelly-kapoor"])
seat = desk("left-front", 86.0, 8.4, props=("candlestick-chart",))
spot("desk-annex-2", seat[0], seat[1], "desk", "rear-left", "annex", [])
seat = desk("right-rear", 96.6, 13.6, props=("compliance-stamp",))
spot("desk-toby", seat[0], seat[1], "desk", "front-right", "annex", ["toby-flenderson", "holly-flax"])
seat = desk("right-rear", 96.6, 21.6, props=("ticker-terminal",))
spot("desk-gabe", seat[0], seat[1], "desk", "front-right", "annex", ["gabe-lewis"])
filing(99.4, 17.6, base=True)
filing(99.4, 18.5, base=True)
add(Obj("todo", lambda p: p.sprite("culture/todo-board.png", 99.9, 10.2, 58, h=1.35),
        (99.8, 10), (99.5, 8.5, 100, 11.8, 3.4), block=[], base=True, shadow=False))
add(Obj("ac", lambda p: p.sprite("decoration/ac-wall-unit.png", 99.95, 31.4, 54, h=3.0),
        (99.8, 31), (99.4, 30, 100, 32.8, 4.2), block=[], base=True, shadow=False))
round_table(90.4, 27.4, r=0.95)
for (du, dv, back) in [(-1.3, 0, "w"), (0, 1.3, "s"), (1.3, 0, "e")]:
    chair(90.4 + du, 27.4 + dv, back, (120, 90, 150), name="annex-chair")
spot("float-annex", 89.1, 27.4, "lounge", "rear-right", "annex")
plant("monstera", 81.0, 32.9)
plant("money", 91.4, 1.0, base=True)
add(Obj("printer-annex", lambda p: p.sprite("decoration/printer.png", 99.3, 25.4, 52, dy=4),
        (99.3, 25.4), (98.7, 24.8, 99.9, 26.0, 2.4), base=True))

# ---- The Bullpen ------------------------------------------------------------
label("bullpen", "The Bullpen", "Sales & Trading floor", 37.5, 23.0)
seat = desk("left-rear", 29.6, 16.6, props=("bear-market", "jello-stapler"))
spot("desk-dwight", seat[0], seat[1], "desk", "front-left", "bullpen", ["dwight-schrute"])
seat = desk("left-front", 29.6, 17.85, props=("trade-ticket",))
spot("spot-2", seat[0], seat[1], "desk", "rear-left", "bullpen", ["jim-halpert"])
seat = desk("left-rear", 37.4, 16.6, props=("bond-certificate",))
spot("desk-stanley", seat[0], seat[1], "desk", "front-left", "bullpen", ["stanley-hudson"])
seat = desk("left-front", 37.4, 17.85)
spot("desk-phyllis", seat[0], seat[1], "desk", "rear-left", "bullpen", ["phyllis-vance"])
seat = desk("left-rear", 44.6, 16.6)
spot("desk-nellie", seat[0], seat[1], "desk", "front-left", "bullpen", ["nellie-bertram"])
seat = desk("left-front", 44.6, 17.85, props=("schrute-buck",))
spot("desk-andy", seat[0], seat[1], "desk", "rear-left", "bullpen", ["andy-bernard", "karen-filippelli"])
seat = desk("left-rear", 40.0, 26.2)
spot("desk-meredith", seat[0], seat[1], "desk", "front-left", "bullpen", ["meredith-palmer"])
seat = desk("left-front", 40.0, 27.45)
spot("desk-spare-1", seat[0], seat[1], "desk", "rear-left", "bullpen", [])
seat = desk("left-rear", 48.0, 26.2, props=("gold-bar",))
spot("desk-creed", seat[0], seat[1], "desk", "front-left", "bullpen", ["creed-bratton"])
seat = desk("left-front", 48.0, 27.45)
spot("desk-spare-2", seat[0], seat[1], "desk", "rear-left", "bullpen", [])
for (u, v) in [(32.6, 18.3), (40.4, 18.3), (47.6, 18.3)]:
    trash(u, v)
plant("snake", 35.2, 12.9)
plant("monstera", 61.0, 12.9)
plant("money", 61.0, 32.8)
plant("monstera", 35.2, 32.8)
plant("snake", 17.0, 26.9)
for i in range(3):
    filing(61.45, 23.4 + i * 0.86)

# ---- Accounting -------------------------------------------------------------
label("accounting", "Accounting", "Research & Fund Accounting", 21.5, 40.4)
seat = desk("left-rear", 26.0, 31.0, props=("calculator-keleven",))
spot("desk-kevin", seat[0], seat[1], "desk", "front-left", "accounting", ["kevin-malone"])
seat = desk("left-front", 19.0, 35.6, props=("compliance-stamp",))
spot("desk-angela", seat[0], seat[1], "desk", "rear-left", "accounting", ["angela-martin"])
seat = desk("left-front", 25.0, 36.6, props=("bond-certificate",))
spot("desk-oscar", seat[0], seat[1], "desk", "rear-left", "accounting", ["oscar-martinez"])
for i in range(4):
    filing(33.35, 37.2 + i * 0.86)
plant("money", 17.0, 40.9)
plant("snake", 33.2, 41.1)

# ---------------------------------------------------------------------------
# Rooms (for "who's in the room with Michael") — first match wins
# ---------------------------------------------------------------------------
ROOM_AREAS = [
    ("michael", [(24, 0, 36, 12)]), ("conference", [(36, 0, 50, 12)]), ("supply", [(50, 0, 55, 8)]),
    ("stairs", [(55, 0, 62, 12)]), ("break", [(62, 0, 80, 12)]), ("kitchen", [(62, 15, 80, 27)]),
    ("restroom-men", [(66, 27, 73, 37)]), ("restroom-women", [(73, 27, 80, 37)]), ("ryan", [(92, 0, 100, 7)]),
    ("annex", [(80, 0, 100, 34)]), ("accounting", [(16, 28, 34, 42)]), ("elevators", [(0, 6, 16, 14)]),
    # the open floor: waiting area, reception, bullpen, copy alcove, the hall to the annex
    ("bullpen", [(16, 0, 24, 12), (16, 12, 66, 34), (50, 8, 55, 12), (62, 12, 80, 15)]),
]

# ---------------------------------------------------------------------------
# Back walls (drawn into the base layer)
# ---------------------------------------------------------------------------
WINDOWS_N = [(17.4, 20.8), (27.8, 31.0), (46.5, 49.0), (57.2, 59.8), (68.0, 70.0), (74.6, 77.6), (85.0, 88.4)]
WINDOWS_E = [(2.4, 5.0), (18.6, 21.4), (24.6, 27.4)]


def window_view(w, h, night, seed):
    rnd = random.Random(seed)
    im = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(im)
    top, bot = ((22, 30, 62), (46, 56, 92)) if night else ((132, 190, 232), (206, 230, 244))
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)) + (255,))
    x = -rnd.randint(0, 20)
    while x < w:
        bw = rnd.randint(int(w * 0.25), int(w * 0.5))
        bh = rnd.randint(int(h * 0.3), int(h * 0.7))
        col = rnd.choice([(156, 84, 64), (138, 96, 76), (120, 124, 134), (170, 110, 80)])
        if night:
            col = mul(col, 0.4)[:3]
        d.rectangle([x, h - bh, x + bw, h], fill=col + (255,), outline=(60, 40, 40, 255), width=2)
        for wy in range(h - bh + 8, h - 8, 16):
            for wx in range(x + 6, x + bw - 8, 14):
                lit = night and rnd.random() < 0.35
                d.rectangle([wx, wy, wx + 7, wy + 8], fill=(250, 220, 130, 255) if lit else ((60, 70, 90, 255) if night else (190, 214, 230, 255)))
        x += bw + rnd.randint(2, 10)
    # a Scranton tree
    tx = rnd.randint(int(w * 0.2), int(w * 0.8))
    d.ellipse([tx - 18, h - 52, tx + 18, h - 14], fill=(60, 120, 60, 255) if not night else (24, 44, 30, 255))
    d.rectangle([tx - 3, h - 16, tx + 3, h], fill=(90, 60, 40, 255))
    return im


def draw_back_walls(p, night):
    # north wall (v = 0, u 16..100), elevator hall north wall (v = 6, u 0..16), east wall (u = 100)
    p.box(15.75, -0.3, 100.3, 0, 0, H_BACK, CREAM, top=rgba(CAP), faces="ws")
    p.box(15.75, -0.3, 100.3, 0, H_BACK, H_BACK + 0.05, CAP, faces="t")
    p.box(-0.3, 5.7, 16.0, 6.0, 0, H_BACK, CREAM, top=rgba(CAP))
    p.box(100.0, -0.3, 100.3, 34.0, 0, H_BACK, CREAM, top=rgba(CAP), faces="st")
    # the east wall's visible face is its west side — draw it as a lit-ish face
    p.poly([(100.0, -0.0, 0), (100.0, 34.0, 0), (100.0, 34.0, H_BACK), (100.0, -0.0, H_BACK)], mul(rgba(CREAM), 0.9))
    # baseboards
    for (a, b) in [(16, 100)]:
        p.poly([(a, 0.01, 0), (b, 0.01, 0), (b, 0.01, 0.18), (a, 0.01, 0.18)], rgba(BASEB), lw=2)
    p.poly([(0, 6.01, 0), (16, 6.01, 0), (16, 6.01, 0.18), (0, 6.01, 0.18)], rgba(BASEB), lw=2)
    p.poly([(99.99, 0, 0), (99.99, 34, 0), (99.99, 34, 0.18), (99.99, 0, 0.18)], mul(rgba(BASEB), 0.85), lw=2)
    # a soft darker band near the ceiling line, like the original room
    p.poly([(16, 0.01, H_BACK - 0.25), (100, 0.01, H_BACK - 0.25), (100, 0.01, H_BACK), (16, 0.01, H_BACK)], (0, 0, 0, 18), outline=None)
    # windows
    for i, (a, b) in enumerate(WINDOWS_N):
        h0, h1 = 1.55, 3.75
        p.box(a - 0.12, 0, b + 0.12, 0.22, h0 - 0.12, h0, (238, 238, 232), lw=2)  # sill
        p.face_n(window_view(int((b - a) * 40), int((h1 - h0) * 40), night, i), a, b, h0, h1, v=0.02)
        p.poly([(a, 0.02, h0), (b, 0.02, h0), (b, 0.02, h1), (a, 0.02, h1)], None, outline=rgba((230, 230, 226)), lw=6)
        m = (a + b) / 2
        p.line([(m, 0.02, h0), (m, 0.02, h1)], fill=rgba((230, 230, 226)), lw=5)
        p.line([(a, 0.02, (h0 + h1) / 2), (b, 0.02, (h0 + h1) / 2)], fill=rgba((230, 230, 226)), lw=4)
        for k in range(7):  # blinds pulled half way
            hh = h1 - 0.1 - k * 0.12
            p.line([(a + 0.05, 0.03, hh), (b - 0.05, 0.03, hh)], fill=(246, 246, 240, 230), lw=4)
    for i, (a, b) in enumerate(WINDOWS_E):
        h0, h1 = 1.55, 3.75
        p.face_w(window_view(int((b - a) * 40), int((h1 - h0) * 40), night, 20 + i), a, b, h0, h1, u=99.98)
        p.poly([(99.98, a, h0), (99.98, b, h0), (99.98, b, h1), (99.98, a, h1)], None, outline=rgba((230, 230, 226)), lw=6)
        m = (a + b) / 2
        p.line([(99.98, m, h0), (99.98, m, h1)], fill=rgba((230, 230, 226)), lw=5)
        for k in range(7):
            hh = h1 - 0.1 - k * 0.12
            p.line([(99.97, a + 0.05, hh), (99.97, b - 0.05, hh)], fill=(246, 246, 240, 230), lw=4)
    # elevators
    for (a, b) in [(2.0, 4.6), (6.0, 8.6)]:
        p.poly([(a - 0.15, 6.01, 0), (b + 0.15, 6.01, 0), (b + 0.15, 6.01, 3.45), (a - 0.15, 6.01, 3.45)], rgba((120, 126, 136)), lw=3)
        p.poly([(a, 6.02, 0), (b, 6.02, 0), (b, 6.02, 3.3), (a, 6.02, 3.3)], rgba((184, 190, 200)), lw=3)
        m = (a + b) / 2
        p.line([(m, 6.03, 0), (m, 6.03, 3.3)], fill=OUT, lw=3)
        p.poly([(m - 0.4, 6.03, 3.5), (m + 0.4, 6.03, 3.5), (m + 0.4, 6.03, 3.8), (m - 0.4, 6.03, 3.8)], rgba((30, 30, 36)), lw=2)
        p.line([(m - 0.15, 6.04, 3.65), (m + 0.15, 6.04, 3.65)], fill=(240, 160, 60, 255), lw=4)
    p.poly([(5.05, 6.02, 1.4), (5.55, 6.02, 1.4), (5.55, 6.02, 2.0), (5.05, 6.02, 2.0)], rgba((150, 156, 166)), lw=2)
    p.disc(5.3, 6.05, 0.08, 1.85, (250, 250, 250, 255))
    p.disc(5.3, 6.05, 0.08, 1.58, (250, 250, 250, 255))
    p.face_n(L.sprite("office/props/dunder-mifflin-capital-logo.png"), 10.0, 14.6, 1.6, 3.6, v=6.02)
    p.box(15.2, 6.0, 15.5, 6.25, 0.9, 1.6, (200, 40, 40))   # fire extinguisher
    # posters / boards / clock on the north wall
    p.face_n(framed("dunder-mifflin-logo"), 21.5, 23.7, 2.0, 3.4, v=0.02)
    p.face_n(Image.new("RGBA", (10, 10), (24, 26, 32, 255)), 41.4, 45.8, 1.55, 3.65, v=0.02)   # TV frame
    p.face_n(L.sprite("office/props/candlestick-chart.png"), 41.6, 45.6, 1.7, 3.5, v=0.03)
    p.face_n(framed("no-god-please-no", 8), 33.4, 34.6, 2.1, 2.9, v=0.02)
    p.face_n(sign_img("▼ WAREHOUSE", 12, (20, 20, 20), (240, 200, 60)), 56.9, 60.1, 3.85, 4.3, v=0.02)
    p.face_n(sign_img("DUNDER MIFFLIN CAPITAL · SCRANTON", 12), 82.2, 90.6, 3.85, 4.3, v=0.02)
    p.face_n(framed("pretzel-day", 8), 89.4, 91.2, 1.9, 3.2, v=0.02)
    # wall clocks
    for (u, v_, face) in [(52.6, 0.03, "n"), (99.97, 15.0, "e")]:
        clk = Image.new("RGBA", (80, 80))
        cd = ImageDraw.Draw(clk)
        cd.ellipse([2, 2, 78, 78], fill=(250, 250, 246, 255), outline=(30, 30, 36, 255), width=6)
        cd.line([(40, 40), (40, 16)], fill=(30, 30, 36, 255), width=5)
        cd.line([(40, 40), (58, 46)], fill=(30, 30, 36, 255), width=5)
        if face == "n":
            p.face_n(clk, u - 0.4, u + 0.4, 3.3, 4.05, v=v_)
        else:
            p.face_w(clk, v_ - 0.4, v_ + 0.4, 3.3, 4.05, u=u)
    p.face_w(framed("schrute-buck", 8), 12.4, 14.6, 2.0, 3.0, u=99.97)


# ---------------------------------------------------------------------------
# Floors
# ---------------------------------------------------------------------------
FLOORS = [  # (rect, material)
    ((0, 6, 16, 14), ("carpet", "hall")),
    ((16, 0, 66, 34), ("carpet", "bullpen")),
    ((16, 0, 24, 12), ("carpet", "waiting")),
    ((16, 34, 34, 42), ("carpet", "accounting")),
    ((16, 28, 34, 34), ("carpet", "accounting")),
    ((66, 0, 100, 34), ("carpet", "annex")),
    ((24, 0, 36, 12), ("carpet", "michael")),
    ((36, 0, 50, 12), ("carpet", "conference")),
    ((50, 0, 55, 8), ("tiles", SUPPLY)),
    ((55, 0, 62, 12), ("plain", STAIR_CARPET)),
    ((62, 0, 80, 12), ("tiles", LINO)),
    ((62, 12, 80, 15), ("carpet", "hall")),
    ((62, 15, 80, 27), ("tiles", LINO)),
    ((66, 27, 80, 37), ("tiles", TILE)),
    ((92, 0, 100, 7), ("carpet", "ryan")),
]


def draw_floors(p, mask_d):
    for (u0, v0, u1, v1), (kind, val) in FLOORS:
        quad = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        if kind == "carpet":
            p.poly(quad, rgba(CARPET[val]), outline=None)
            mask_d.polygon([p.p(*q) for q in quad], fill=255)
        elif kind == "plain":
            p.poly(quad, rgba(val), outline=None)
            mask_d.polygon([p.p(*q) for q in quad], fill=160)
        else:
            a, b = val
            for u in range(int(u0), int(math.ceil(u1))):
                for v in range(int(v0), int(math.ceil(v1))):
                    uu0, vv0, uu1, vv1 = max(u, u0), max(v, v0), min(u + 1, u1), min(v + 1, v1)
                    p.poly([(uu0, vv0), (uu1, vv0), (uu1, vv1), (uu0, vv1)], rgba(a if (u + v) % 2 else b), outline=None)
            for u in range(int(math.ceil(u0)), int(u1) + 1):
                p.line([(u, v0), (u, v1)], fill=(0, 0, 0, 22), lw=2)
            for v in range(int(math.ceil(v0)), int(v1) + 1):
                p.line([(u0, v), (u1, v)], fill=(0, 0, 0, 22), lw=2)
    # carpet seams every 4 tiles, very faint (the original floor has broad panels)
    for (u0, v0, u1, v1), (kind, val) in FLOORS:
        if kind != "carpet":
            continue
        for u in range(int(math.ceil(u0 / 4) * 4), int(u1), 4):
            p.line([(u, v0), (u, v1)], fill=(0, 0, 0, 14), lw=2)
        for v in range(int(math.ceil(v0 / 4) * 4), int(v1), 4):
            p.line([(u0, v), (u1, v)], fill=(0, 0, 0, 14), lw=2)


def draw_slab(p):
    n = len(OUTLINE)
    for i in range(n):
        (u0, v0), (u1, v1) = OUTLINE[i], OUTLINE[(i + 1) % n]
        if v0 == v1 and u1 < u0:  # south-facing edge (interior to the north)
            p.poly([(u1, v0, 0), (u0, v0, 0), (u0, v0, -0.55), (u1, v0, -0.55)], mul(rgba(SLAB), 1.05))
        elif u0 == u1 and v1 < v0:  # west-facing edge
            p.poly([(u0, v1, 0), (u0, v0, 0), (u0, v0, -0.55), (u0, v1, -0.55)], mul(rgba(SLAB), 0.82))
    p.poly([(u, v, 0) for (u, v) in OUTLINE], None, outline=OUT, lw=LWB)


LWB = 4


def draw_stairwell(base, night):
    """Sunken stairs, visible only through the opening in the floor."""
    u0, v0, u1, v1 = WELL
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    q = L.Painter(layer)
    depth = 3.4
    q.box(u0, v0 - 0.4, u1, v1, -depth, 0, (40, 30, 34), faces="t")
    # far walls of the well
    q.poly([(u0, v0, -depth), (u1, v0, -depth), (u1, v0, 0), (u0, v0, 0)], rgba((150, 140, 124)))
    q.poly([(u1, v0, -depth), (u1, v1, -depth), (u1, v1, 0), (u1, v0, 0)], rgba((132, 122, 108)))
    steps = 10
    sd = (v1 - v0) / steps
    for k in range(steps - 1, -1, -1):   # deepest (north) first
        vs, ve = v1 - (k + 1) * sd, v1 - k * sd
        hh = -(k + 1) * depth / steps
        col = STAIR_CARPET if k % 2 == 0 else mul(rgba(STAIR_CARPET), 0.92)[:3]
        q.box(u0, vs, u1, ve, hh - 0.6, hh, col)
        q.line([(u0, ve - 0.08, hh + 0.001), (u1, ve - 0.08, hh + 0.001)], fill=(210, 190, 120, 200), lw=3)
    mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(mask).polygon([q.p(u, v) for (u, v) in [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]], fill=255)
    base.alpha_composite(Image.composite(layer, Image.new("RGBA", base.size, (0, 0, 0, 0)), mask))
    bp = L.Painter(base)
    bp.poly([(u0, v1, 0), (u1, v1, 0), (u1, v1, -0.12), (u0, v1, -0.12)], rgba((210, 190, 120)), lw=2)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def depth_of(u, v):
    return v - u


def render_obj_image(draw, box, pad=60):
    u0, v0, u1, v1, hm = box
    pts = [P(u, v, h) for u in (u0, u1) for v in (v0, v1) for h in (-0.6, hm)]
    x0 = math.floor(min(x for x, _ in pts) - pad)
    y0 = math.floor(min(y for _, y in pts) - pad)
    x1 = math.ceil(max(x for x, _ in pts) + pad)
    y1 = math.ceil(max(y for _, y in pts) + pad)
    canvas = Image.new("RGBA", ((x1 - x0) * SS, (y1 - y0) * SS), (0, 0, 0, 0))
    draw(L.Painter(canvas, x0, y0))
    small = canvas.resize((x1 - x0, y1 - y0), Image.LANCZOS)
    bb = small.getbbox()
    if not bb:
        return None
    return small.crop(bb), x0 + bb[0], y0 + bb[1]


def zfor(u, v, bias=0.0):
    _, y = P(u, v, 0)
    return 1000 + int(round((y / IH * 100 + bias) * 50))


def night_tint(im, k=(0.5, 0.55, 0.78)):
    arr = np.asarray(im).astype(np.float32)
    arr[..., 0] *= k[0]
    arr[..., 1] *= k[1]
    arr[..., 2] *= k[2]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")


def build_base(night):
    big = Image.new("RGBA", (IW * SS, IH * SS), rgba(NAVY))
    p = L.Painter(big)
    # soft glow behind the building
    glow = Image.new("L", (IW // 8, IH // 8), 0)
    gd = ImageDraw.Draw(glow)
    gd.polygon([((x / 8), (y / 8)) for (x, y) in [P(u, v) for (u, v) in OUTLINE]], fill=60)
    glow = glow.filter(ImageFilter.GaussianBlur(14)).resize(big.size, Image.BILINEAR)
    big.alpha_composite(Image.composite(Image.new("RGBA", big.size, (90, 100, 140, 255)), Image.new("RGBA", big.size, (0, 0, 0, 0)), glow))
    draw_slab(p)
    mask = Image.new("L", big.size, 0)
    draw_floors(p, ImageDraw.Draw(mask))
    # carpet texture: fine noise + speckles inside the carpet mask
    rng = np.random.default_rng(3)
    noise = rng.normal(0, 7, (big.size[1] // 2, big.size[0] // 2)).astype(np.float32)
    noise = np.asarray(Image.fromarray(np.clip(noise + 128, 0, 255).astype(np.uint8)).resize(big.size, Image.BILINEAR)).astype(np.float32) - 128
    m = np.asarray(mask).astype(np.float32) / 255
    arr = np.asarray(big).astype(np.float32)
    for c in range(3):
        arr[..., c] += noise * m
    speck = (rng.random((big.size[1], big.size[0])) < 0.0016) * m
    for c, val in zip(range(3), (-26, -24, -18)):
        arr[..., c] += speck * val
    big = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")
    p = L.Painter(big)
    draw_stairwell(big, night)
    # window light on the floor (day) / lamp pools (night)
    light = Image.new("RGBA", big.size, (0, 0, 0, 0))
    lp = L.Painter(light)
    if not night:
        for (a, b) in WINDOWS_N:
            lp.poly([(a + 0.6, 0.3), (b + 0.6, 0.3), (b + 2.4, 5.2), (a + 2.4, 5.2)], (255, 250, 230, 34), outline=None)
        for (a, b) in WINDOWS_E:
            lp.poly([(99.7, a + 0.6), (99.7, b + 0.6), (95.0, b + 2.2), (95.0, a + 2.2)], (255, 250, 230, 30), outline=None)
    else:
        for (u, v) in [(20, 6), (30, 6), (43, 6), (58, 10), (70, 6), (71, 21), (88, 10), (90, 26), (26, 18), (40, 22),
                       (50, 30), (26, 36), (8, 10), (96, 4), (60, 32), (73, 32)]:
            lp.disc(u, v, 3.6, 0.0, (255, 214, 140, 44))
    light = light.filter(ImageFilter.GaussianBlur(6 * SS))
    big.alpha_composite(light)
    # floor shadows of all furniture
    shadows = Image.new("RGBA", big.size, (0, 0, 0, 0))
    sp = L.Painter(shadows)
    for o in OBJS:
        if not o.shadow:
            continue
        for (a, b, c, d) in o.block:
            sp.poly([(a + 0.15, b + 0.25), (c + 0.35, b + 0.25), (c + 0.35, d + 0.35), (a + 0.15, d + 0.35)], (10, 12, 28, 60), outline=None)
    shadows = shadows.filter(ImageFilter.GaussianBlur(3 * SS))
    big.alpha_composite(shadows)
    p = L.Painter(big)
    draw_back_walls(p, night)
    for o in sorted([o for o in OBJS if o.base], key=lambda o: depth_of(*o.ref)):
        o.draw(p)
    out = big.resize((IW, IH), Image.LANCZOS)
    if night:
        out = night_tint(out, (0.62, 0.66, 0.86))
    return out


def build_sprites():
    """Every non-base object and every wall slice → (image, left, top, z)."""
    items = []
    for o in OBJS:
        if o.base:
            continue
        r = render_obj_image(o.draw, o.box)
        if r is None:
            continue
        im, x, y = r
        items.append(dict(img=im, x=x, y=y, z=zfor(*o.ref, o.zbias), name=o.name))
    for i, (axis, c, a, b, kind) in enumerate(RUNS):
        deco = DECO.get(i, [])
        h = wall_heights(kind) + 0.4
        box = (a, c - 0.3, b, c + 0.3, h) if axis == "u" else (c - 0.3, a, c + 0.3, b, h)
        r = render_obj_image(lambda p: draw_run(p, axis, c, a, b, kind, deco), box, pad=30)
        if r is None:
            continue
        im, x, y = r
        # slice into 1-tile columns: along either axis, screen x = OX + (t + c) * TW/2
        ts = [a]
        t = math.floor(a) + 1
        while t < b - 0.3:
            ts.append(t)
            t += 1
        ts.append(b)
        for k in range(len(ts) - 1):
            ta, tb = ts[k], ts[k + 1]
            xa = (OXv + (ta + c) * TW / 2) - x if k > 0 else 0
            xb = (OXv + (tb + c) * TW / 2) - x if k < len(ts) - 2 else im.width
            xa, xb = int(round(max(0, xa))), int(round(min(im.width, xb)))
            if xb - xa < 1:
                continue
            piece = im.crop((xa, 0, xb, im.height))
            bb = piece.getbbox()
            if not bb:
                continue
            piece = piece.crop(bb)
            tm = (ta + tb) / 2
            ru, rv = (tm, c) if axis == "u" else (c, tm)
            items.append(dict(img=piece, x=x + xa + bb[0], y=y + bb[1], z=zfor(ru, rv), name=f"wall-{kind}"))
    return items


def pack(items, width=2048, pad=2):
    items.sort(key=lambda it: -it["img"].height)
    x = y = row_h = 0
    for it in items:
        w, h = it["img"].size
        if x + w + pad > width:
            x, y = 0, y + row_h + pad
            row_h = 0
        it["ax"], it["ay"] = x, y
        x += w + pad
        row_h = max(row_h, h)
    H = y + row_h + pad
    atlas = Image.new("RGBA", (width, H), (0, 0, 0, 0))
    for it in items:
        atlas.alpha_composite(it["img"], (it["ax"], it["ay"]))
    return atlas


# ---------------------------------------------------------------------------
# Walk grid
# ---------------------------------------------------------------------------
CELL = 0.5
COLS, ROWS = int(100 / CELL), int(48 / CELL)


def build_grid():
    g = np.zeros((ROWS, COLS), dtype=np.uint8)

    def cells(u0, v0, u1, v1):
        c0, c1 = max(0, int(math.floor(u0 / CELL))), min(COLS, int(math.ceil(u1 / CELL)))
        r0, r1 = max(0, int(math.floor(v0 / CELL))), min(ROWS, int(math.ceil(v1 / CELL)))
        return r0, r1, c0, c1

    def fill(rect, val, inflate=0.0, center=True):
        u0, v0, u1, v1 = rect
        u0, v0, u1, v1 = u0 - inflate, v0 - inflate, u1 + inflate, v1 + inflate
        for r in range(ROWS):
            vc = (r + 0.5) * CELL
            if not (v0 <= vc <= v1):
                continue
            for c in range(COLS):
                uc = (c + 0.5) * CELL
                if u0 <= uc <= u1:
                    g[r, c] = val
    for rect in FLOOR_RECTS:
        fill(rect, 1)
    # back walls (drawn in the base layer, not in RUNS)
    for rect in [(16, 0, 100, 0), (0, 6, 16, 6), (100, 0, 100, 34)]:
        fill(rect, 0, 0.45)
    for (axis, c, a, b, kind) in RUNS:
        rect = (a, c, b, c) if axis == "u" else (c, a, c, b)
        fill(rect, 0, 0.42)
    for o in OBJS:
        for rect in o.block:
            fill(rect, 0, 0.22)
    fill(WELL, 0, 0.2)
    for (axis, c, a, b) in DOOR_GAPS:
        rect = (a + 0.2, c - 0.5, b - 0.2, c + 0.5) if axis == "u" else (c - 0.5, a + 0.2, c + 0.5, b - 0.2)
        fill(rect, 1)
    for s in SPOTS.values():
        fill((s["u"] - 0.2, s["v"] - 0.2, s["u"] + 0.2, s["v"] + 0.2), 1)
    return g


def main():
    preview = "--preview" in sys.argv
    print(f"canvas {IW}x{IH}")
    items = build_sprites()
    print(f"{len(items)} sprites")
    atlas = pack(items)
    base_day = build_base(False)
    base_night = build_base(True)
    rooms = ROOT / "public" / "rooms"
    base_day.convert("RGB").save(rooms / "scranton-iso-day.png", optimize=True)
    base_night.convert("RGB").save(rooms / "scranton-iso-night.png", optimize=True)
    atlas.save(rooms / "scranton-iso-atlas-day.png", optimize=True)
    night_tint(atlas, (0.66, 0.7, 0.88)).save(rooms / "scranton-iso-atlas-night.png", optimize=True)

    comp = base_day.copy()
    for it in sorted(items, key=lambda it: it["z"]):
        comp.alpha_composite(it["img"], (it["x"], it["y"]))
    mini = comp.convert("RGB")
    mini.thumbnail((520, 520), Image.LANCZOS)
    mini.save(rooms / "scranton-iso-mini.png", optimize=True)
    if preview:
        comp.convert("RGB").save(ROOT / "docs" / "reference" / "scranton-iso-preview.png", optimize=True)
        comp.convert("RGB").save("/tmp/claude-0/iso/preview.png")

    grid = build_grid()
    # --- spots & JSON (same schema the app already understands, plus iso/grid/atlas) ---
    spots = []
    for sid, s in SPOTS.items():
        x, y = pct(s["u"], s["v"])
        spots.append(dict(id=sid, type=s["type"], x=x, y=y, spriteFacing=s["facing"], room=s["room"], u=s["u"], v=s["v"], sit=s["sit"]))
    seats = {}
    for sid, owners in DESK_OWNERS.items():
        for o in owners:
            seats[o] = sid
    ex, ey = pct(SPOTS["door"]["u"], SPOTS["door"]["v"])
    float_spots = [k for k in SPOTS if k.startswith("float-")]
    furniture = []
    for it in items:
        w, h = it["img"].size
        furniture.append(dict(left=round(it["x"] / IW * 100, 4), top=round(it["y"] / IH * 100, 4),
                              width=round(w / IW * 100, 4), height=round(h / IH * 100, 4),
                              z=it["z"], ax=it["ax"], ay=it["ay"], aw=w, ah=h))
    labels = []
    for lb in LABELS:
        x, y = pct(lb["u"], lb["v"])
        labels.append(dict(id=lb["id"], name=lb["name"], sub=lb["sub"], x=x, y=y))

    def tgt(sid):
        s = SPOTS[sid]
        x, y = pct(s["u"], s["v"])
        return dict(x=x, y=y)
    data = dict(
        generatedBy="scripts/build-scranton-iso.py",
        style="iso",
        size=dict(width=IW, height=IH),
        spriteScale=round(84 / IW, 5),
        background=dict(day="/rooms/scranton-iso-day.png", night="/rooms/scranton-iso-night.png"),
        atlas=dict(day="/rooms/scranton-iso-atlas-day.png", night="/rooms/scranton-iso-atlas-night.png",
                   width=atlas.width, height=atlas.height),
        minimap="/rooms/scranton-iso-mini.png",
        iso=dict(ox=OXv, oy=OYv, tw=TW, th=TH, personBias=round(0.4 * TH / 2 / IH * 100, 4)),
        grid=dict(cell=CELL, cols=COLS, rows=ROWS, data="".join("".join(str(int(x)) for x in row) for row in grid)),
        entryPoint=dict(x=ex, y=ey),
        spots=spots,
        seats=seats,
        deskOwners=DESK_OWNERS,
        floaters=["david-wallace", "jan-levinson", "robert-california", "bob-vance", "carol-stills"],
        floatSpots=float_spots,
        meetingSeats=MEET_SEATS,
        meetingStanding=MEET_STAND,
        eventTargets={
            "pretzel-day": tgt("float-kitchen-1"), "pizza": tgt("float-kitchen-2"), "birthday": tgt("float-break-2"),
            "fire-alarm-stress-relief": tgt("door"), "fire-drill": tgt("door"), "printer-jam-dm": tgt("copier"),
            "printer-jam": tgt("copier"), "standup": tgt("meet-front"), "parkour": tgt("float-waiting-couch"),
        },
        labels=labels,
        rooms=[dict(id=rid, rects=[list(r) for r in rects]) for rid, rects in ROOM_AREAS],
        furniture=furniture,
        waypoints=[],
    )
    with open(ROOT / "firm" / "scranton-floor.json", "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    # debug view of the grid
    gimg = comp.copy()
    gp = L.Painter(gimg)
    gp.ox = gp.oy = 0
    d = ImageDraw.Draw(gimg, "RGBA")
    for r in range(ROWS):
        for c in range(COLS):
            if not grid[r, c]:
                continue
            u, v = c * CELL, r * CELL
            q = [P(u, v), P(u + CELL, v), P(u + CELL, v + CELL), P(u, v + CELL)]
            d.polygon(q, fill=(60, 220, 120, 60))
    for s in SPOTS.values():
        x, y = P(s["u"], s["v"])
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(240, 40, 40, 255))
    gimg.convert("RGB").save("/tmp/claude-0/iso/grid.png")
    print("ok", len(furniture), "objects;", len(spots), "spots;", f"atlas {atlas.width}x{atlas.height}")


if __name__ == "__main__":
    main()
