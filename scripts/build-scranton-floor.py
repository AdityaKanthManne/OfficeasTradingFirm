#!/usr/bin/env python3
"""
build-scranton-floor.py — turns the Dunder Mifflin Scranton floor-plan render
(docs/reference/dunder-mifflin-floor-plan.png) into the office map.

Layers (bottom → top):
  1. base     public/rooms/scranton-floor-day.png / -night.png  (the render redrawn as pixel art)
  2. labels   room names (HTML overlay, from this file)
  3. avatars  always on top of everything

Everything positional — seats, meeting chairs, hangout spots, walking routes —
is authored below in the source image's own pixel coordinates (1080×659) and
exported as percentages to firm/scranton-floor.json.

    python3 scripts/build-scranton-floor.py
    python3 scripts/build-scranton-floor.py --debug   # also writes a debug overlay PNG
    python3 scripts/build-scranton-floor.py --photo   # use the original render instead of pixel art
"""

import json
import math
import os
import sys
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "reference", "dunder-mifflin-floor-plan.png")
OUT_BG = os.path.join(ROOT, "public", "rooms")
# The live map is now built by build-scranton-iso.py; this older photo/pixel version writes alongside it.
OUT_JSON = os.path.join(ROOT, "firm", "scranton-floor-flat.json")

CROP = (16, 0, 1078, 659)     # trims a grey bar on the left edge of the render
UPSCALE = 2
PIXEL = 3                     # one art pixel = 3×3 source pixels
PALETTE = 32                  # colours in the pixel-art palette
ART_SCALE = 6                 # art pixels → screen pixels in the saved PNG (crisp nearest-neighbour)
SPRITE_SCALE = 0.044          # avatar height as a fraction of the map width

# ---------------------------------------------------------------------------
# Seats — (x, y) in source px, plus the point the person looks at (their desk)
# ---------------------------------------------------------------------------
SEATS = {
    # id                 seat         look-at       owners (Office character slugs)
    "spot-1":          ((352, 213), (352, 236), ["michael-scott"]),            # Michael's office
    "desk-pam":        ((336, 374), (335, 352), ["pam-beesly", "erin-hannon"]),  # curved reception desk
    "desk-dwight":     ((406, 306), (416, 324), ["dwight-schrute"]),           # paired desks by reception
    "spot-2":          ((468, 344), (450, 344), ["jim-halpert"]),
    "desk-phyllis":    ((504, 317), (522, 300), ["phyllis-vance"]),            # Phyllis faces Stanley
    "desk-stanley":    ((565, 302), (545, 300), ["stanley-hudson"]),
    "desk-andy":       ((538, 425), (515, 428), ["andy-bernard", "karen-filippelli"]),
    "desk-nellie":     ((472, 448), (492, 430), ["nellie-bertram"]),
    "desk-meredith":   ((594, 406), (612, 390), ["meredith-palmer"]),
    "desk-creed":      ((296, 401), (279, 398), ["creed-bratton"]),            # by the wall near accounting
    "desk-kevin":      ((407, 458), (385, 461), ["kevin-malone"]),             # accounting corner
    "desk-angela":     ((382, 506), (372, 490), ["angela-martin"]),
    "desk-oscar":      ((343, 517), (340, 495), ["oscar-martinez"]),
    "desk-kelly":      ((826, 226), (838, 210), ["kelly-kapoor"]),             # the annex
    "desk-ryan":       ((930, 235), (942, 222), ["ryan-howard"]),
    "desk-toby":       ((955, 270), (952, 256), ["toby-flenderson", "holly-flax"]),
    "desk-gabe":       ((965, 304), (962, 292), ["gabe-lewis"]),
    "desk-annex-2":    ((850, 182), (850, 166), []),
    "desk-darryl":     ((662, 182), (650, 168), ["darryl-philbin"]),           # top of the warehouse stairs
    "desk-roy":        ((640, 196), (630, 182), ["roy-anderson"]),
}

