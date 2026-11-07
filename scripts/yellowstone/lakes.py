#!/usr/bin/env python3
"""Find lakes in a digital elevation model and estimate how deep they are, from the elevation data alone.

Finding them: a DEM shows a lake as a flat patch at the water level (the sensors see the surface, and the mapmakers flatten the voids), with nothing lower
beside it. The data are noisy by a metre or two, so a pixel counts as flat when most of its neighbours are within a metre and a half of it.

How deep: the lake floor is not in the data. Two things are estimated.
  1. The mean depth, from the lake's area, by the volume-area scaling law of Cael, Heathcote & Seekell (2017, GRL 44:209, doi:10.1002/2016GL071378):
     log10 V = 1.204 log10 A - 0.629 (V in m3, A in m2, scatter 0.292 in log10, so one lake is typically within a factor of 2). It is calibrated on lakes in gentle country.
     Deep lakes in mountains are typically 2 to 4 times deeper than it says, so for lakes with steep shores that is multiplied by MOUNTAIN_FACTOR  -- PROVISIONAL, see below.
  2. The shape of the bed: depth = zmax * (1 - (1 - d/D)^p), d the distance to the nearest shore and D the greatest such distance in the lake. p = 1 is a cone, 2 a sphere;
     real lakes lie between (p of 1.3 to 1.4 reproduces the greatest depth of Yellowstone, Flathead and Bear Lake). zmax is set so the volume comes out right.

PROVISIONAL: MOUNTAIN_FACTOR (3), STEEP_SHORE (5%) and PROFILE_P (1.4) are fitted by eye to three lakes (Yellowstone, Flathead, Bear), two of them with depths from memory.
Shore steepness did not predict how much deeper than the law a lake is (those three lakes: no relationship), so it is a plain constant for now; when there are surveys of
many lakes to fit on and test on, depth_multiplier() is the one place to change.

Nothing in this is specific to one place: it needs only heights and a pixel size.

    python3 scripts/yellowstone/lakes.py TILE_CACHE_DIR      (the Terrain Tiles that build-terrain.py downloads)
"""
import array, importlib.util, math, os, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bt', os.path.join(HERE, 'build-terrain.py')); bt = importlib.util.module_from_spec(spec); spec.loader.exec_module(bt)

def mosaic(cache, z=8):
    """All cached tiles of one zoom level as one array of heights (metres), with the tile range."""
    tiles = {}
    for f in os.listdir(cache):
        if f.startswith(f'{z}_') and f.endswith('.png'):
            _, x, y = f[:-4].split('_'); tiles[(int(x), int(y))] = f
    xs = sorted({k[0] for k in tiles}); ys = sorted({k[1] for k in tiles}); x0, y0 = xs[0], ys[0]
    W, H = (xs[-1] - x0 + 1) * 256, (ys[-1] - y0 + 1) * 256
    dem = array.array('f', [float('nan')]) * (W * H)
    for (tx, ty), f in tiles.items():
        w, h, rows = bt.read_png(os.path.join(cache, f))
        for j in range(h):
            r = rows[j]; base = ((ty - y0) * 256 + j) * W + (tx - x0) * 256
            for i in range(w): dem[base + i] = r[i * 3] * 256 + r[i * 3 + 1] + r[i * 3 + 2] / 256 - 32768
    return dem, W, H, x0, y0

def pixel_lat(py, y0, z=8):
    n = 2 ** z; ty = (y0 * 256 + py + 0.5) / 256
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))

