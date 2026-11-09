// Checks the model's ground, weather and snow against what was measured, and against its own earlier results.
//   node validate.mjs [--years 3] [--update-baseline] [--json out.json]
// It runs the CPU model for a few years with no animals, then compares with observed.json (see build-observed.mjs for where each number comes from):
//   snow        peak and melt-out of the snowpack by elevation band, against the SNOTEL stations
//   climate     air temperature and precipitation by month and elevation band over the park, against PRISM; and how fast the air cools with height
//   stations    air temperature, ground temperature (5 cm) and precipitation at SNOTEL stations, month by month
//   books       the water and nitrogen ledgers close
// Every number has a target (centre and tolerance). A number inside it is "ok". One outside it that is no worse than the saved baseline.json is a "gap" (known, not new),
// and one worse than the baseline is "REGRESSED" and makes the script exit with an error. --update-baseline saves this run as the new baseline.
import fs from 'node:fs';
import { World } from '../../public/projects/yellowstone/sim.js';
import { climateRows, dayOfYear } from '../../public/projects/yellowstone/land.js';
import { TERRAIN } from '../../public/projects/yellowstone/terrain.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const YEARS = +opt('--years', 3), PER_YEAR = 1800;
const here = new URL('.', import.meta.url);
const OBS = JSON.parse(fs.readFileSync(new URL('observed.json', here)));
const basePath = new URL('baseline.json', here);
const BASE = fs.existsSync(basePath) ? JSON.parse(fs.readFileSync(basePath)) : {};

