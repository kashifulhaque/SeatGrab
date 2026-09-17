"""Generate the Gerrymander board: nine districts of an island, laid out on a hex lattice.

Run it with no arguments to rewrite `packages/content/src/boards/isle-nine.ts`:

    python3 scripts/generate_board.py [output.ts] [--preview preview.svg]

The shape of the island is derived, not drawn by hand. Three facts drive everything:

1. The nine districts and how they border each other are fixed game data, listed in
   `ZONES` below. They come from the ruleset and this script never invents one.
2. That border graph is not outerplanar - `central` touches only `north` and `south`, and
   `north`/`south` both touch `west`, `east` and `central` - so no layout can put all nine
   districts on the coast. The island is therefore built in three tiers: a `central` core,
   a belt of `north` and `south` around it, and a rim of the remaining six districts
   around that. Every required border falls out of the tiers, and every forbidden one is
   impossible in them.
3. The border graph is unchanged by a half-turn that swaps northWest with southEast,
   northEast with southWest, west with east and north with south. The island is built to
   have that same symmetry, so no seat gets a shape another seat does not.

Each district is a set of cells on a pointy-top hex lattice. A cell holds one voter area
unless it is under the district's plaque, which is kept clear so a plaque never covers an
area, or unless the district has a cell to spare, which stays as open ground. District
outlines are the union of their cells' edges, so districts tile without a seam and the
coast is the only rounded edge.

The script asserts what it built: cell counts, one connected piece per district, one
boundary loop per district, and drawn borders that match `ZONES` exactly. A layout that
fails any of those is a bug in this file, not something to hand-fix downstream.
"""

from __future__ import annotations

import math
import sys
from collections import deque

# --------------------------------------------------------------------------- game data

# id, display name, capacity, majority threshold, volatile areas, neighbours.
ZONES = [
    ('northWest', 'North West', 11, 6, 1, ['northEast', 'north', 'west']),
    ('north', 'North', 21, 11, 2, ['northWest', 'northEast', 'west', 'east', 'central', 'south']),
    ('northEast', 'North East', 11, 6, 1, ['northWest', 'north', 'east']),
    ('west', 'West', 17, 9, 1, ['northWest', 'north', 'south', 'southWest']),
    ('central', 'Central', 9, 5, 1, ['north', 'south']),
    ('east', 'East', 17, 9, 1, ['northEast', 'north', 'south', 'southEast']),
    ('southWest', 'South West', 11, 6, 1, ['west', 'south', 'southEast']),
    ('south', 'South', 21, 11, 2, ['north', 'west', 'east', 'central', 'southWest', 'southEast']),
    ('southEast', 'South East', 11, 6, 1, ['east', 'south', 'southWest']),
]

