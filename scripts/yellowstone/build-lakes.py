#!/usr/bin/env python3
"""Build public/projects/yellowstone/lakes.js: how deep each lake is on every cell of the map, from the elevation tiles alone (see lakes.py for how).

    python3 scripts/yellowstone/build-lakes.py CACHE_DIR      (the tiles build-terrain.py downloads)

A cell is a lake cell when at least half of it is lake; its depth is the mean depth of the lake pixels in it (metres). Lakes bigger than MAX_KM2 are left out: the big ones in the data are
shallow terminal lakes (Great Salt Lake), which the area law gets badly wrong.
"""
import importlib.util, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('lakes', os.path.join(HERE, 'lakes.py')); L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
OUT = os.path.join(HERE, '..', '..', 'public', 'projects', 'yellowstone', 'lakes.js')
MAX_KM2 = 1500.0

def main(cache):
    T = open(os.path.join(os.path.dirname(OUT), 'terrain.js')).read()
    g = lambda k: float(re.search(k + r': (-?[\d.]+)', T).group(1))
    N, top, bot, west, east = int(g('n')), g('latTop'), g('latBottom'), g('west'), g('east')
    z = 8; dem, W, H, x0, y0 = L.mosaic(cache, z); n2 = 2 ** z
    cell_km2 = ((top - bot) / N * 111.2) * ((east - west) / N * 111.32 * math.cos(math.radians((top + bot) / 2)))
    lakes = [l for l in L.find_lakes(dem, W, H, y0, z=z) if l['lower'] <= 0.03 * max(1, l['edge'])]
    cells = {}; used = []
    for lake in lakes:
        e = L.estimate(dem, W, H, y0, lake, z)
        if e['area_km2'] > MAX_KM2: continue
        px_km2 = (40075.016 / (256 * n2) * math.cos(math.radians(e['lat']))) ** 2
        for i, d in e['depth'].items():
            py, pxl = divmod(i, W); lat = L.pixel_lat(py, y0, z); lon = ((x0 * 256 + pxl + 0.5) / (256 * n2)) * 360 - 180
            r = int((top - lat) / (top - bot) * N); c = int((lon - west) / (east - west) * N)
            if 0 <= r < N and 0 <= c < N:
                a = cells.setdefault(r * N + c, [0, 0.0, 0.0]); a[0] += 1; a[1] += d; a[2] = px_km2
        used.append(e)
    out = []
    for idx, (cnt, tot, pa) in sorted(cells.items()):
        if cnt * pa >= 0.5 * cell_km2: out.append([idx, round(tot / cnt, 1)])
    vol = sum(d for _, d in out) * cell_km2 / 1000
    print(f'{len(used)} lakes, {len(out)} lake cells ({len(out) * cell_km2:.0f} km2), volume {vol:.1f} km3')
    with open(OUT, 'w') as f:
        f.write("// Lake depths on the map, from the elevation data alone (volume-area scaling and a bowl-shaped bed); built by scripts/yellowstone/build-lakes.py, do not edit by hand.\n")
        f.write(f"// `cells`: [cell index (row * n + column), mean depth in metres] for every cell that is at least half lake.\nexport const LAKES = {{ n: {N}, cells: {out!r} }};\n".replace("'", ''))
    print('wrote', os.path.normpath(OUT), os.path.getsize(OUT) // 1024, 'KB')

if __name__ == '__main__':
    main(sys.argv[1])