const w = new World({ seed: 1, prey: 0 }), L = w.land, n = L.n, size = n * n;
const bin = Buffer.from(TERRAIN.metres, 'base64'); const metres = new Float64Array(size); for (let i = 0; i < size; i++) metres[i] = bin.readUInt16LE(2 * i);
const lat = (r) => TERRAIN.latTop - ((TERRAIN.latTop - TERRAIN.latBottom) * (r + 0.5)) / n, lon = (c) => TERRAIN.west + ((TERRAIN.east - TERRAIN.west) * (c + 0.5)) / n;
const R = OBS.provenance.region, inRegion = (i) => { const r = (i / n) | 0, c = i % n, la = lat(r), lo = lon(c); return la >= R.latMin && la <= R.latMax && lo >= R.lonMin && lo <= R.lonMax; };
const region = []; for (let i = 0; i < size; i++) if (inRegion(i)) region.push(i);
const cellAt = (la, lo) => Math.round(((TERRAIN.latTop - la) / (TERRAIN.latTop - TERRAIN.latBottom)) * n - 0.5) * n + Math.round(((lo - TERRAIN.west) / (TERRAIN.east - TERRAIN.west)) * n - 0.5);
const edges = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365], mon = (d) => { for (let k = 0; k < 12; k++) if (d < edges[k + 1]) return k; return 11; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const rmse = (a, b) => { const d = a.map((v, k) => (b[k] == null ? null : (v - b[k]) ** 2)).filter((x) => x !== null); return Math.sqrt(mean(d)); };   // (months with no measurement are left out)
const have = (b, ms) => ms.filter((m) => b[m] != null);
const NOT_GEOTHERMAL = new Set(['Snake River Station', 'Two Ocean Plateau']);   // (Lewis Lake Divide's soil is warmed from below by hot springs: it is not climate)

// ---- the sets of cells
const climGroups = OBS.climate.map((b) => region.filter((i) => metres[i] >= b.lo && metres[i] < b.hi));
const snowGroups = OBS.snow.map((b) => region.filter((i) => metres[i] >= b.lo && metres[i] < b.hi));
const stn = OBS.stations.map((s) => ({ ...s, cell: cellAt(s.lat, s.lon) }));

// ---- the precipitation the model gives (what falls does not depend on the ground, so it is worked out directly; the air temperature is measured from the run below)
const air = { clim: climGroups.map(() => Array.from({ length: 12 }, () => ({ n: 0, a: 0 }))), stn: stn.map(() => Array.from({ length: 12 }, () => ({ n: 0, a: 0 }))) };
const ppt = { clim: climGroups.map(() => Array(12).fill(0)), stn: stn.map(() => Array(12).fill(0)) }, days = Array(12).fill(0);
for (let t = 0; t < PER_YEAR; t++) {
  const cl = climateRows(t, n, 60, 30, 1, w.latTop, w.latBottom), m = mon(dayOfYear(t, 60, 30)); days[m]++;
  const rain = (i) => L.rainChance * cl.wet * L.rainDepth * cl.wet * cl.rain[L.row[i]] * Math.max(0.1, 1 + cl.kOro * L.hKm[i]) * L.waterMm;
  climGroups.forEach((g, k) => { let p = 0; for (const i of g) p += rain(i); ppt.clim[k][m] += p / g.length; });
  stn.forEach((s, k) => { ppt.stn[k][m] += rain(s.cell); });
}

// ---- run the ground
const swe = snowGroups.map(() => new Map()), st = stn.map(() => Array.from({ length: 12 }, () => ({ n: 0, soil: 0, snow: 0, ice: 0 })));
let lake = -1; for (let i = 0; i < size; i++) if (L.lake[i] && L.water[i] > 100 && Math.abs(lat((i / n) | 0) - 44.45) < 0.08 && Math.abs(lon(i % n) + 110.37) < 0.1) { lake = i; break; }
const lakeIce = Array.from({ length: 12 }, () => ({ n: 0, ice: 0 }));
const t0 = performance.now();
for (let s = 1; s <= PER_YEAR * YEARS; s++) {
  w.step();
  if (s <= PER_YEAR) continue;   // the first year settles
  const m = mon(dayOfYear(s, 60, 30));
  climGroups.forEach((g, k) => { let a = 0, c = 0; for (let q = 0; q < g.length; q += 5) { a += L.air[g[q]]; c++; } const e = air.clim[k][m]; e.n++; e.a += a / c; });
  stn.forEach((o, k) => { const e = air.stn[k][m]; e.n++; e.a += L.air[o.cell]; });
  stn.forEach((o, k) => { const a = st[k][m]; a.n++; a.soil += L.soil[o.cell]; a.snow += L.snow[o.cell] * L.waterMm; a.ice += L.ice[o.cell] * L.waterMm; });
  if (lake >= 0) { lakeIce[m].n++; lakeIce[m].ice += L.ice[lake] * L.waterMm; }
  if (s % 60 === 30) { const d = Math.round(dayOfYear(s, 60, 30)); snowGroups.forEach((g, k) => { const v = g.map((i) => L.snow[i] * L.waterMm).sort((x, y) => x - y)[g.length >> 1]; const e = swe[k].get(d) ?? { s: 0, c: 0 }; e.s += v; e.c++; swe[k].set(d, e); }); }
}
const secs = (performance.now() - t0) / 1000;

// ---- the numbers
const M = [];   // { group, name, value, centre, tol, unit }
const add = (group, name, value, centre, tol, unit = '') => M.push({ group, name, value, centre, tol, unit });
const doyStr = (d) => { const x = new Date(Date.UTC(2021, 0, Math.round(d))); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`; };
OBS.snow.forEach((b, k) => {
  const days = [...swe[k].entries()].sort((x, y) => x[0] - y[0]).map(([d, e]) => ({ d, v: e.s / e.c }));
  const pk = days.reduce((q, p) => (p.v > q.v ? p : q), days[0]); let out = null; for (const p of days) if (p.d > pk.d && p.v < 5) { out = p.d; break; }
  const tag = `${b.lo}-${b.hi} m`;
  add('snow', `${tag} peak SWE / observed`, pk.v / b.peakMm, 1, 0.15, '');
  add('snow', `${tag} peak day error`, pk.d - b.peakDoy, 0, 14, 'days');
  add('snow', `${tag} melt-out day error`, (out ?? 400) - b.meltoutDoy, 0, 10, 'days');
});
OBS.climate.forEach((b, k) => {
  const tag = `${b.lo}-${b.hi} m`, a = air.clim[k].map((e) => e.a / e.n), p = ppt.clim[k], win = [10, 11, 0, 1];
  add('climate', `${tag} air temperature RMSE`, rmse(a, b.airC), 0, 1.0, 'K');
  add('climate', `${tag} air temperature bias`, mean(a) - mean(b.airC), 0, 0.5, 'K');
  add('climate', `${tag} precipitation, year / PRISM`, p.reduce((x, y) => x + y, 0) / b.pptMm.reduce((x, y) => x + y, 0), 1, 0.1, '');
  add('climate', `${tag} precipitation, Nov-Feb / PRISM`, win.reduce((x, m) => x + p[m], 0) / win.reduce((x, m) => x + b.pptMm[m], 0), 1, 0.1, '');
});
{ const lo = OBS.climate[0], hi = OBS.climate.at(-1), dz = (hi.meanElev - lo.meanElev) / 1000;
  for (const [nm, ms] of [['July', [6]], ['January', [0]]]) { const mo = (a, b) => mean(ms.map((m) => a[m] - b[m])); const ma = (k) => air.clim[k][ms[0]].a / air.clim[k][ms[0]].n; add('climate', `${nm} cooling with height (K per km)`, (ma(0) - ma(air.clim.length - 1)) / dz, (lo.airC[ms[0]] - hi.airC[ms[0]]) / dz, 0.8, 'K/km'); void mo; } }
stn.forEach((s, k) => {
  const a = air.stn[k].map((e) => e.a / e.n), mv = (f) => st[k].map((x) => f(x) / x.n);
  add('stations', `${s.name} (${s.elevM} m, model ${Math.round(metres[s.cell])} m) air RMSE`, rmse(a, s.airC), 0, 1.5, 'K');
  add('stations', `${s.name} precipitation, year / gauge`, ppt.stn[k].reduce((x, y) => x + y, 0) / s.pptMm.reduce((x, y) => x + y, 0), 1, 0.2, '');
  if (s.soil5C && NOT_GEOTHERMAL.has(s.name)) {
    const soil = mv((x) => x.soil), winter = [11, 0, 1, 2], july = 6;
    add('stations', `${s.name} ground RMSE (5 cm)`, rmse(soil, s.soil5C), 0, 1.5, 'K');
    const wm = have(s.soil5C, winter); if (wm.length) add('stations', `${s.name} ground under snow, Dec-Mar mean`, mean(wm.map((m) => soil[m])) - mean(wm.map((m) => s.soil5C[m])), 0, 1.0, 'K');
    if (s.soil5C[july] != null && s.airC[july] != null) add('stations', `${s.name} ground minus air, July`, (soil[july] - a[july]) - (s.soil5C[july] - s.airC[july]), 0, 1.5, 'K');
  }
});
{ const A = L.audit(0); add('books', 'water ledger error / water', A.waterError / A.water, 0, 1e-6, ''); add('books', 'nitrogen ledger error / nitrogen', A.nitrogenError / A.nitrogen, 0, 1e-6, ''); }

// ---- compare with the baseline
let regressed = 0, gaps = 0, ok = 0; const out = {};
const fmt = (v, u) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(1) : v.toFixed(2)) + (u ? ' ' + u : '');
let group = '';
for (const m of M) {
  out[m.name] = m.value;
  const dev = Math.abs(m.value - m.centre), base = BASE[m.name], baseDev = base === undefined ? undefined : Math.abs(base - m.centre);
  let status = dev <= m.tol ? 'ok' : baseDev === undefined || dev <= baseDev + 0.1 * m.tol ? 'gap' : 'REGRESSED';
  if (status === 'ok') ok++; else if (status === 'gap') gaps++; else regressed++;
  if (m.group !== group) { group = m.group; console.log(`\n${group.toUpperCase()}`); }
  console.log(`  ${status.padEnd(9)} ${m.name.padEnd(62)} ${fmt(m.value, m.unit).padStart(12)}   target ${fmt(m.centre, '')} ± ${fmt(m.tol, '')}${base === undefined ? '' : `   (baseline ${fmt(base, '')})`}`);
}
if (lake >= 0) console.log(`\nINFO  Yellowstone Lake ice, mm of water by month: ${lakeIce.map((x) => (x.ice / x.n).toFixed(0)).join(' ')}   (no measured series is in observed.json)`);
console.log(`\n${ok} ok, ${gaps} known gaps, ${regressed} regressed  (${YEARS} years in ${secs.toFixed(0)} s)`);
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 1));
if (args.includes('--update-baseline')) { fs.writeFileSync(basePath, JSON.stringify(out, null, 1)); console.log('baseline.json updated'); }
process.exit(regressed ? 1 : 0);