# Hangout spots for desk-mates and visitors without a desk
FLOAT = {
    "float-waiting-couch":  ((262, 326), (290, 318), "waiting"),
    "float-waiting-chair":  ((318, 318), (300, 330), "waiting"),
    "float-mo-guest-1":     ((340, 253), (350, 232), "michael"),
    "float-mo-guest-2":     ((366, 253), (352, 232), "michael"),
    "float-kitchen-1":      ((708, 240), (722, 230), "kitchen"),
    "float-kitchen-2":      ((730, 250), (720, 240), "kitchen"),
    "float-break-1":        ((748, 110), (757, 100), "break"),
    "float-break-2":        ((768, 134), (777, 123), "break"),
    "float-break-3":        ((792, 154), (800, 142), "break"),
    "float-break-hall":     ((712, 122), (705, 110), "break"),
    "float-supply":         ((592, 206), (585, 190), "supply"),
}
SPOTS_MISC = {
    "coffee":      ((650, 234), (650, 218), "coffee", "kitchen"),
    "water-kitchen": ((690, 228), (690, 214), "water", "kitchen"),
    "water-break": ((818, 150), (818, 130), "water", "break"),
    "copier":      ((396, 426), (386, 410), "printer", "bullpen"),
    "spot-filing": ((585, 222), (585, 205), "filing", "supply"),
    "door":        ((75, 284), (75, 260), "door", "elevators"),
}

# Conference room: rows of chairs facing the front (west) wall, Michael up front
MEETING_FRONT = ((420, 200), (470, 196))
ROW_X = [447, 463, 479, 495, 511, 527]
ROW_Y = [177, 192, 207]
MEETING_STANDING = [(548, 226), (556, 196), (470, 228), (500, 230), (432, 226), (560, 172), (520, 232), (540, 166),
                    (414, 222), (424, 180), (566, 212), (452, 166), (486, 238), (530, 158)]

FLOATERS = ["david-wallace", "jan-levinson", "robert-california", "bob-vance", "carol-stills"]

# ---------------------------------------------------------------------------
# Walking routes: nodes on open floor, connected along corridors and doorways
# ---------------------------------------------------------------------------
NODES = {
    # elevator hall → office door
    "h-elev": (75, 284), "h-mid": (150, 287), "h-door": (236, 274),
    # waiting area / reception
    "w1": (265, 296), "w2": (285, 342), "w3": (302, 386), "p-app": (360, 386),
    # corridor below Michael's office + conference room
    "t1": (320, 286), "t2": (380, 284), "t3": (440, 272), "t4": (482, 266), "t5": (575, 270), "t6": (612, 286),
    # Michael's office
    "m-door": (400, 263), "m-in": (376, 256), "m-2": (388, 224),
    # conference room
    "c-door": (443, 256), "c-in": (447, 238), "c-front": (424, 216), "c-aisle": (500, 234), "c-back": (550, 214),
    # bullpen
    "b1": (376, 316), "b2": (392, 366), "b3": (442, 386), "b4": (486, 350), "b5": (578, 342),
    "b6": (522, 382), "b7": (572, 410), "b8": (442, 432), "b9": (422, 482), "b10": (424, 532),
    "b10b": (362, 536), "b11": (480, 500), "b13": (622, 352), "b14": (632, 302),
    # kitchen, stairs, supply closet
    "k-door": (655, 272), "k1": (672, 242), "k2": (742, 214), "k3": (726, 192), "st": (652, 202), "sp": (600, 236),
    # break room (vending machines)
    "br-hall": (716, 150), "br-door": (746, 132), "br1": (772, 120), "br2": (800, 160),
    # annex
    "an-door": (812, 196), "an1": (840, 230), "an2": (885, 205), "an3": (905, 245), "an4": (935, 285), "an5": (900, 300),
}
EDGES = [
    ("h-elev", "h-mid"), ("h-mid", "h-door"), ("h-door", "w1"), ("w1", "t1"), ("w1", "w2"), ("w2", "w3"), ("w3", "p-app"),
    ("t1", "t2"), ("t2", "t3"), ("t3", "t4"), ("t4", "t5"), ("t5", "t6"),
    ("t2", "m-door"), ("m-door", "m-in"), ("m-in", "m-2"),
    ("t3", "c-door"), ("c-door", "c-in"), ("c-in", "c-front"), ("c-in", "c-aisle"), ("c-aisle", "c-back"),
    ("t1", "b1"), ("t2", "b1"), ("b1", "b2"), ("w2", "b2"), ("p-app", "b2"), ("b2", "b3"), ("b3", "b4"), ("t4", "b4"),
    ("b4", "b6"), ("b4", "b5"), ("t5", "b5"), ("b5", "b13"), ("b5", "b7"), ("b6", "b7"), ("b3", "b8"), ("b6", "b8"),
    ("b8", "b9"), ("b9", "b10"), ("b10", "b10b"), ("b10", "b11"), ("b11", "b8"),
    ("b13", "b14"), ("t6", "b14"), ("b14", "k-door"), ("k-door", "k1"), ("k1", "k2"), ("k2", "k3"), ("k1", "st"),
    ("t6", "sp"), ("sp", "st"), ("k3", "br-hall"), ("br-hall", "br-door"), ("br-door", "br1"), ("br1", "br2"),
    ("k2", "an-door"), ("br2", "an-door"), ("an-door", "an1"), ("an-door", "an2"), ("an1", "an3"), ("an2", "an3"),
    ("an3", "an4"), ("an4", "an5"), ("an3", "an5"),
]
# Each seat/spot hooks onto its nearest route node(s)
HOOKS = {
    "spot-1": ["m-2"], "desk-pam": ["p-app"], "desk-dwight": ["b1", "t2"], "spot-2": ["b4", "b3"],
    "desk-phyllis": ["b4", "t4"], "desk-stanley": ["b5", "t5"], "desk-andy": ["b7"], "desk-nellie": ["b8", "b11"],
    "desk-meredith": ["b7"], "desk-creed": ["w3"], "desk-kevin": ["b8", "b9"], "desk-angela": ["b10b", "b10"],
    "desk-oscar": ["b10b"], "desk-kelly": ["an1"], "desk-ryan": ["an3"], "desk-toby": ["an4"], "desk-gabe": ["an5", "an4"],
    "desk-annex-2": ["an2"], "desk-darryl": ["st"], "desk-roy": ["st"],
    "float-waiting-couch": ["w1", "w2"], "float-waiting-chair": ["w1", "t1"], "float-mo-guest-1": ["m-in"], "float-mo-guest-2": ["m-in"],
    "float-kitchen-1": ["k1"], "float-kitchen-2": ["k2"], "float-break-1": ["br1"], "float-break-2": ["br1"], "float-break-3": ["br2"],
    "float-break-hall": ["br-hall"], "float-supply": ["sp"],
    "coffee": ["k1"], "water-kitchen": ["k1"], "water-break": ["br2"], "copier": ["b2", "b8"], "spot-filing": ["sp"], "door": ["h-elev"],
    "meet-front": ["c-front"],
}