# Legal moves a redistricting right authorizes, as (rights zone, source, destination).
# Carried over verbatim from the traced board: the map changed, the rules did not.
MOVEMENT_TRIPLES = [
    ('northWest', 'northWest', 'northEast'),
    ('northWest', 'northWest', 'north'),
    ('northWest', 'northWest', 'west'),
    ('northWest', 'northEast', 'northWest'),
    ('northWest', 'northEast', 'north'),
    ('northWest', 'north', 'northWest'),
    ('northWest', 'north', 'northEast'),
    ('northWest', 'north', 'west'),
    ('northWest', 'north', 'east'),
    ('northWest', 'west', 'northWest'),
    ('northWest', 'west', 'north'),
    ('north', 'northWest', 'northEast'),
    ('north', 'northWest', 'north'),
    ('north', 'northWest', 'west'),
    ('north', 'northEast', 'northWest'),
    ('north', 'northEast', 'north'),
    ('north', 'northEast', 'east'),
    ('north', 'north', 'northWest'),
    ('north', 'north', 'northEast'),
    ('north', 'north', 'west'),
    ('north', 'north', 'east'),
    ('north', 'north', 'central'),
    ('north', 'north', 'south'),
    ('north', 'west', 'northWest'),
    ('north', 'west', 'north'),
    ('north', 'west', 'south'),
    ('north', 'central', 'north'),
    ('north', 'central', 'south'),
    ('north', 'east', 'northEast'),
    ('north', 'east', 'north'),
    ('north', 'east', 'south'),
    ('north', 'south', 'north'),
    ('north', 'south', 'west'),
    ('north', 'south', 'east'),
    ('north', 'south', 'central'),
    ('northEast', 'northWest', 'northEast'),
    ('northEast', 'northWest', 'north'),
    ('northEast', 'northEast', 'northWest'),
    ('northEast', 'northEast', 'north'),
    ('northEast', 'northEast', 'east'),
    ('northEast', 'north', 'northWest'),
    ('northEast', 'north', 'northEast'),
    ('northEast', 'north', 'west'),
    ('northEast', 'north', 'east'),
    ('northEast', 'east', 'northEast'),
    ('northEast', 'east', 'north'),
    ('west', 'northWest', 'north'),
    ('west', 'northWest', 'west'),
    ('west', 'north', 'northWest'),
    ('west', 'north', 'west'),
    ('west', 'north', 'south'),
    ('west', 'west', 'northWest'),
    ('west', 'west', 'north'),
    ('west', 'west', 'south'),
    ('west', 'west', 'southWest'),
    ('west', 'south', 'north'),
    ('west', 'south', 'west'),
    ('west', 'south', 'southWest'),
    ('west', 'south', 'southEast'),
    ('west', 'southWest', 'west'),
    ('west', 'southWest', 'south'),
    ('central', 'north', 'central'),
    ('central', 'north', 'south'),
    ('central', 'central', 'north'),
    ('central', 'central', 'south'),
    ('central', 'south', 'north'),
    ('central', 'south', 'central'),
    ('east', 'northEast', 'north'),
    ('east', 'northEast', 'east'),
    ('east', 'north', 'northEast'),
    ('east', 'north', 'east'),
    ('east', 'north', 'south'),
    ('east', 'east', 'northEast'),
    ('east', 'east', 'north'),
    ('east', 'east', 'south'),
    ('east', 'east', 'southEast'),
    ('east', 'south', 'north'),
    ('east', 'south', 'east'),
    ('east', 'south', 'southWest'),
    ('east', 'south', 'southEast'),
    ('east', 'southEast', 'east'),
    ('east', 'southEast', 'south'),
    ('southWest', 'west', 'south'),
    ('southWest', 'west', 'southWest'),
    ('southWest', 'southWest', 'west'),
    ('southWest', 'southWest', 'south'),
    ('southWest', 'southWest', 'southEast'),
    ('southWest', 'south', 'west'),
    ('southWest', 'south', 'southWest'),
    ('southWest', 'south', 'southEast'),
    ('southWest', 'southEast', 'south'),
    ('southWest', 'southEast', 'southWest'),
    ('south', 'north', 'west'),
    ('south', 'north', 'east'),
    ('south', 'north', 'central'),
    ('south', 'north', 'south'),
    ('south', 'west', 'north'),
    ('south', 'west', 'south'),
    ('south', 'west', 'southWest'),
    ('south', 'central', 'north'),
    ('south', 'central', 'south'),
    ('south', 'east', 'north'),
    ('south', 'east', 'south'),
    ('south', 'east', 'southEast'),
    ('south', 'southWest', 'west'),
    ('south', 'southWest', 'south'),
    ('south', 'southWest', 'southEast'),
    ('south', 'south', 'north'),
    ('south', 'south', 'west'),
    ('south', 'south', 'east'),
    ('south', 'south', 'central'),
    ('south', 'south', 'southWest'),
    ('south', 'south', 'southEast'),
    ('south', 'southEast', 'east'),
    ('south', 'southEast', 'south'),
    ('south', 'southEast', 'southWest'),
    ('southEast', 'east', 'south'),
    ('southEast', 'east', 'southEast'),
    ('southEast', 'southWest', 'south'),
    ('southEast', 'southWest', 'southEast'),
    ('southEast', 'south', 'east'),
    ('southEast', 'south', 'southWest'),
    ('southEast', 'south', 'southEast'),
    ('southEast', 'southEast', 'east'),
    ('southEast', 'southEast', 'south'),
    ('southEast', 'southEast', 'southWest'),
]