def find_lakes(dem, W, H, y0, flat=0.5, tol=2.0, grow=3.0, min_km2=4.0, z=8):
    """Connected patches of lake surface bigger than min_km2 with nothing lower beside them. The surface is noisy by a metre or two in real data, so a pixel
    counts as flat when at least 6 of its 8 neighbours are within `flat` metres of it; patches grow over pixels within `tol` metres of the patch's level, then small gaps close and the patch grows out to the shore (everything connected within `grow` metres of the level)."""
    cand = bytearray(W * H)
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            i = y * W + x; v = dem[i]
            if v != v: continue
            k = 0
            for d in (-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1):
                if abs(dem[i + d] - v) <= flat: k += 1
            if k >= 6: cand[i] = 1
    seen = bytearray(W * H); claimed = bytearray(W * H); lakes = []   # (claimed: already part of a lake that was found and grown)
    for s in range(W * H):
        if not cand[s] or seen[s] or claimed[s]: continue
        level = dem[s]; comp = [s]; seen[s] = 1; k = 0
        while k < len(comp):
            i = comp[k]; k += 1; x = i % W
            for d, ok in ((-1, x > 0), (1, x < W - 1), (-W, True), (W, True), (-W - 1, x > 0), (-W + 1, x < W - 1), (W - 1, x > 0), (W + 1, x < W - 1)):
                j = i + d
                if ok and 0 <= j < W * H and cand[j] and not seen[j] and abs(dem[j] - level) <= tol: seen[j] = 1; comp.append(j)
        lat = pixel_lat(s // W, y0, z); px = 40075.016 / (256 * 2 ** z) * math.cos(math.radians(lat))
        if len(comp) * px * px < min_km2: continue
        inside = set(comp); level = sorted(dem[i] for i in comp)[len(comp) // 2]
        for _ in range(3):   # close gaps: a pixel mostly surrounded by lake, at about the lake level, belongs to it
            add = []
            ring = {i + d for i in inside for d in (-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1)} - inside
            for j in ring:
                if not (W < j < W * (H - 1) - 1) or abs(dem[j] - level) > tol + 1: continue
                if sum(1 for d in (-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1) if j + d in inside) >= 5: add.append(j)
            if not add: break
            inside.update(add)
        lower = 0; edge = 0
        for i in inside:
            x = i % W
            for d, ok in ((-1, x > 0), (1, x < W - 1), (-W, True), (W, True)):
                j = i + d
                if ok and 0 <= j < W * H and j not in inside:
                    edge += 1
                    if dem[j] < level - 3.0: lower += 1
        # the flat core is only part of a lake (the surface noise breaks it up): grow it out to the shore over everything connected that is within `grow` metres of the lake's level
        frontier = list(inside)
        while frontier:
            nxt = []
            for i in frontier:
                x = i % W
                for d, ok in ((-1, x > 0), (1, x < W - 1), (-W, True), (W, True)):
                    j = i + d
                    if ok and W < j < W * (H - 1) - 1 and j not in inside and abs(dem[j] - level) <= grow: inside.add(j); nxt.append(j)
            frontier = nxt
        comp = list(inside)
        for i in comp: claimed[i] = 1
        lakes.append({'pix': comp, 'level': level, 'edge': edge, 'lower': lower})
    return lakes

def distance_to_shore(comp, W, H):
    """Distance in pixels from every lake pixel to the nearest non-lake pixel (chamfer, 4/3 weights)."""
    inside = {i: None for i in comp}; INF = 1e9
    dist = {i: INF for i in comp}
    order = sorted(comp, key=lambda i: (i // W, i % W))
    nb = ((-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0), (-1, -1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (1, 1, 1.414))
    def step(seq):
        for i in seq:
            y, x = divmod(i, W); best = dist[i]
            for dx, dy, w in nb:
                xx, yy = x + dx, y + dy
                if not (0 <= xx < W and 0 <= yy < H): continue
                j = yy * W + xx
                best = min(best, w if j not in inside else dist[j] + w)
            dist[i] = best
    step(order); step(reversed(order)); step(order)
    return dist

def surrounding_slope(dem, comp, W, H, px_km, ring=6):
    """Mean slope (rise over run, dimensionless) of the land within `ring` pixels of the lake, outside it."""
    inside = set(comp); near = {}; frontier = list(comp); seen = set(comp)
    for _ in range(ring):
        nxt = []
        for i in frontier:
            y, x = divmod(i, W)
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                xx, yy = x + dx, y + dy
                if 1 <= xx < W - 1 and 1 <= yy < H - 1:
                    j = yy * W + xx
                    if j not in seen: seen.add(j); near[j] = 1; nxt.append(j)
        frontier = nxt
    tot = n = 0
    for j in near:
        gx = (dem[j + 1] - dem[j - 1]) / (2 * px_km * 1000); gy = (dem[j + W] - dem[j - W]) / (2 * px_km * 1000)
        g = math.hypot(gx, gy)
        if g == g: tot += g; n += 1
    return tot / n if n else 0.0

# Volume-area scaling law: see the docstring.
CAEL_ZETA, CAEL_LOGK, CAEL_SIGMA = 1.204, -0.629, 0.292

MOUNTAIN_FACTOR = 3.0   # PROVISIONAL: how much deeper than the law a lake with steep shores is (the three lakes tested: 3.3, 3.9, 2.2)
STEEP_SHORE = 0.05      # PROVISIONAL: land slope round the lake (rise over run) from which a lake counts as a mountain lake
PROFILE_P = 1.4         # PROVISIONAL: shape of the bed, 1 = cone, 2 = sphere (the three lakes tested: 1.4, 1.3, 1.3)

def cael_mean_depth(area_km2, sigma_shift=0.0):
    """Mean depth in metres of a typical lake of this area; `sigma_shift` moves it up (+) or down (-) in units of the law's scatter."""
    a = area_km2 * 1e6
    return 10 ** (CAEL_ZETA * math.log10(a) + CAEL_LOGK + sigma_shift * CAEL_SIGMA) / a

def depth_multiplier(shore_slope):
    """How much deeper than the area law a lake is, from the steepness of the land around it. Constant for now (see the docstring); the one place to put a better rule."""
    return MOUNTAIN_FACTOR if shore_slope >= STEEP_SHORE else 1.0

def estimate(dem, W, H, y0, lake, z=8, mean_depth=None, p=None):
    """Depth of every pixel of a lake from its area and shore (or from a known mean depth, to test the shape alone). Returns the numbers and `depth`, a dict of metres per pixel."""
    p = PROFILE_P if p is None else p
    comp = lake['pix']; lat = pixel_lat(comp[0] // W, y0, z); px = 40075.016 / (256 * 2 ** z) * math.cos(math.radians(lat))
    dist = distance_to_shore(comp, W, H); D = max(dist.values()) * px
    shape = {i: 1 - (1 - min(1.0, dist[i] * px / D)) ** p for i in comp}; m0 = sum(shape.values()) / len(shape)
    area = len(comp) * px * px; slope = surrounding_slope(dem, comp, W, H, px); mult = depth_multiplier(slope)
    zbar = mean_depth if mean_depth is not None else cael_mean_depth(area) * mult
    depth = {i: zbar / m0 * shape[i] for i in comp}
    cy = sum(i // W for i in comp) / len(comp); cx = sum(i % W for i in comp) / len(comp)
    return {'area_km2': area, 'level_m': lake['level'], 'shore_slope': slope, 'multiplier': mult, 'D_km': D, 'mean_depth_m': zbar, 'max_depth_m': max(depth.values()),
            'volume_km3': zbar * area / 1000, 'depth': depth, 'cx': cx, 'cy': cy, 'lat': lat}

if __name__ == '__main__':
    cache = sys.argv[1]; z = 8
    dem, W, H, x0, y0 = mosaic(cache, z)
    n = 2 ** z
    lakes = find_lakes(dem, W, H, y0, z=z)
    good = [l for l in lakes if l['lower'] <= 0.03 * max(1, l['edge'])]
    print(f'{len(lakes)} flat patches over 4 km2, {len(good)} with almost nothing lower beside them')
    rows = []
    for l in good:
        e = estimate(dem, W, H, y0, l, z); lon = ((x0 * 256 + e['cx']) / (256 * n)) * 360 - 180
        rows.append((e['area_km2'], e['level_m'], e['lat'], lon, e['shore_slope'], e['multiplier'], e['mean_depth_m'], e['max_depth_m'], e['volume_km3']))
    rows.sort(reverse=True)
    print(' area km2  level m    lat      lon   shore slope  x  mean depth  max depth  volume km3')
    for r in rows[:30]: print('%9.0f %8.0f %8.2f %8.2f %9.3f %5.1f %9.0f %10.0f %10.2f' % r)
