"""Map definitions for TAG.

The backend owns the level data; the browser fetches it from /api/maps.
Coordinates are in arena pixels (960 x 540), origin top-left.

Rect fields:  x, y, w, h, solid
  solid=True   -> blocks from every side (floor, walls, pillars)
  solid=False  -> one-way platform: you can jump up through it and land on top
Pads:    launch a player upward when they touch the top of them.
Portals: pairs; touching one teleports you to the other (short cooldown).
Spawns:  top-left positions for a 36px player, ordered left -> right.
"""

ARENA_W = 960
ARENA_H = 540
PLAYER_SIZE = 36

FLOOR = {"x": 0, "y": 500, "w": ARENA_W, "h": 40, "solid": True}


def _plat(x, y, w, h=16, solid=False):
    return {"x": x, "y": y, "w": w, "h": h, "solid": solid}


def _pad(x, surface_y, w=64):
    # a pad sits on top of a surface at height `surface_y`
    return {"x": x, "y": surface_y - 10, "w": w, "h": 10}


def _portal(pid, to, x, surface_y):
    return {"id": pid, "to": to, "x": x, "y": surface_y - 56, "w": 34, "h": 56}


_FLOOR_SPAWNS = [[90, 464], [330, 464], [590, 464], [834, 464]]

MAPS = {
    "playground": {
        "name": "Playground",
        "blurb": "Wide open platforms. Easy to learn, hard to escape.",
        "platforms": [
            dict(FLOOR),
            _plat(110, 400, 210),
            _plat(640, 400, 210),
            _plat(375, 312, 210),
            _plat(50, 224, 190),
            _plat(720, 224, 190),
            _plat(375, 130, 210),
        ],
        "pads": [],
        "portals": [],
        "spawns": _FLOOR_SPAWNS,
    },
    "towers": {
        "name": "Towers",
        "blurb": "Pillars to hide behind and a portal pair to slip through.",
        "platforms": [
            dict(FLOOR),
            _plat(250, 388, 30, 112, solid=True),
            _plat(680, 388, 30, 112, solid=True),
            _plat(40, 384, 150),
            _plat(770, 384, 150),
            _plat(395, 384, 170),
            _plat(190, 276, 150),
            _plat(620, 276, 150),
            _plat(400, 176, 160),
            _plat(20, 276, 110),
            _plat(830, 276, 110),
        ],
        "pads": [],
        "portals": [
            _portal("a", "b", 60, 276),
            _portal("b", "a", 866, 276),
        ],
        "spawns": _FLOOR_SPAWNS,
    },
    "bounce": {
        "name": "Bounce House",
        "blurb": "Springy pads launch you sky-high. Chaos guaranteed.",
        "platforms": [
            dict(FLOOR),
            _plat(40, 300, 210),
            _plat(710, 300, 210),
            _plat(370, 390, 220),
            _plat(370, 200, 220),
            _plat(60, 130, 130),
            _plat(770, 130, 130),
        ],
        "pads": [
            _pad(112, 500),
            _pad(784, 500),
            _pad(448, 390),
            _pad(112, 300),
            _pad(784, 300),
        ],
        "portals": [],
        "spawns": [[330, 464], [560, 464], [210, 464], [690, 464]],
    },
}


def public_maps():
    """What the browser receives."""
    return {
        "arena": {"w": ARENA_W, "h": ARENA_H, "player": PLAYER_SIZE},
        "order": list(MAPS.keys()),
        "maps": MAPS,
    }