BOARD_ID = 'isle-nine'
BOARD_VERSION = '1.0.0'

# ------------------------------------------------------------------------- the lattice

# Axial directions for a pointy-top lattice, in the order the corners below expect.
DIRS = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
# Which pair of hex corners each direction's edge runs between, clockwise on screen.
EDGE_CORNERS = {0: (0, 1), 5: (1, 2), 4: (2, 3), 3: (3, 4), 2: (4, 5), 1: (5, 0)}

# Half the half-turn: the district a district becomes when the board is turned 180°.
HALF_TURN = {
    'northWest': 'southEast', 'southEast': 'northWest',
    'northEast': 'southWest', 'southWest': 'northEast',
    'west': 'east', 'east': 'west',
    'north': 'south', 'south': 'north',
    'central': 'central',
}

# The rim, clockwise from due west. `west` and `east` are the wide ones.
RIM_ORDER = ['west', 'northWest', 'northEast', 'east', 'southEast', 'southWest']


def centre(cell: tuple[int, int], size: float = 1.0) -> tuple[float, float]:
    """Drawing-space centre of a lattice cell, y downwards."""
    q, r = cell
    return (size * math.sqrt(3) * (q + r / 2), size * 1.5 * r)


def corners(cell: tuple[int, int], size: float) -> list[tuple[float, float]]:
    cx, cy = centre(cell, size)
    return [
        (cx + size * math.cos(math.radians(60 * i - 30)),
         cy + size * math.sin(math.radians(60 * i - 30)))
        for i in range(6)
    ]


def neighbours(cell: tuple[int, int]) -> list[tuple[int, int]]:
    return [(cell[0] + dq, cell[1] + dr) for dq, dr in DIRS]


def cell_at(x: float, y: float, size: float) -> tuple[int, int]:
    """The cell a drawing-space point falls in. The inverse of `centre`, rounded."""
    q = (math.sqrt(3) / 3 * x - y / 3) / size
    r = (2 / 3 * y) / size
    s = -q - r
    rq, rr, rs = round(q), round(r), round(s)
    dq, dr, ds = abs(rq - q), abs(rr - r), abs(rs - s)
    if dq > dr and dq > ds:
        rq = -rr - rs
    elif dr > ds:
        rr = -rq - rs
    return (int(rq), int(rr))


def depth(cells: set[tuple[int, int]]) -> dict[tuple[int, int], int]:
    """How many cells deep inside its district each cell sits. Edge cells are 1."""
    result = {cell: 1 for cell in cells if any(n not in cells for n in neighbours(cell))}
    queue = deque(result)
    while queue:
        cell = queue.popleft()
        for neighbour in neighbours(cell):
            if neighbour in cells and neighbour not in result:
                result[neighbour] = result[cell] + 1
                queue.append(neighbour)
    return result


def connected(cells: set[tuple[int, int]]) -> bool:
    if not cells:
        return False
    start = next(iter(cells))
    seen = {start}
    queue = deque([start])
    while queue:
        for neighbour in neighbours(queue.popleft()):
            if neighbour in cells and neighbour not in seen:
                seen.add(neighbour)
                queue.append(neighbour)
    return len(seen) == len(cells)


# ------------------------------------------------------------------- building the isle

def coast_radius(angle: float) -> float:
    """How far the coast reaches at this bearing, as a multiple of the mean radius.

    Only even harmonics, so the island is unchanged by a half-turn. The island is a
    little wider than it is tall and the corners are pulled in, which keeps the four
    corner districts compact and gives `west` and `east` the room their capacity needs.
    """
    return 1.0 + 0.085 * math.cos(2 * angle) - 0.055 * math.cos(4 * angle)