LABELS = [
    ("elevators", "Elevators", "2nd floor lobby", (128, 258)),
    ("reception", "Reception", "Order intake", (300, 352)),
    ("michael", "Michael's Office", "Managing Partner", (340, 178)),
    ("conference", "Conference Room", "Meetings & desk huddles", (488, 156)),
    ("bullpen", "The Bullpen", "Sales & Trading floor", (520, 395)),
    ("accounting", "Accounting", "Research & Fund Accounting", (360, 548)),
    ("kitchen", "Kitchen", "", (680, 262)),
    ("break", "Break Room", "Vending machines", (790, 86)),
    ("annex", "The Annex", "Compliance · Intel · Digital Assets", (935, 172)),
    ("stairs", "Stairs to Warehouse", "Trade Ops (downstairs)", (652, 146)),
    ("supply", "Supply Closet", "", (588, 130)),
    ("restrooms", "Restrooms", "", (800, 372)),
]

ROOM_OF = {
    "spot-1": "michael", "desk-pam": "reception", "desk-kelly": "annex", "desk-ryan": "annex", "desk-toby": "annex",
    "desk-gabe": "annex", "desk-annex-2": "annex", "desk-darryl": "stairs", "desk-roy": "stairs",
    "desk-kevin": "accounting", "desk-angela": "accounting", "desk-oscar": "accounting",
}

# ---------------------------------------------------------------------------
W0, H0 = CROP[2] - CROP[0], CROP[3] - CROP[1]


def pct(p):
    x, y = p
    return round((x - CROP[0]) / W0 * 100, 3), round((y - CROP[1]) / H0 * 100, 3)


def facing(seat, look):
    dx, dy = look[0] - seat[0], look[1] - seat[1]
    if dy >= 0:
        return "front-right" if dx >= 0 else "front-left"
    return "rear-right" if dx >= 0 else "rear-left"


def pixel_art(base):
    """Redraw the render as pixel art: flatten carpet speckle, downsample to chunky pixels,
    reduce to a small palette (no dithering) and add 1px dark outlines on strong edges."""
    im = base.filter(ImageFilter.MedianFilter(3))
    im = ImageEnhance.Color(im).enhance(1.18)
    im = ImageEnhance.Contrast(im).enhance(1.08)
    small = im.resize((round(base.width / PIXEL), round(base.height / PIXEL)), Image.BOX)
    q = small.quantize(colors=PALETTE, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE, kmeans=2).convert("RGB")
    g = q.convert("L")
    edges = g.filter(ImageFilter.FIND_EDGES).point(lambda v: 255 if v > 90 else 0)
    mask = ImageChops.multiply(edges, g.point(lambda v: 255 if v < 150 else 0))
    return Image.composite(ImageEnhance.Brightness(q).enhance(0.7), q, mask)


