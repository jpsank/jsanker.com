#!/usr/bin/env python3
"""Build public/projects/yellowstone/terrain.js: the ground of the Greater Yellowstone area, from real elevation data.

Source: the public "Terrain Tiles" (Terrarium encoding) on AWS Open Data, https://registry.opendata.aws/terrain-tiles/ , which are
assembled from public elevation data (USGS 3DEP and NASA SRTM among them). Only the Python standard library is needed.

    python3 scripts/yellowstone/build-terrain.py CACHE_DIR

CACHE_DIR holds the downloaded tiles (about 70 KB each, around fifty of them) so a second run needs no network. The map is a square 600 km on a side
centred on the park, resampled to 400 x 400 cells (1.5 km each), top row north. There is no lake layer: the elevation data shows each lake as flat ground, so
the simulation's own water pools there where the ground is flat and low, and the lakes are shallow and approximate.
"""
import base64, math, os, struct, sys, urllib.request, zlib

N = 400                        # cells across
SIDE_KM = 600.0                # the map is this wide and this tall
CENTRE = (44.6, -110.5)        # latitude, longitude
ZOOM = 8
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'projects', 'yellowstone', 'terrain.js')

def tile_xy(lat, lon, z=ZOOM):
    """Position in tile units (floats) of a latitude and longitude."""
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y

def read_png(path):
    """Decode an 8-bit RGB, non-interlaced PNG: returns (width, height, rows of bytes)."""
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat, w = 8, b'', None
    while pos < len(data):
        ln, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        if kind == b'IHDR': w, h, depth, ctype, _, _, inter = struct.unpack('>IIBBBBB', body); assert depth == 8 and ctype == 2 and inter == 0
        if kind == b'IDAT': idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat); bpp = 3; stride = w * bpp
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]; line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else b if pb <= pc else c
                line[i] = (line[i] + pr) & 255
        rows.append(line); prev = line
    return w, h, rows

def main(cache):
    os.makedirs(cache, exist_ok=True)
    km_lat, km_lon = 111.2, 111.32 * math.cos(math.radians(CENTRE[0]))
    dlat, dlon = SIDE_KM / 2 / km_lat, SIDE_KM / 2 / km_lon
    top, bottom, west, east = CENTRE[0] + dlat, CENTRE[0] - dlat, CENTRE[1] - dlon, CENTRE[1] + dlon
    x0, y0 = tile_xy(top, west); x1, y1 = tile_xy(bottom, east)
    tiles = {}
    for tx in range(int(x0), int(x1) + 1):
        for ty in range(int(y0), int(y1) + 1):
            f = os.path.join(cache, f'{ZOOM}_{tx}_{ty}.png')
            if not os.path.exists(f):
                print('fetching', tx, ty); urllib.request.urlretrieve(URL.format(z=ZOOM, x=tx, y=ty), f)
            tiles[(tx, ty)] = read_png(f)
    def height(px, py):   # metres at a position in tile units (nearest source pixel)
        tx, ty = int(px), int(py); w, h, rows = tiles[(tx, ty)]
        i, j = min(w - 1, int((px - tx) * w)), min(h - 1, int((py - ty) * h)); r = rows[j]
        return r[i * 3] * 256 + r[i * 3 + 1] + r[i * 3 + 2] / 256 - 32768
    SUB = 4   # samples per cell side: each cell is the mean of 16 samples
    elev = []
    for r in range(N):
        for c in range(N):
            tot = 0.0
            for a in range(SUB):
                for b in range(SUB):
                    lat = top - (top - bottom) * (r + (a + 0.5) / SUB) / N
                    lon = west + (east - west) * (c + (b + 0.5) / SUB) / N
                    px, py = tile_xy(lat, lon)
                    tot += height(px, py)
            elev.append(tot / (SUB * SUB))
    lo, hi = min(elev), max(elev)
    print(f'elevation {lo:.0f} to {hi:.0f} m, mean {sum(elev) / len(elev):.0f} m')
    metres = base64.b64encode(b''.join(struct.pack('<H', max(0, min(65535, round(e)))) for e in elev)).decode()
    with open(OUT, 'w') as f:
        f.write(f"""// The ground of the Greater Yellowstone area, 600 km square (1.5 km cells), from real elevation data. Built by scripts/yellowstone/build-terrain.py
// from the public Terrain Tiles on AWS Open Data (USGS 3DEP and NASA SRTM among their sources); do not edit by hand.
// `metres`: {N} x {N} elevations in metres above sea level (16-bit, little-endian), top row north.
export const TERRAIN = {{
  n: {N}, sideKm: {SIDE_KM:g}, latTop: {top:.4f}, latBottom: {bottom:.4f}, west: {west:.4f}, east: {east:.4f},
  metres: '{metres}',
}};
""")
    print('wrote', os.path.normpath(OUT), os.path.getsize(OUT) // 1024, 'KB')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'dem-cache')