def rank_cells(limit: int) -> list[tuple[int, int]]:
    """Every cell that could be land, innermost first, always in half-turn pairs."""
    pool = []
    for q in range(-limit, limit + 1):
        for r in range(-limit, limit + 1):
            if abs(q + r) > limit:
                continue
            x, y = centre((q, r))
            distance = math.hypot(x, y)
            angle = math.atan2(-y, x)
            pool.append((distance / coast_radius(angle), angle, (q, r)))
    pool.sort(key=lambda item: (round(item[0], 9), -item[1]))
    ordered: list[tuple[int, int]] = []
    taken: set[tuple[int, int]] = set()
    for _, _, cell in pool:
        if cell in taken:
            continue
        mirror = (-cell[0], -cell[1])
        taken.add(cell)
        ordered.append(cell)
        if mirror != cell:
            taken.add(mirror)
            ordered.append(mirror)
    return ordered


def bearing_rank(cell: tuple[int, int]) -> tuple[float, float]:
    """Sort key that walks the rim clockwise from due west, then outwards."""
    x, y = centre(cell)
    angle = math.degrees(math.atan2(-y, x))
    return ((180.0 - angle) % 360.0, math.hypot(x, y))


def carve(targets: dict[str, int]) -> dict[tuple[int, int], str]:
    """Cut the island into nine districts of the requested cell counts."""
    core = targets['central']
    belt = targets['north'] + targets['south']
    rim = sum(targets[zone] for zone in RIM_ORDER)
    assert core % 2 == 1, 'the core needs an odd cell count to hold the centre'
    assert targets['north'] == targets['south'], 'the belt halves must match'
    for zone in RIM_ORDER:
        assert targets[zone] == targets[HALF_TURN[zone]], f'{zone} and its opposite differ'

    ordered = rank_cells(limit=12)[:core + belt + rim]
    assert len(ordered) == core + belt + rim, 'the lattice is too small for this island'

    owner: dict[tuple[int, int], str] = {}
    for cell in ordered[:core]:
        owner[cell] = 'central'

    # The belt splits along the horizontal. North takes the upper half and south the
    # lower, so the two meet either side of the core: that meeting is the north-south
    # border, and it is why the core touches those two districts and nothing else.
    for cell in ordered[core:core + belt]:
        x, y = centre(cell)
        owner[cell] = 'north' if (y < 0 or (y == 0 and x > 0)) else 'south'

    # The rim is cut into six arcs. West starts half its own arc before due west, so it
    # sits centred on the horizontal and meets both halves of the belt; east, opposite
    # it, does the same.
    rim_cells = sorted(ordered[core + belt:], key=bearing_rank)
    offset = targets['west'] // 2
    rim_cells = rim_cells[-offset:] + rim_cells[:-offset]
    at = 0
    for zone in RIM_ORDER:
        for cell in rim_cells[at:at + targets[zone]]:
            owner[cell] = zone
        at += targets[zone]
    assert at == len(rim_cells)
    return owner


def drawn_adjacency(owner: dict[tuple[int, int], str]) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {zone: set() for zone, *_ in ZONES}
    for cell, zone in owner.items():
        for neighbour in neighbours(cell):
            other = owner.get(neighbour)
            if other is not None and other != zone:
                found[zone].add(other)
    return found


# ---------------------------------------------------------------------------- plaques

# What a zone plaque needs kept clear of voter areas, in drawing units around its anchor.
# The board draws a 124 by 54 tab; the rest is the gap between the tab and the nearest
# voter area. Every plaque is the same size, so this one rectangle covers all nine.
PLAQUE_CLEAR = (-70.0, -35.0, 70.0, 35.0)


def plaque_probes(size: float) -> list[tuple[float, float]]:
    """Points around the plaque's edge, close enough together to catch any intrusion."""
    left, top, right, bottom = PLAQUE_CLEAR
    step = size / 2
    xs = [left + i * step for i in range(int((right - left) / step) + 1)] + [right]
    ys = [top + i * step for i in range(int((bottom - top) / step) + 1)] + [bottom]
    points = {(x, top) for x in xs} | {(x, bottom) for x in xs}
    points |= {(left, y) for y in ys} | {(right, y) for y in ys}
    points |= {(0.0, (top + bottom) / 2)}
    return sorted(points)


