// Builds observed.json: the real measurements the model is checked against. It is run once (and again if the data change); validate.mjs only reads the result.
//   node build-observed.mjs <dir>
// <dir> holds the downloads:
//   prism_grid.f32      PRISM 1991-2020 normals (https://prism.oregonstate.edu/normals/) on the model's 400 x 400 grid: 12 months of precipitation (mm), then 12 months of mean temperature (C)
//   snotel_median.json  per station: peak SWE (mm), its date and the melt-out date (NRCS SNOTEL, https://www.nrcs.usda.gov/resources/data-and-reports/snow-and-climate-monitoring)
//   snotel2/<id>.json   daily TAVG, STO:-2, STO:-8 and PREC for stations, from the NRCS AWDB REST service (https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data), Oct 2012 - Sep 2024
import fs from 'node:fs';
import path from 'node:path';
import { TERRAIN } from '../../public/projects/yellowstone/terrain.js';
import { dayOfYear } from '../../public/projects/yellowstone/land.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: node build-observed.mjs <dir>'); process.exit(1); }
const n = TERRAIN.n ?? 400, size = n * n;
const bin = Buffer.from(TERRAIN.metres, 'base64'); const metres = new Float64Array(size); for (let i = 0; i < size; i++) metres[i] = bin.readUInt16LE(2 * i);
const lat = (r) => TERRAIN.latTop - ((TERRAIN.latTop - TERRAIN.latBottom) * (r + 0.5)) / n, lon = (c) => TERRAIN.west + ((TERRAIN.east - TERRAIN.west) * (c + 0.5)) / n;
const REGION = { latMin: 44.0, latMax: 45.3, lonMin: -111.3, lonMax: -109.6 };   // the park, where the stations are
const region = []; for (let i = 0; i < size; i++) { const r = (i / n) | 0, c = i % n, la = lat(r), lo = lon(c); if (la >= REGION.latMin && la <= REGION.latMax && lo >= REGION.lonMin && lo <= REGION.lonMax) region.push(i); }
const raw = fs.readFileSync(path.join(dir, 'prism_grid.f32')); const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// PRISM by elevation band over the park region
const BANDS = [[1500, 2000], [2000, 2400], [2400, 2800], [2800, 3200]];
const climate = BANDS.map(([lo, hi]) => {
  const g = region.filter((i) => metres[i] >= lo && metres[i] < hi);
  const month = (off) => Array.from({ length: 12 }, (_, m) => mean(g.map((i) => f[(off + m) * size + i])));
  return { lo, hi, cells: g.length, meanElev: mean(g.map((i) => metres[i])), airC: month(12), pptMm: month(0) };
});

// SNOTEL snowpack by the bands the snow check uses
const SNOW_BANDS = [[2000, 2200], [2200, 2400], [2400, 2600], [2600, 2800], [2800, 3100]];
const doyOf = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5); };
const med = JSON.parse(fs.readFileSync(path.join(dir, 'snotel_median.json'))).filter((o) => o.peak_mm > 50);
const snow = SNOW_BANDS.map(([lo, hi]) => {
  const st = med.filter((o) => o.elev_m >= lo && o.elev_m < hi);
  return { lo, hi, stations: st.length, peakMm: mean(st.map((o) => o.peak_mm)), peakDoy: mean(st.map((o) => doyOf(o.peak_date))), meltoutDoy: mean(st.map((o) => doyOf(o.meltout_date))) };
});

// station climatologies from the daily records
const F2C = (x) => ((x - 32) * 5) / 9;
const edges = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const monthly = (rec, conv = (x) => x) => { const s = Array(12).fill(0), c = Array(12).fill(0); for (const [d, v] of Object.entries(rec || {})) if (v != null) { const m = +d.slice(5, 7) - 1; s[m] += conv(v); c[m]++; } return s.map((x, m) => (c[m] > 90 ? x / c[m] : null)); };
const monthlyPrecip = (prec) => { const tot = Array(12).fill(0); let prev = null; for (const d of Object.keys(prec).sort()) { const v = prec[d]; if (v == null) continue; if (prev != null && v >= prev && v - prev < 5) tot[+d.slice(5, 7) - 1] += (v - prev) * 25.4; prev = v; } return tot.map((x) => x / 11.9); };
const stationInfo = new Map(med.map((o) => [o.triplet.split(':')[0], o]));
const stations = [];
for (const file of fs.readdirSync(path.join(dir, 'snotel2')).sort()) {
  const id = file.replace('.json', ''), info = stationInfo.get(id); if (!info) continue;
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'snotel2', file)))[0].data, rec = {};
  for (const e of d) rec[e.stationElement.elementCode + (e.stationElement.heightDepth ?? '')] = Object.fromEntries(e.values.map((v) => [v.date, v.value]));
  const soil5 = rec['STO-2'] && Object.keys(rec['STO-2']).length > 1000 ? monthly(rec['STO-2'], F2C) : null, soil20 = rec['STO-8'] && Object.keys(rec['STO-8']).length > 1000 ? monthly(rec['STO-8'], F2C) : null;
  stations.push({ id, name: info.name, elevM: info.elev_m, lat: info.lat, lon: info.lon, airC: monthly(rec.TAVG, F2C), soil5C: soil5, soil20C: soil20, pptMm: monthlyPrecip(rec.PREC) });
}
const out = {
  provenance: { prism: 'PRISM 1991-2020 normals, averaged over the park region (lat 44.0-45.3, lon -111.3 to -109.6) by elevation band', snotelSnow: 'NRCS SNOTEL 1991-2020 median peak SWE and dates, stations grouped by elevation', snotelDaily: 'NRCS SNOTEL daily air temperature, soil temperature at 5 cm (STO:-2) and 20 cm (STO:-8) and water-year precipitation, 2012-10 to 2024-09, monthly means (precipitation: monthly totals)', built: new Date().toISOString().slice(0, 10), region: REGION },
  climate, snow, stations,
};
fs.writeFileSync(new URL('./observed.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('wrote observed.json:', climate.length, 'climate bands,', snow.length, 'snow bands,', stations.length, 'stations');