def night_pixels(small):
    """Night palette for the pixel art: darker, bluer, same pixels."""
    n = ImageEnhance.Brightness(small).enhance(0.6)
    return Image.blend(n, Image.new("RGB", n.size, (18, 26, 64)), 0.2)


def main(debug=False, photo=False):
    if not os.path.exists(SRC):
        sys.exit(f"missing {SRC} — save the floor-plan render there first")
    base = Image.open(SRC).convert("RGB").crop(CROP)
    os.makedirs(OUT_BG, exist_ok=True)
    if photo:
        big = base.resize((W0 * UPSCALE, H0 * UPSCALE), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
        night = Image.blend(ImageEnhance.Brightness(big).enhance(0.62), Image.new("RGB", big.size, (20, 30, 70)), 0.18)
    else:
        small = pixel_art(base)
        size = (small.width * ART_SCALE, small.height * ART_SCALE)
        big = small.resize(size, Image.NEAREST)
        night = night_pixels(small).resize(size, Image.NEAREST)
    big.save(os.path.join(OUT_BG, "scranton-floor-day.png"), optimize=True)
    night.save(os.path.join(OUT_BG, "scranton-floor-night.png"), optimize=True)

    spots, seats, owners = [], {}, {}
    for sid, (seat, look, who) in SEATS.items():
        x, y = pct(seat)
        spots.append(dict(id=sid, type="desk", x=x, y=y, spriteFacing=facing(seat, look), room=ROOM_OF.get(sid, "bullpen")))
        owners[sid] = who
        for slug in who:
            seats[slug] = sid
    for sid, (seat, look, room) in FLOAT.items():
        x, y = pct(seat)
        spots.append(dict(id=sid, type="lounge", x=x, y=y, spriteFacing=facing(seat, look), room=room))
    for sid, (seat, look, stype, room) in SPOTS_MISC.items():
        x, y = pct(seat)
        spots.append(dict(id=sid, type=stype, x=x, y=y, spriteFacing=facing(seat, look), room=room))

    meeting_seats = ["meet-front"]
    fx, fy = pct(MEETING_FRONT[0])
    spots.append(dict(id="meet-front", type="meeting-seat", x=fx, y=fy, spriteFacing=facing(*MEETING_FRONT), room="conference"))
    for col, rx in enumerate(ROW_X):
        for row, ry in enumerate(ROW_Y):
            sid = f"meet-r{col}-{row}"
            x, y = pct((rx, ry))
            spots.append(dict(id=sid, type="meeting-seat", x=x, y=y, spriteFacing=facing((rx, ry), MEETING_FRONT[0]), room="conference"))
            meeting_seats.append(sid)
            HOOKS[sid] = ["c-front", "c-aisle", "c-back"]
    meeting_standing = []
    for i, p in enumerate(MEETING_STANDING):
        sid = f"meet-stand-{i}"
        x, y = pct(p)
        spots.append(dict(id=sid, type="standing", x=x, y=y, spriteFacing=facing(p, MEETING_FRONT[0]), room="conference"))
        meeting_standing.append(sid)
        HOOKS[sid] = ["c-aisle", "c-back"]

    # waypoint graph: route nodes + every spot as its own node, hooked to the nearest route nodes
    src_pos = dict(NODES)
    for sid, (seat, _l, _w) in SEATS.items():
        src_pos[sid] = seat
    for sid, (seat, _l, _r) in FLOAT.items():
        src_pos[sid] = seat
    for sid, (seat, _l, _t, _r) in SPOTS_MISC.items():
        src_pos[sid] = seat
    src_pos["meet-front"] = MEETING_FRONT[0]
    for col, rx in enumerate(ROW_X):
        for row, ry in enumerate(ROW_Y):
            src_pos[f"meet-r{col}-{row}"] = (rx, ry)
    for i, p in enumerate(MEETING_STANDING):
        src_pos[f"meet-stand-{i}"] = p

    adj = {k: set() for k in src_pos}
    for a, b in EDGES:
        adj[a].add(b); adj[b].add(a)
    for sid, hooks in HOOKS.items():
        for h in hooks:
            adj[sid].add(h); adj[h].add(sid)
    missing = [k for k in src_pos if not adj[k]]
    assert not missing, f"unconnected: {missing}"
    # connectivity from the elevator
    seen, todo = {"h-elev"}, ["h-elev"]
    while todo:
        n = todo.pop()
        for m in adj[n]:
            if m not in seen:
                seen.add(m); todo.append(m)
    unreached = [k for k in src_pos if k not in seen]
    assert not unreached, f"unreachable: {unreached}"

    waypoints = []
    for k, p in src_pos.items():
        x, y = pct(p)
        waypoints.append(dict(id=f"wp-{k}", x=x, y=y, connections=[f"wp-{m}" for m in sorted(adj[k])]))

    labels = []
    for lid, name, sub, p in LABELS:
        x, y = pct(p)
        labels.append(dict(id=lid, name=name, sub=sub, x=x, y=y))

    spot_xy = lambda sid: next({"x": s["x"], "y": s["y"]} for s in spots if s["id"] == sid)
    ex, ey = pct(SPOTS_MISC["door"][0])
    data = dict(
        generatedBy="scripts/build-scranton-floor.py",
        size=dict(width=big.width, height=big.height),
        pixelArt=not photo,
        spriteScale=SPRITE_SCALE,
        background=dict(day="/rooms/scranton-floor-day.png", night="/rooms/scranton-floor-night.png"),
        entryPoint=dict(x=ex, y=ey),
        spots=spots,
        seats=seats,
        deskOwners=owners,
        floaters=FLOATERS,
        floatSpots=list(FLOAT.keys()),
        meetingSeats=meeting_seats,
        meetingStanding=meeting_standing,
        eventTargets={
            "pretzel-day": spot_xy("float-kitchen-1"),
            "pizza": spot_xy("float-kitchen-2"),
            "birthday": spot_xy("float-break-2"),
            "fire-alarm-stress-relief": spot_xy("door"),
            "fire-drill": spot_xy("door"),
            "printer-jam-dm": spot_xy("copier"),
            "printer-jam": spot_xy("copier"),
            "standup": spot_xy("meet-front"),
            "parkour": spot_xy("float-waiting-couch"),
        },
        labels=labels,
        furniture=[],
        waypoints=waypoints,
    )
    with open(OUT_JSON, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    print(f"floor: {len(spots)} spots, {len(waypoints)} waypoints → {os.path.relpath(OUT_JSON, ROOT)}")

    if debug:
        dbg = big.copy()
        d = ImageDraw.Draw(dbg)
        try:
            f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 13)
        except OSError:
            f = ImageFont.load_default()
        sx, sy = big.width / W0, big.height / H0
        S = lambda p: ((p[0] - CROP[0]) * sx, (p[1] - CROP[1]) * sy)
        for a, nbrs in adj.items():
            for b in nbrs:
                d.line([S(src_pos[a]), S(src_pos[b])], fill=(0, 140, 255), width=2)
        for k, p in NODES.items():
            x, y = S(p); d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(0, 140, 255))
        for sid, (seat, look, who) in SEATS.items():
            x, y = S(seat); d.ellipse([x - 7, y - 7, x + 7, y + 7], fill=(230, 30, 30), outline=(255, 255, 255), width=2)
            d.line([S(seat), S(look)], fill=(255, 220, 0), width=3)
            name = (who[0].split("-")[0] + ("/" + who[1].split("-")[0] if len(who) > 1 else "")) if who else sid
            d.text((x + 9, y - 8), name, fill=(180, 0, 0), font=f, stroke_width=2, stroke_fill=(255, 255, 255))
        for sid, (seat, look, room) in FLOAT.items():
            x, y = S(seat); d.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(40, 180, 60), outline=(255, 255, 255), width=2)
        for sid, (seat, look, stype, room) in SPOTS_MISC.items():
            x, y = S(seat); d.rectangle([x - 6, y - 6, x + 6, y + 6], fill=(160, 60, 200), outline=(255, 255, 255), width=2)
            d.text((x + 8, y - 6), sid, fill=(100, 0, 140), font=f, stroke_width=2, stroke_fill=(255, 255, 255))
        for p in [MEETING_FRONT[0]] + [(x, y) for x in ROW_X for y in ROW_Y] + MEETING_STANDING:
            x, y = S(p); d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=(255, 140, 0), outline=(255, 255, 255), width=1)
        for lid, name, sub, p in LABELS:
            x, y = S(p); d.text((x, y), name, fill=(0, 0, 0), font=f, anchor="mm", stroke_width=2, stroke_fill=(255, 255, 0))
        path = os.path.join(ROOT, "docs", "reference", "scranton-floor-debug.png")
        dbg.save(path)
        print("debug overlay →", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main(debug="--debug" in sys.argv, photo="--photo" in sys.argv)