def plaque_anchor(
    cells: list[tuple[int, int]],
    owner: dict[tuple[int, int], str],
    zone: str,
    size: float,
    frame: tuple[float, float, float, float],
) -> tuple[float, float]:
    """Where the district's plaque sits.

    A plaque is anchored on its own district and may reach out over the sea - a coastal
    district is a thin arc, and a name written only on the land it owns would not fit -
    but it may never reach across a border or off the board. Of the anchors that satisfy
    that, the one nearest the district's middle wins.
    """
    probes = plaque_probes(size)
    cx = sum(centre(cell, size)[0] for cell in cells) / len(cells)
    cy = sum(centre(cell, size)[1] for cell in cells) / len(cells)

    candidates: list[tuple[float, float]] = []
    for cell in cells:
        x, y = centre(cell, size)
        candidates.append((x, y))
        for neighbour in neighbours(cell):
            if owner.get(neighbour) == zone:
                nx, ny = centre(neighbour, size)
                candidates.append(((x + nx) / 2, (y + ny) / 2))

    left, top, right, bottom = PLAQUE_CLEAR
    frame_left, frame_top, frame_right, frame_bottom = frame
    best: tuple[float, tuple[float, float]] | None = None
    for x, y in candidates:
        if not (frame_left <= x + left and x + right <= frame_right
                and frame_top <= y + top and y + bottom <= frame_bottom):
            continue
        if any(owner.get(cell_at(x + px, y + py, size), zone) != zone for px, py in probes):
            continue
        score = math.hypot(x - cx, y - cy)
        if best is None or score < best[0]:
            best = (score, (x, y))
    assert best is not None, f'no room for the {zone} plaque'
    return best[1]


def plaque_cells(
    anchor: tuple[float, float],
    cells: list[tuple[int, int]],
    size: float,
) -> set[tuple[int, int]]:
    """Cells the plaque covers, which therefore carry no voter area."""
    left, top, right, bottom = PLAQUE_CLEAR
    ax, ay = anchor
    covered = set()
    for cell in cells:
        x, y = centre(cell, size)
        # A cell is covered when the plaque reaches its drawn dot, not merely its corner.
        if ax + left - size * 0.45 < x < ax + right + size * 0.45 and \
           ay + top - size * 0.45 < y < ay + bottom + size * 0.45:
            covered.add(cell)
    return covered


# ---------------------------------------------------------------------------- outlines

def outline(cells: set[tuple[int, int]], land: set[tuple[int, int]], size: float,
            rounding: float, place) -> str:
    """The district's border as one closed path, with only its coastal corners rounded."""
    edges: dict[tuple[float, float], tuple[tuple[float, float], bool]] = {}
    for cell in cells:
        pts = corners(cell, size)
        for direction, (a, b) in EDGE_CORNERS.items():
            neighbour = (cell[0] + DIRS[direction][0], cell[1] + DIRS[direction][1])
            if neighbour in cells:
                continue
            start = (round(pts[a][0], 6), round(pts[a][1], 6))
            end = (round(pts[b][0], 6), round(pts[b][1], 6))
            edges[start] = (end, neighbour not in land)

    start = min(edges)
    loop: list[tuple[tuple[float, float], bool]] = []
    point = start
    while True:
        end, coastal = edges[point]
        loop.append((point, coastal))
        point = end
        if point == start:
            break
    assert len(loop) == len(edges), 'the district has more than one boundary loop'

    # A vertex is rounded only when the sea is on both sides of it, so two districts that
    # share a border still meet exactly.
    parts = []
    count = len(loop)
    for index in range(count):
        here, out_coastal = loop[index]
        previous, in_coastal = loop[index - 1]
        following = loop[(index + 1) % count][0]
        if in_coastal and out_coastal:
            cut = min(rounding, math.dist(here, previous) / 2, math.dist(here, following) / 2)
            bx = here[0] + cut * (previous[0] - here[0]) / math.dist(here, previous)
            by = here[1] + cut * (previous[1] - here[1]) / math.dist(here, previous)
            ax = here[0] + cut * (following[0] - here[0]) / math.dist(here, following)
            ay = here[1] + cut * (following[1] - here[1]) / math.dist(here, following)
            parts.append((('corner'), (bx, by), here, (ax, ay)))
        else:
            parts.append((('sharp'), here))

    def fmt(point: tuple[float, float]) -> str:
        shifted = place(point)
        return f'{shifted[0]:.1f} {shifted[1]:.1f}'

    d = []
    for index, part in enumerate(parts):
        if part[0] == 'sharp':
            d.append(('M' if index == 0 else 'L') + fmt(part[1]))
        else:
            _, before, vertex, after = part
            d.append(('M' if index == 0 else 'L') + fmt(before))
            d.append('Q' + fmt(vertex) + ' ' + fmt(after))
    return ''.join(d) + 'Z'


