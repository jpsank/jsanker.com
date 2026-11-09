// reduce an IGRA v2 sounding file to monthly means at 850 and 700 hPa, 1991-2020
import fs from 'node:fs'; import readline from 'node:readline';
const file = process.argv[2];
const LV = { 85000: '850', 70000: '700' };
const acc = Array.from({ length: 12 }, () => ({ 850: { t: 0, z: 0, n: 0 }, 700: { t: 0, z: 0, n: 0, u: 0, v: 0, nw: 0 }, soundings: 0 }));
let year = 0, month = 0, ok = false, lat = 0, lon = 0, stn = '';
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (line[0] === '#') { stn = line.slice(1, 12); year = +line.slice(13, 17); month = +line.slice(18, 20) - 1; ok = year >= 1991 && year <= 2020; lat = +line.slice(55, 62) / 1e4; lon = +line.slice(63, 71) / 1e4; if (ok) acc[month].soundings++; continue; }
  if (!ok) continue;
  const press = +line.slice(9, 15), key = LV[press]; if (!key) continue;
  const gph = +line.slice(16, 21), temp = +line.slice(22, 27), wdir = +line.slice(40, 45), wspd = +line.slice(46, 51);
  const a = acc[month][key];
  if (temp > -9000 && gph > -9000) { a.t += temp / 10; a.z += gph; a.n++; }
  if (key === '700' && wdir >= 0 && wdir <= 360 && wspd >= 0 && wspd < 900) { const sp = wspd / 10, th = (wdir * Math.PI) / 180; a.u += -sp * Math.sin(th); a.v += -sp * Math.cos(th); a.nw++; }   // (the direction the wind blows from; u east, v north)
}
const out = { station: stn, lat, lon, period: '1991-2020', months: acc.map((m, i) => ({ month: i + 1, soundings: m.soundings, t850: m[850].t / m[850].n, z850: m[850].z / m[850].n, t700: m[700].t / m[700].n, z700: m[700].z / m[700].n, u700: m[700].u / m[700].nw, v700: m[700].v / m[700].nw, n: m[700].n })) };
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
console.log(stn, lat, lon); for (const m of out.months) console.log(m.month, m.soundings, 'T850', m.t850.toFixed(1), 'z850', m.z850.toFixed(0), 'T700', m.t700.toFixed(1), 'z700', m.z700.toFixed(0), 'wind u,v', m.u700.toFixed(1), m.v700.toFixed(1));