# --------------------------------------------------------------------- volatile areas

def volatile_choice(points: list[tuple[float, float]], count: int) -> list[int]:
    """Spread `count` volatile areas through a district: cluster, then take each medoid."""
    if count == 1:
        cx = sum(p[0] for p in points) / len(points)
        cy = sum(p[1] for p in points) / len(points)
        return [min(range(len(points)), key=lambda i: math.dist(points[i], (cx, cy)))]

    # Farthest-point seeds, then Lloyd's algorithm, both deterministic.
    seeds = [max(range(len(points)), key=lambda i: points[i][1])]
    while len(seeds) < count:
        seeds.append(max(
            range(len(points)),
            key=lambda i: min(math.dist(points[i], points[s]) for s in seeds),
        ))
    centres = [points[s] for s in seeds]
    for _ in range(24):
        groups: list[list[int]] = [[] for _ in range(count)]
        for index, point in enumerate(points):
            groups[min(range(count), key=lambda c: math.dist(point, centres[c]))].append(index)
        moved = False
        for c, group in enumerate(groups):
            if not group:
                continue
            nx = sum(points[i][0] for i in group) / len(group)
            ny = sum(points[i][1] for i in group) / len(group)
            if math.dist((nx, ny), centres[c]) > 1e-9:
                moved = True
            centres[c] = (nx, ny)
        if not moved:
            break
    chosen = []
    for c, group in enumerate(groups):
        chosen.append(min(group, key=lambda i: math.dist(points[i], centres[c])))
    return sorted(set(chosen))


# ------------------------------------------------------------------------------ output

WIDTH = 1000.0
MARGIN = 72.0
ROUNDING = 9.0
# A voter area's drawn dot and its hit target, as multiples of a cell's circumradius.
# The hit target stops just inside the cell, so no two areas compete for the same click.
SLOT_RADIUS = 0.62
SLOT_HIT = 0.85


def build() -> tuple[str, dict]:
    capacity = {zone: cap for zone, _, cap, *_ in ZONES}
    # Districts start out the size of their capacity and grow by whatever their plaque
    # covers, until both agree. Two rounds is usually enough; ten is a hard stop.
    spare = {zone: 4 for zone in capacity}
    for attempt in range(10):
        targets = {zone: capacity[zone] + spare[zone] for zone in capacity}
        for zone in targets:
            targets[zone] = max(targets[zone], targets[HALF_TURN[zone]])
        # The core holds the middle cell and grows in half-turn pairs, so it is odd.
        targets['central'] += (targets['central'] + 1) % 2
        owner = carve(targets)

        # Scale the lattice so the island fills the frame.
        pts = [corner for cell in owner for corner in corners(cell, 1.0)]
        span_x = max(p[0] for p in pts) - min(p[0] for p in pts)
        span_y = max(p[1] for p in pts) - min(p[1] for p in pts)
        size = (WIDTH - 2 * MARGIN) / span_x
        height = span_y * size + 2 * MARGIN

        by_zone: dict[str, list[tuple[int, int]]] = {zone: [] for zone in capacity}
        for cell, zone in owner.items():
            by_zone[zone].append(cell)

        frame = (
            min(p[0] for p in pts) * size - MARGIN, min(p[1] for p in pts) * size - MARGIN,
            max(p[0] for p in pts) * size + MARGIN, max(p[1] for p in pts) * size + MARGIN,
        )
        anchors, covered, needed = {}, {}, {}
        for zone, cells in by_zone.items():
            anchors[zone] = plaque_anchor(cells, owner, zone, size, frame)
            covered[zone] = plaque_cells(anchors[zone], cells, size)
            needed[zone] = capacity[zone] + len(covered[zone])
        # Settled once every district has room for its areas and its plaque. A district
        # may end up with a cell to spare - the core is held to an odd count - and that
        # cell stays as open ground rather than forcing another round.
        if all(targets[zone] - needed[zone] in (0, 1) for zone in capacity):
            break
        for zone in capacity:
            spare[zone] = len(covered[zone])
    else:
        raise SystemExit('district sizes did not settle')

    # The drawing is shifted so the island sits inside the frame with its margin.
    min_x = min(p[0] for p in pts) * size - MARGIN
    min_y = min(p[1] for p in pts) * size - MARGIN

    def place(point: tuple[float, float]) -> tuple[float, float]:
        """A scaled lattice point moved into the frame, margin and all."""
        return (point[0] - min_x, point[1] - min_y)

    land = set(owner)
    drawn = drawn_adjacency(owner)
    zone_lines, slot_lines = [], []
    paths, labels, dots = [], [], []
    stats = {'cells': len(owner), 'size': size, 'height': height}
    for zone, name, cap, threshold, volatile, adjacency in ZONES:
        cells = by_zone[zone]
        assert len(cells) - len(covered[zone]) >= cap, f'{zone} has too few open cells'
        assert connected(set(cells)), f'{zone} is not one piece'
        assert drawn[zone] == set(adjacency), (
            f'{zone} borders {sorted(drawn[zone])}, but the ruleset says {sorted(adjacency)}'
        )

        # A district with a cell to spare leaves its shallowest one as open ground.
        inside = depth(set(cells))
        open_cells = [cell for cell in cells if cell not in covered[zone]]
        open_cells.sort(key=lambda cell: (-inside[cell], math.hypot(*centre(cell, size))))
        open_cells = open_cells[:cap]
        # Areas read left to right, top to bottom, so "area 7" is findable on the map.
        open_cells.sort(key=lambda cell: (round(centre(cell, size)[1], 3), centre(cell, size)[0]))
        points = [place(centre(cell, size)) for cell in open_cells]
        volatile_indexes = set(volatile_choice(points, volatile))
        assert len(volatile_indexes) == volatile, f'{zone} got the wrong volatile count'

        path = outline(set(cells), land, size, ROUNDING, place)
        label = place(anchors[zone])
        paths.append(path)
        labels.append((label, name, threshold, cap))
        zone_lines.append(
            f"    {{ id: '{zone}', displayName: '{name}', capacity: {cap}, "
            f"majorityThreshold: {threshold}, volatileAreas: {volatile}, "
            f"adjacency: [{', '.join(repr(a).replace(chr(34), chr(39)) for a in adjacency)}], "
            f"label: {{ x: {label[0] / WIDTH:.6f}, y: {label[1] / height:.6f} }}, "
            f"path: '{path}' }},"
        )
        for index, (x, y) in enumerate(points):
            dots.append((x, y, size * SLOT_RADIUS, index in volatile_indexes))
            slot_lines.append(
                f"    {{ slotId: '{zone}-{index + 1:02d}', zoneId: '{zone}', "
                f"position: {{ x: {x / WIDTH:.6f}, y: {y / height:.6f} }}, "
                f"radius: {size * SLOT_RADIUS / WIDTH:.6f}, "
                f"hitRadius: {size * SLOT_HIT / WIDTH:.6f}, "
                f"volatile: {'true' if index in volatile_indexes else 'false'} }},"
            )

    assert len(slot_lines) == sum(capacity.values()) == 129, len(slot_lines)
    aspect = height / WIDTH
    newline = '\n'
    ts = f'''// GENERATED by scripts/generate_board.py. Edit the script and regenerate; do not hand-edit.
//
// An island of nine districts: `central` at the core, `north` and `south` belting it, and
// the other six around the coast. The drawn borders match `adjacency` exactly - the
// script refuses to emit a map where they do not - but legality is still read from
// `adjacency` and `movementTriples`, never from the artwork.

import type {{ BoardDefinition }} from '../schema.js';

/** The nine-district, 129-area Gerrymander board. */
export const CORE_BOARD: BoardDefinition = {{
  id: '{BOARD_ID}',
  version: '{BOARD_VERSION}',
  zones: [
{newline.join(zone_lines)}
  ],
  slots: [
{newline.join(slot_lines)}
  ],
  movementTriples: [
{newline.join(f"    ['{a}', '{b}', '{c}']," for a, b, c in MOVEMENT_TRIPLES)}
  ],
  art: {{
    aspectRatio: {aspect:.6f},
    viewBox: '0 0 {WIDTH:.0f} {height:.0f}',
  }},
}};
'''
    stats['zones'] = len(zone_lines)
    stats['slots'] = len(slot_lines)
    stats['aspect'] = aspect
    return ts, stats, preview(paths, labels, dots, height)


def preview(paths, labels, dots, height: float) -> str:
    """A standalone SVG of the board, drawn the way the app draws it, for eyeballing."""
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH:.0f} {height:.0f}" '
        f'width="{WIDTH:.0f}" height="{height:.0f}">',
        f'<rect x="0" y="0" width="{WIDTH:.0f}" height="{height:.0f}" rx="28" fill="#e3e8f2"/>',
    ]
    for index, path in enumerate(paths):
        fill = '#ffffff' if index % 2 == 0 else '#eef2fa'
        parts.append(f'<path d="{path}" fill="{fill}" stroke="#1f2a44" stroke-width="3" '
                     'stroke-linejoin="round"/>')
    for x, y, radius, volatile in dots:
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" fill="#e3e8f2" '
                     'stroke="#1f2a4455" stroke-width="1.6"/>')
        if volatile:
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius + 5:.1f}" fill="none" '
                         'stroke="#c4562b" stroke-width="3" stroke-dasharray="9 7"/>')
    for (x, y), name, threshold, cap in labels:
        parts.append(f'<g transform="translate({x:.1f} {y:.1f})">'
                     '<path d="M-62-27H62q6 0 6 6V21q0 6-6 6H-62q-6 0-6-6V-21q0-6 6-6z" '
                     'fill="#1f2a44" stroke="#f4b942" stroke-width="2"/>'
                     f'<text y="-7" text-anchor="middle" fill="#f4f6fb" font-family="sans-serif" '
                     f'font-size="14" letter-spacing="1.1">{name.upper()}</text>'
                     f'<text y="17" text-anchor="middle" fill="#f4f6fb" font-family="sans-serif" '
                     f'font-size="19" font-weight="700">{threshold}/{cap}</text></g>')
    parts.append('</svg>')
    return '\n'.join(parts)


def main() -> None:
    argv = sys.argv[1:]
    args = [arg for arg in argv if not arg.startswith('--')]
    out = args[0] if args else 'packages/content/src/boards/isle-nine.ts'
    ts, stats, svg = build()
    with open(out, 'w') as handle:
        handle.write(ts)
    if '--preview' in argv:
        target = argv[argv.index('--preview') + 1]
        with open(target, 'w') as handle:
            handle.write(svg)
        print(f'preview: {target}')
    print(f"{out}: {stats['zones']} districts, {stats['slots']} areas, "
          f"{stats['cells']} cells, aspect {stats['aspect']:.3f}")


if __name__ == '__main__':
    main()
