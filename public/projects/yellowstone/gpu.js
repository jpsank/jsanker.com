// The graphics card side of Yellowstone (WebGPU compute shaders). Two jobs, both done there when the browser has WebGPU and by sim.js / land.js on the CPU when it does not:
//
//   the ground   grass, water, snow, nitrogen and ground temperature on every cell: a handful of passes over the whole grid per step, one thread per cell. The numbers stay
//                on the card; each step the animals get a copy of grass, water, snow and ground temperature back, and what they did to the ground (grass eaten, nitrogen
//                dropped, heat given off) goes up as a small delta.
//   the brains   every animal's network, run for all of them at once. A brain is 7,092 numbers painted by the animal's genome (the CPPN); those are painted on the card too, the
//                moment an animal is born, and kept there as 16-bit floats. Each step one workgroup per animal builds its 9 x 9 view, runs the network and picks its step.
//
// The arithmetic is the same as land.js and sim.js, in 32-bit floats instead of 64-bit, so a run is repeatable on the same machine and card but not identical to a CPU run.
import { BRAIN, PROGRAM, encodeProgram, packNet, connectionTable } from './sim.js';

const WG = 256;                 // threads per workgroup in the ground passes
const SLOT_CAP = 200000;        // never more brains than this
const EDGE0 = 3 + 4 * PROGRAM.maxNodes;   // where a program's connections start (see encodeProgram)
const OFF = { w0: 0, b0: 0, w1: 0, b1: 0 };   // where each layer starts in a brain, in 16-bit numbers
{
  const [L0, L1] = BRAIN.layers;
  OFF.w0 = 0; OFF.b0 = L0.ni * L0.nj; OFF.w1 = OFF.b0 + L0.nj; OFF.b1 = OFF.w1 + L1.ni * L1.nj;
}

/* ------------------------------------------------------------------ the ground */

const LAND_FIELDS = [
  ['n', 'u32'], ['size', 'u32'], ['raining', 'f32'], ['rainD', 'f32'], ['lag', 'f32'], ['conduct', 'f32'], ['sunWarm', 'f32'], ['heatGain', 'f32'],
  ['waterHeat', 'f32'], ['waterHeatMax', 'f32'], ['meltRate', 'f32'], ['deposit', 'f32'], ['evap', 'f32'], ['seep', 'f32'], ['floodSeep', 'f32'], ['seepMax', 'f32'],
  ['flow', 'f32'], ['creep', 'f32'], ['leach', 'f32'], ['outletRate', 'f32'], ['regrow', 'f32'], ['gMax', 'f32'], ['waterPer', 'f32'], ['nPer', 'f32'],
];
const PARAM_BYTES = LAND_FIELDS.length * 4;
const ROWS = 1024;   // vec4s in the per-row table: two for every row (so maps up to 512 rows)

// state: A = (grass, water, snow, ground temperature) and B = nitrogen, per cell, each kept twice (ping-pong) for the passes that read neighbours.
// stat = per cell two vec4s: (height, chill, is-outlet, 0) and the slope normal (east, north, up, 0).
// rows = per row two vec4s: (sun up, east, north, flat-ground light) and (air temperature, rain share, 0, 0).
const PRELUDE = /* wgsl */ `
struct Params { ${LAND_FIELDS.map(([k, t]) => `${k}: ${t},`).join(' ')} }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<uniform> rows: array<vec4<f32>, ${ROWS}>;
var<workgroup> scratch: array<f32, ${WG}>;

fn wgSum(t: u32, v: f32) -> f32 {
  scratch[t] = v;
  workgroupBarrier();
  for (var s = ${WG / 2}u; s > 0u; s = s >> 1u) {
    if (t < s) { scratch[t] = scratch[t] + scratch[t + s]; }
    workgroupBarrier();
  }
  let total = scratch[0];
  workgroupBarrier();
  return total;
}
fn cap(w: f32) -> f32 { return 1.0 + P.waterHeat * min(P.waterHeatMax, w); }
fn lightAt(r: u32, nm: vec4<f32>) -> f32 {
  let rw = rows[2u * r];
  if (rw.x <= 0.0) { return 0.0; }
  let d = nm.x * rw.y + nm.y * rw.z + nm.z * rw.x;
  return 0.9 * max(d, 0.0) + 0.1 * rw.x;
}
fn nbr(i: u32, d: u32) -> u32 {
  let n = P.n;
  let r = i / n;
  let c = i - r * n;
  if (d == 0u) { return select(i, i - n, r > 0u); }
  if (d == 1u) { return select(i, i + 1u, c + 1u < n); }
  if (d == 2u) { return select(i, i + n, r + 1u < n); }
  return select(i, i - 1u, c > 0u);
}
fn moisture(w: f32) -> f32 {
  if (w <= 0.05) { return 0.0; }
  if (w < 0.3) { return (w - 0.05) / 0.25; }
  if (w <= 1.5) { return 1.0; }
  if (w < 2.5) { return 2.5 - w; }
  return 0.0;
}
`;

const MAIN = '@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) t: u32, @builtin(workgroup_id) wg: vec3<u32>)';

// what the animals did last step lands on the ground
const APPLY = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> sB: array<f32>;
@group(0) @binding(4) var<storage, read> dl: array<vec4<f32>>;
${MAIN} {
  let i = g.x;
  if (i >= P.size) { return; }
  var a = sA[i];
  let d = dl[i];
  a.x = max(0.0, a.x - d.x);
  a.w = a.w + P.heatGain * d.z / cap(a.y);
  sA[i] = a;
  sB[i] = sB[i] + d.y;
}`;

// ground temperature: closes in on the air, and on the cells around it
const SOIL = /* wgsl */ `
@group(0) @binding(2) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> oA: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> stat: array<vec4<f32>>;
${MAIN} {
  let i = g.x;
  if (i >= P.size) { return; }
  let n = P.n;
  let r = i / n;
  let c = i - r * n;
  let a = sA[i];
  let st = stat[2u * i];
  let nm = stat[2u * i + 1u];
  let rw = rows[2u * r];
  let rw2 = rows[2u * r + 1u];
  let r0 = select(r, r - 1u, r > 0u);
  let r1 = select(r, r + 1u, r + 1u < n);
  let c0 = select(c, c - 1u, c > 0u);
  let c1 = select(c, c + 1u, c + 1u < n);
  let around = sA[r0 * n + c0].w + sA[r0 * n + c].w + sA[r0 * n + c1].w + sA[r * n + c0].w + sA[r * n + c1].w + sA[r1 * n + c0].w + sA[r1 * n + c].w + sA[r1 * n + c1].w;
  let light = lightAt(r, nm);
  let s = a.w;
  let T = s + (P.lag * (rw2.x - st.y + P.sunWarm * (light - rw.w) - s) + P.conduct / 8.0 * around - P.conduct * s) / cap(a.y);
  oA[i] = vec4<f32>(a.x, a.y, a.z, T);
}`;

// rain or snow, snowmelt, nitrogen in the rain, evaporation, soaking away
const WEATHER = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> sB: array<f32>;
@group(0) @binding(4) var<storage, read> stat: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> acc: array<f32>;
${MAIN} {
  let i = g.x;
  var evapped = 0.0;
  var seeped = 0.0;
  if (i < P.size) {
    let r = i / P.n;
    var a = sA[i];
    let st = stat[2u * i];
    let nm = stat[2u * i + 1u];
    let rw2 = rows[2u * r + 1u];
    var w = a.y;
    var sn = a.z;
    var nn = sB[i];
    let air = rw2.x - st.y;
    if (P.raining > 0.5) {
      let d = P.rainD * rw2.y;
      if (air < 1.0) { sn = sn + d; } else { w = w + d; }
    }
    if (sn > 0.0 && a.w > 0.0) {
      let m = min(sn, P.meltRate * a.w);
      sn = sn - m;
      w = w + m;
    }
    nn = nn + P.deposit;
    let light = lightAt(r, nm);
    let e = P.evap * (0.25 + 0.75 * light);
    let warm = 0.6 + 0.4 * min(1.5, max(0.0, air / 15.0));
    let x = min(w, e * warm);
    w = w - x;
    evapped = x;
    let y = min(min(w * P.seep + P.floodSeep * max(0.0, w - 1.5), P.seepMax), w);
    w = w - y;
    seeped = y;
    a.y = w;
    a.z = sn;
    sA[i] = a;
    sB[i] = nn;
  }
  let te = wgSum(t, evapped);
  let ts = wgSum(t, seeped);
  if (t == 0u) { acc[wg.x * 8u] = acc[wg.x * 8u] + te; acc[wg.x * 8u + 1u] = acc[wg.x * 8u + 1u] + ts; }
}`;

// water runs to lower neighbours: first how much leaves each cell in each direction...
const FLUX = /* wgsl */ `
@group(0) @binding(2) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> flux: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> stat: array<vec4<f32>>;
${MAIN} {
  let i = g.x;
  if (i >= P.size) { return; }
  let w = sA[i].y;
  var f = vec4<f32>(0.0);
  if (w > 0.0) {
    let s = stat[2u * i].x + w;
    for (var d = 0u; d < 4u; d = d + 1u) {
      let j = nbr(i, d);
      let diff = s - (stat[2u * j].x + sA[j].y);
      if (diff > 0.0) { f[d] = P.flow * diff; }
    }
    let total = f.x + f.y + f.z + f.w;
    if (total > 0.0) { f = f * select(1.0, w / total, total > w); } else { f = vec4<f32>(0.0); }
  }
  flux[i] = f;
}`;

// ...then each cell loses what it sends and gains what its neighbours send, nitrogen riding along with the water
const GATHER = /* wgsl */ `
@group(0) @binding(2) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> sB: array<f32>;
@group(0) @binding(4) var<storage, read_write> oA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> oB: array<f32>;
@group(0) @binding(6) var<storage, read> flux: array<vec4<f32>>;
${MAIN} {
  let i = g.x;
  if (i >= P.size) { return; }
  let n = P.n;
  let r = i / n;
  let c = i - r * n;
  var a = sA[i];
  let w = a.y;
  let nit = sB[i];
  let fo = flux[i];
  let outW = fo.x + fo.y + fo.z + fo.w;
  var inW = 0.0;
  var inN = 0.0;
  if (r > 0u) { let j = i - n; let f = flux[j].z; if (f > 0.0) { inW = inW + f; inN = inN + f * sB[j] / sA[j].y; } }
  if (r + 1u < n) { let j = i + n; let f = flux[j].x; if (f > 0.0) { inW = inW + f; inN = inN + f * sB[j] / sA[j].y; } }
  if (c > 0u) { let j = i - 1u; let f = flux[j].y; if (f > 0.0) { inW = inW + f; inN = inN + f * sB[j] / sA[j].y; } }
  if (c + 1u < n) { let j = i + 1u; let f = flux[j].w; if (f > 0.0) { inW = inW + f; inN = inN + f * sB[j] / sA[j].y; } }
  a.y = max(0.0, w - outW + inW);
  var nn = nit + inN;
  if (w > 0.0) { nn = nn - nit * (outW / w); }
  oA[i] = a;
  oB[i] = max(0.0, nn);
}`;

// the river takes a share of what has run to the edges; nitrogen creeps to the neighbours and a little is washed out
const CREEP = /* wgsl */ `
@group(0) @binding(2) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> sB: array<f32>;
@group(0) @binding(4) var<storage, read_write> oA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> oB: array<f32>;
@group(0) @binding(6) var<storage, read> stat: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> acc: array<f32>;
fn keep(j: u32) -> f32 { return select(1.0, 1.0 - P.outletRate, stat[2u * j].z > 0.5); }
${MAIN} {
  let i = g.x;
  var riverW = 0.0;
  var riverN = 0.0;
  var leached = 0.0;
  if (i < P.size) {
    var a = sA[i];
    let k = keep(i);
    let v = sB[i] * k;
    riverW = a.y * (1.0 - k);
    riverN = sB[i] * (1.0 - k);
    let m = v * P.creep * 0.25;
    leached = v * P.leach;
    var nn = v - leached - 4.0 * m;
    for (var d = 0u; d < 4u; d = d + 1u) {
      let j = nbr(i, d);
      if (j == i) { nn = nn + m; } else { nn = nn + sB[j] * keep(j) * P.creep * 0.25; }
    }
    a.y = a.y - riverW;
    oA[i] = a;
    oB[i] = nn;
  }
  let t1 = wgSum(t, riverW);
  let t2 = wgSum(t, riverN);
  let t3 = wgSum(t, leached);
  if (t == 0u) {
    let o = wg.x * 8u;
    acc[o + 2u] = acc[o + 2u] + t1; acc[o + 3u] = acc[o + 3u] + t2; acc[o + 4u] = acc[o + 4u] + t3;
  }
}`;

// grass: dying back, growing (drinking and taking nitrogen), seed blowing in
const GROW = /* wgsl */ `
@group(0) @binding(2) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> sB: array<f32>;
@group(0) @binding(4) var<storage, read_write> oA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> oB: array<f32>;
@group(0) @binding(6) var<storage, read> stat: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> dl: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> acc: array<f32>;
${MAIN} {
  let i = g.x;
  var drunk = 0.0;
  if (i < P.size) {
    let r = i / P.n;
    var a = sA[i];
    let g0 = a.x;
    var w = a.y;
    let tl = a.w;
    var nit = sB[i];
    let m = moisture(w);
    var gr = g0;
    let lose = g0 * (0.0005 * (1.0 + 0.05 * max(0.0, 12.0 - tl)) + 0.004 * (1.0 - m));
    if (lose > 0.0) { gr = gr - lose; nit = nit + lose * P.nPer; }
    if (dl[i].w < 0.5 && a.z <= 0.02) {
      let nb = (sA[nbr(i, 0u)].x + sA[nbr(i, 1u)].x + sA[nbr(i, 2u)].x + sA[nbr(i, 3u)].x) / 4.0;
      let base = g0 + 0.5 * nb + 0.002;
      let light = lightAt(r, stat[2u * i + 1u]) * clamp(tl / 12.0, 0.0, 1.0);
      var grow = P.regrow * light * m * (nit / (nit + 0.03)) * base * (1.0 - g0 / P.gMax);
      grow = min(grow, min(w / P.waterPer, nit / P.nPer));
      if (grow > 0.0) {
        gr = gr + grow;
        w = w - grow * P.waterPer;
        drunk = grow * P.waterPer;
        nit = nit - grow * P.nPer;
      }
    }
    a.x = gr;
    a.y = w;
    oA[i] = a;
    oB[i] = nit;
  }
  let td = wgSum(t, drunk);
  if (t == 0u) { acc[wg.x * 8u + 5u] = acc[wg.x * 8u + 5u] + td; }
}`;

/* ------------------------------------------------------------------ the brains */

const BRAIN_WGSL = /* wgsl */ `
struct BP { count: u32, n: u32, a: u32, b: u32, climb: f32, wade: f32, snowCost: f32, snowCap: f32 }
@group(0) @binding(0) var<uniform> bp: BP;
@group(0) @binding(1) var<uniform> rows: array<vec4<f32>, ${ROWS}>;
@group(0) @binding(2) var<storage, read> an: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> cell: array<u32>;
@group(0) @binding(4) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> stat: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> wts: array<u32>;
@group(0) @binding(7) var<storage, read_write> res: array<u32>;

const GREY: f32 = 0.0019607843;
const WORDS: u32 = ${BRAIN.words}u;
var<workgroup> inp: array<f32, 243>;
var<workgroup> h1: array<f32, 27>;
var<workgroup> ov: array<f32, 18>;

fn unh(base: u32, idx: u32) -> f32 {
  let p = unpack2x16float(wts[base + (idx >> 1u)]);
  return select(p.x, p.y, (idx & 1u) == 1u);
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) t: u32) {
  let a = wg.y * 65535u + wg.x;
  let valid = a < bp.count;
  var rec = vec4<u32>(0u);
  if (valid) { rec = an[a]; }
  let canAct = valid && (rec.x >> 31u) != 0u;
  let n = bp.n;
  let ni = i32(n);
  let pos = rec.y;
  let r = i32(pos / n);
  let c = i32(pos % n);
  let far = 0.6 + 0.4 * rows[2u * u32(r)].w;

  // what it sees: 9 x 9 cells, three numbers each
  if (canAct) {
    for (var k = t; k < 81u; k = k + 64u) {
      let ci = i32(k / 9u);
      let cj = i32(k % 9u);
      let rr = r + ci - 4;
      let cc = c + cj - 4;
      var col = vec3<f32>(-0.5, -0.5, -0.5);
      if (rr >= 0 && rr < ni && cc >= 0 && cc < ni) {
        let who = cell[u32(rr) * n + u32(cc)];
        if (who != 0u) {
          let o = an[who - 1u];
          col = vec3<f32>(0.5, bitcast<f32>(o.z), bitcast<f32>(o.w));
        } else {
          let gr = min(1.0, sA[u32(rr) * n + u32(cc)].x / 4.0);
          col = vec3<f32>(GREY, GREY, GREY) + (vec3<f32>(-0.5, 0.5, -0.5) - vec3<f32>(GREY, GREY, GREY)) * gr;
        }
      }
      let f = select(far, 1.0, abs(ci - 4) <= 1 && abs(cj - 4) <= 1);
      let o3 = vec3<f32>(GREY, GREY, GREY) + (col - vec3<f32>(GREY, GREY, GREY)) * f;
      inp[k * 3u] = o3.x;
      inp[k * 3u + 1u] = o3.y;
      inp[k * 3u + 2u] = o3.z;
    }
  }
  workgroupBarrier();

  let base = (rec.x & 0x7fffffffu) * WORDS;
  if (canAct && t < 27u) {
    var s = unh(base, ${OFF.b0}u + t);
    for (var i = 0u; i < 243u; i = i + 1u) { s = s + unh(base, ${OFF.w0}u + i * 27u + t) * inp[i]; }
    h1[t] = tanh(s);
  }
  workgroupBarrier();
  if (canAct && t < 18u) {
    var s = unh(base, ${OFF.b1}u + t);
    for (var i = 0u; i < 27u; i = i + 1u) { s = s + unh(base, ${OFF.w1}u + i * 18u + t) * h1[i]; }
    ov[t] = s;
  }
  workgroupBarrier();

  // which step: wanting a step twice as much cancels a step that costs twice as much
  if (t == 0u && valid) {
    if (!canAct) {
      res[a] = 0xffffffffu;
    } else {
      let here = stat[2u * pos].x;
      var best = 4u;
      var bv = -3.0e38;
      for (var k = 0u; k < 9u; k = k + 1u) {
        let di = i32(k / 3u) - 1;
        let dj = i32(k % 3u) - 1;
        let rr = r + di;
        let cc = c + dj;
        if (rr < 0 || rr >= ni || cc < 0 || cc >= ni) { continue; }
        let j = u32(rr) * n + u32(cc);
        let land = sA[j];
        let cost = 0.05 + 0.1 * f32(abs(di) + abs(dj)) / 2.0 + bp.climb * max(0.0, stat[2u * j].x - here) + bp.wade * min(3.0, land.y) + bp.snowCost * min(bp.snowCap, land.z);
        let v = ov[k * 2u] - log(cost);
        if (v > bv) { bv = v; best = k; }
      }
      var bk = 0u;
      var bb = -3.0e38;
      for (var k = 0u; k < 9u; k = k + 1u) {
        if (ov[k * 2u + 1u] > bb) { bb = ov[k * 2u + 1u]; bk = k; }
      }
      res[a] = best | (bk << 4u);
    }
  }
}`;

// the animals' effects arrive as a short list of (cell, grass eaten, nitrogen dropped, heat given off, standing there) and are spread out over a zeroed grid
const DELTAS = /* wgsl */ `
@group(0) @binding(0) var<uniform> dp: vec4<u32>;
@group(0) @binding(2) var<storage, read> tIdx: array<u32>;
@group(0) @binding(3) var<storage, read> tVal: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> dl: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x < dp.x) { dl[tIdx[g.x]] = tVal[g.x]; }
}`;

const SCATTER = /* wgsl */ `
struct BP { count: u32, n: u32, a: u32, b: u32, climb: f32, wade: f32, snowCost: f32, snowCap: f32 }
@group(0) @binding(0) var<uniform> bp: BP;
@group(0) @binding(2) var<storage, read> an: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read_write> cell: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x < bp.count) { cell[an[g.x].y] = g.x + 1u; }
}`;

// paints the weights of newborn brains: one thread per pair of numbers, evaluating the genome's CPPN for each
const CPPN_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> cp: vec4<u32>;
@group(0) @binding(2) var<storage, read> prog: array<u32>;
@group(0) @binding(3) var<storage, read> born: array<u32>;
@group(0) @binding(4) var<storage, read> conn: array<f32>;
@group(0) @binding(5) var<storage, read_write> wts: array<u32>;
const WORDS: u32 = ${BRAIN.words}u;
const PROGW: u32 = ${PROGRAM.words}u;
const EDGE0: u32 = ${EDGE0}u;

fn actv(k: u32, x: f32) -> f32 {
  if (k == 0u) { return 1.0 / (1.0 + exp(-x)); }
  if (k == 1u) { return max(x, 0.0); }
  if (k == 2u) { return tanh(x); }
  if (k == 3u) { return sin(x); }
  return cos(x);
}
fn eval(pb: u32, g: u32) -> f32 {
  var vals: array<f32, 64>;
  for (var q = 0u; q < 6u; q = q + 1u) { vals[q] = conn[g * 6u + q]; }
  let count = prog[pb];
  for (var k = 0u; k < count; k = k + 1u) {
    let nd = pb + 3u + 4u * k;
    var sum = bitcast<f32>(prog[nd + 1u]);
    for (var j = prog[nd + 2u]; j < prog[nd + 3u]; j = j + 1u) {
      let e = pb + EDGE0 + 2u * j;
      sum = sum + bitcast<f32>(prog[e + 1u]) * vals[prog[e]];
    }
    vals[8u + k] = actv(prog[nd], sum);
  }
  return vals[prog[pb + 1u]];
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let b = gid.y;
  let p = gid.x;
  if (b >= cp.x || p >= WORDS) { return; }
  let pb = b * PROGW;
  wts[born[b] * WORDS + p] = pack2x16float(vec2<f32>(eval(pb, 2u * p), eval(pb, 2u * p + 1u)));
}`;

/* ------------------------------------------------------------------ the device */

const STORE = 0x80 | 0x4 | 0x8;   // GPUBufferUsage.STORAGE | COPY_SRC | COPY_DST (spelled out so this file loads where WebGPU does not exist)

/** Ask the browser for a graphics card. Resolves to null when there is none (the caller then runs everything on the CPU). */
export async function createGpu() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const want = Math.min(adapter.limits.maxStorageBufferBindingSize, adapter.limits.maxBufferSize, 1 << 30);
    const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: want, maxBufferSize: want } });
    const g = new Gpu(device, adapter);
    await g.compile();
    return g;
  } catch (e) {
    console.warn('WebGPU is not available here:', e);
    return null;
  }
}

class Gpu {
  constructor(device, adapter) {
    this.device = device;
    this.adapter = adapter;
    this.maxSlots = Math.min(SLOT_CAP, Math.floor(Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / (BRAIN.words * 4)));
    this.errors = [];
    device.addEventListener?.('uncapturederror', (ev) => { this.errors.push(ev.error.message); console.error('WebGPU:', ev.error.message); });
  }

  async compile() {
    const d = this.device;
    const kinds = { u: 'uniform', r: 'read-only-storage', w: 'storage' };
    const make = async (name, code, binds) => {
      const module = d.createShaderModule({ code, label: name });
      const info = await module.getCompilationInfo();
      const bad = info.messages.filter((m) => m.type === 'error');
      if (bad.length) throw new Error(`${name}: ` + bad.map((m) => `line ${m.lineNum}: ${m.message}`).join('; '));
      const bgl = d.createBindGroupLayout({ entries: Object.entries(binds).map(([b, k]) => ({ binding: +b, visibility: 4, buffer: { type: kinds[k] } })) });
      const pipeline = d.createComputePipeline({ label: name, layout: d.createPipelineLayout({ bindGroupLayouts: [bgl] }), compute: { module, entryPoint: 'main' } });
      return { name, bgl, pipeline, binds };
    };
    const U2 = { 0: 'u', 1: 'u' };
    this.pass = {
      apply: await make('apply', PRELUDE + APPLY, { ...U2, 2: 'w', 3: 'w', 4: 'r' }),
      soil: await make('soil', PRELUDE + SOIL, { ...U2, 2: 'r', 3: 'w', 4: 'r' }),
      weather: await make('weather', PRELUDE + WEATHER, { ...U2, 2: 'w', 3: 'w', 4: 'r', 5: 'w' }),
      flux: await make('flux', PRELUDE + FLUX, { ...U2, 2: 'r', 3: 'w', 4: 'r' }),
      gather: await make('gather', PRELUDE + GATHER, { ...U2, 2: 'r', 3: 'r', 4: 'w', 5: 'w', 6: 'r' }),
      creep: await make('creep', PRELUDE + CREEP, { ...U2, 2: 'r', 3: 'r', 4: 'w', 5: 'w', 6: 'r', 7: 'w' }),
      grow: await make('grow', PRELUDE + GROW, { ...U2, 2: 'r', 3: 'r', 4: 'w', 5: 'w', 6: 'r', 7: 'r', 8: 'w' }),
      brain: await make('brain', BRAIN_WGSL, { 0: 'u', 1: 'u', 2: 'r', 3: 'r', 4: 'r', 5: 'r', 6: 'r', 7: 'w' }),
      scatter: await make('scatter', SCATTER, { 0: 'u', 2: 'r', 3: 'w' }),
      deltas: await make('deltas', DELTAS, { 0: 'u', 2: 'r', 3: 'r', 4: 'w' }),
      cppn: await make('cppn', CPPN_WGSL, { 0: 'u', 2: 'r', 3: 'r', 4: 'r', 5: 'w' }),
    };
    const table = connectionTable();
    this.conn = d.createBuffer({ size: table.byteLength, usage: STORE, label: 'conn' });
    d.queue.writeBuffer(this.conn, 0, table);
  }

  /** The per-world half: buffers for one World's ground and animals. */
  attach(world) { return new GpuSim(this, world); }
}

/* ------------------------------------------------------------------ one world on the card */

class GpuSim {
  constructor(g, world) {
    const d = (this.d = g.device);
    this.g = g;
    this.w = world;
    const L = (this.L = world.land);
    if (2 * L.n > ROWS) throw new Error('the map is too big for the GPU row table');
    const n = (this.n = L.n), size = (this.size = n * n);
    this.groups = Math.ceil(size / WG);
    L.dev = this;   // the ground now collects the animals' effects as deltas
    this.dl = new Float32Array(size * 4);
    this.seen = new Uint8Array(size);
    this.touched = [];

    const buf = (bytes, usage = STORE, label) => d.createBuffer({ size: Math.max(16, (bytes + 3) & ~3), usage, label });
    const MAP_READ = 0x1 | 0x8;   // MAP_READ | COPY_DST
    const UNI = 0x40 | 0x8;       // UNIFORM | COPY_DST
    this.A = [buf(size * 16, STORE, 'A0'), buf(size * 16, STORE, 'A1')];
    this.B = [buf(size * 4, STORE, 'B0'), buf(size * 4, STORE, 'B1')];
    this.pa = 0; this.pb = 0;
    this.stat = buf(size * 32, STORE, 'stat');
    this.dlBuf = buf(size * 16, STORE, 'deltas');
    this.flux = buf(size * 16, STORE, 'flux');
    this.acc = buf(this.groups * 8 * 4, STORE, 'ledger');
    d.queue.writeBuffer(this.acc, 0, new Float32Array(this.groups * 8));
    this.P = buf(PARAM_BYTES, UNI, 'params');
    this.rows = buf(ROWS * 16, UNI, 'rows');
    this.readA = buf(size * 16, MAP_READ, 'readA');
    this.readB = buf(size * 4, MAP_READ, 'readB');
    this.readAcc = buf(this.groups * 8 * 4, MAP_READ, 'readAcc');
    this.paramData = new DataView(new ArrayBuffer(PARAM_BYTES));
    this.rowData = new Float32Array(ROWS * 4);
    this.cell = buf(size * 4, STORE, 'cells');   // which animal (if any) stands on each cell, for the brains' eyes

    // the things that never change: height, how much colder than the valley floor, outlet, and the slope normal
    const st = new Float32Array(size * 8);
    for (let i = 0; i < size; i++) {
      st[8 * i] = L.elev[i]; st[8 * i + 1] = L.chill[i]; st[8 * i + 2] = L.outlet[i];
      st[8 * i + 4] = L.nE[i]; st[8 * i + 5] = L.nN[i]; st[8 * i + 6] = L.nU[i];
    }
    d.queue.writeBuffer(this.stat, 0, st);
    this.fresh = true;   // the first step sends the starting ground up

    // animals
    this.cap = 0; this.next = 0; this.free = [];
    this.wts = null;
    this.pending = [];
    this.anCap = 0;
    this.progCap = 0;
    this.BP = buf(32, UNI, 'brain params');
    this.DP = buf(16, UNI, 'delta params');
    this.tCap = 0;
    this.CP = buf(16, UNI, 'cppn params');
    this.growPool(2048);
    this.growAnimals(4096);
    this.cache = new Map();
    this.last = {};   // timings, for the curious
  }

  /* ---- brain slots */

  hasRoom() { return this.free.length > 0 || this.next < this.g.maxSlots; }

  growPool(cap) {
    const d = this.d, old = this.wts;
    cap = Math.min(cap, this.g.maxSlots);
    const nb = d.createBuffer({ size: cap * BRAIN.words * 4, usage: STORE, label: 'brains' });
    if (old) {
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(old, 0, nb, 0, this.cap * BRAIN.words * 4);
      d.queue.submit([enc.finish()]);
      old.destroy();
    }
    this.wts = nb; this.cap = cap;
    this.cache?.clear();
  }

  growAnimals(cap) {
    const d = this.d;
    this.an?.destroy(); this.res?.destroy(); this.readRes?.destroy();
    this.anCap = cap;
    this.an = d.createBuffer({ size: cap * 16, usage: STORE, label: 'animals' });
    this.res = d.createBuffer({ size: cap * 4, usage: STORE, label: 'decisions' });
    this.readRes = d.createBuffer({ size: cap * 4, usage: 0x1 | 0x8, label: 'readRes' });
    this.anData = new Uint32Array(cap * 4);
    this.anF = new Float32Array(this.anData.buffer);
    this.cache?.clear();
  }

  /** A new animal needs a place for its brain; the brain itself is painted at the start of the next step. */
  born(org) {
    if (this.free.length) org.slot = this.free.pop();
    else {
      if (this.next >= this.cap) this.growPool(this.cap * 2);
      org.slot = this.next++;
    }
    this.pending.push(org);
  }

  died(org) { if (org.slot >= 0) this.free.push(org.slot); org.slot = -1; }

  /* ---- bind groups */

  bg(pass, ...res) {
    const key = pass.name + ':' + res.map((r) => r.label).join(',');
    let b = this.cache.get(key);
    if (!b) {
      const entries = Object.keys(pass.binds).map((k, i) => ({ binding: +k, resource: { buffer: res[i] } }));
      b = this.d.createBindGroup({ layout: pass.bgl, entries });
      this.cache.set(key, b);
    }
    return b;
  }

  /* ---- one step */

  /** Run the ground and every animal's brain for one step. Resolves to the decisions (one number per animal in `list`, 0xffffffff for "does nothing"). The ground is copied back into land.grass, water, snow and soil. */
  async step(list) {
    const d = this.d, q = d.queue, L = this.L, w = this.w, n = this.n, size = this.size, count = list.length, P = this.g.pass;
    const t0 = performance.now();
    L.gpuPrep(w.clim);
    const tPrep = performance.now();
    if (this.fresh) {   // the starting ground goes up once
      const A = new Float32Array(size * 4), B = new Float32Array(size);
      for (let i = 0; i < size; i++) { A[4 * i] = L.grass[i]; A[4 * i + 1] = L.water[i]; A[4 * i + 2] = L.snow[i]; A[4 * i + 3] = L.soil[i]; B[i] = L.nitrogen[i]; }
      q.writeBuffer(this.A[0], 0, A); q.writeBuffer(this.B[0], 0, B);
      this.fresh = false;
    }

    // parameters and the row table
    const pd = this.paramData, vals = { n, size, raining: L.raining ? 1 : 0, rainD: L.rainDepth * w.clim.wet, lag: L.soilLag, conduct: L.soilConduct, sunWarm: L.sunWarm, heatGain: L.heatGain, waterHeat: L.waterHeat, waterHeatMax: L.waterHeatMax, meltRate: L.meltRate, deposit: L.deposit, evap: L.evap, seep: L.seep, floodSeep: L.floodSeep, seepMax: L.seepMax, flow: L.flow, creep: L.creep, leach: L.leach, outletRate: L.outletRate, regrow: L.regrow, gMax: L.gMax, waterPer: L.waterPer, nPer: L.nPer };
    LAND_FIELDS.forEach(([k, t], i) => (t === 'u32' ? pd.setUint32(i * 4, vals[k], true) : pd.setFloat32(i * 4, vals[k], true)));
    q.writeBuffer(this.P, 0, pd);
    const rd = this.rowData, c = w.clim;
    for (let r = 0; r < n; r++) {
      const o = r * 8;
      rd[o] = c.up[r]; rd[o + 1] = c.east[r]; rd[o + 2] = c.north[r]; rd[o + 3] = c.sun[r]; rd[o + 4] = c.temp[r]; rd[o + 5] = c.rain[r];
    }
    q.writeBuffer(this.rows, 0, rd, 0, n * 8);

    // what the animals did to the ground, and where they stand
    for (const a of list) L.delta(a.r * n + a.c, 3, 1);
    const nt = this.touched.length;
    if (nt > this.tCap) {
      this.tCap = Math.max(nt, this.tCap * 2, 4096);
      this.tIdx?.destroy(); this.tVal?.destroy();
      this.tIdx = d.createBuffer({ size: this.tCap * 4, usage: STORE, label: 'touchedIdx' });
      this.tVal = d.createBuffer({ size: this.tCap * 16, usage: STORE, label: 'touchedVal' });
      this.tIdxData = new Uint32Array(this.tCap); this.tValData = new Float32Array(this.tCap * 4);
      this.cache.clear();
    }
    for (let k = 0; k < nt; k++) {
      const i = this.touched[k], v = this.dl;
      this.tIdxData[k] = i;
      this.tValData[4 * k] = v[4 * i]; this.tValData[4 * k + 1] = v[4 * i + 1]; this.tValData[4 * k + 2] = v[4 * i + 2]; this.tValData[4 * k + 3] = v[4 * i + 3];
      v[4 * i] = v[4 * i + 1] = v[4 * i + 2] = v[4 * i + 3] = 0; this.seen[i] = 0;
    }
    this.touched.length = 0;
    if (nt) { q.writeBuffer(this.tIdx, 0, this.tIdxData, 0, nt); q.writeBuffer(this.tVal, 0, this.tValData, 0, nt * 4); }
    q.writeBuffer(this.DP, 0, new Uint32Array([nt, 0, 0, 0]));

    // the animals: slot (top bit: can act), cell, and the two colours others see
    if (count > this.anCap) this.growAnimals(Math.max(count, this.anCap * 2));
    const ad = this.anData, af = this.anF;
    for (let k = 0; k < count; k++) {
      const a = list[k];
      ad[4 * k] = (a.slot | (a.energy > 1 ? 0x80000000 : 0)) >>> 0;
      ad[4 * k + 1] = a.r * n + a.c;
      af[4 * k + 2] = a.col[1]; af[4 * k + 3] = a.col[2];
    }
    if (count) q.writeBuffer(this.an, 0, ad, 0, count * 4);
    const bpd = new ArrayBuffer(32), bpu = new Uint32Array(bpd), bpf = new Float32Array(bpd);
    bpu[0] = count; bpu[1] = n; bpf[4] = w.climb; bpf[5] = w.wade; bpf[6] = w.snowCost; bpf[7] = w.snowCap;
    q.writeBuffer(this.BP, 0, bpd);

    // newborn brains: painted from their genomes' programs
    const born = this.pending.filter((o) => w.animals.get(o.id) === o && o.slot >= 0);
    this.pending = [];
    const progs = [], slots = [];
    let progData = null;
    if (born.length) {
      progData = new Uint32Array(born.length * PROGRAM.words);
      for (const o of born) {
        const at = progs.length * PROGRAM.words;
        if (encodeProgram(o.genome, progData, at)) { progs.push(o); slots.push(o.slot); }
        else q.writeBuffer(this.wts, o.slot * BRAIN.words * 4, packNet(o.genome));   // too big for the card's fixed registers: painted here instead
      }
    }
    const nBorn = progs.length;
    if (nBorn) {
      if (nBorn > this.progCap) {
        this.prog?.destroy(); this.bornBuf?.destroy();
        this.progCap = Math.max(nBorn, this.progCap * 2, 512);
        this.prog = d.createBuffer({ size: this.progCap * PROGRAM.words * 4, usage: STORE, label: 'programs' });
        this.bornBuf = d.createBuffer({ size: this.progCap * 4, usage: STORE, label: 'born' });
        this.cache.clear();
      }
      q.writeBuffer(this.prog, 0, progData, 0, nBorn * PROGRAM.words);
      q.writeBuffer(this.bornBuf, 0, Uint32Array.from(slots));
      q.writeBuffer(this.CP, 0, new Uint32Array([nBorn, 0, 0, 0]));
    }

    const tUp = performance.now();
    // ---- the commands
    const enc = d.createCommandEncoder();
    enc.clearBuffer(this.cell);
    enc.clearBuffer(this.dlBuf);
    if (nt) {
      const sp = enc.beginComputePass();
      sp.setPipeline(P.deltas.pipeline);
      sp.setBindGroup(0, this.bg(P.deltas, this.DP, this.tIdx, this.tVal, this.dlBuf));
      sp.dispatchWorkgroups(Math.ceil(nt / 64));
      sp.end();
    }
    if (nBorn) {
      const p = enc.beginComputePass();
      p.setPipeline(P.cppn.pipeline);
      p.setBindGroup(0, this.bg(P.cppn, this.CP, this.prog, this.bornBuf, this.g.conn, this.wts));
      p.dispatchWorkgroups(Math.ceil(BRAIN.words / 64), nBorn);
      p.end();
    }
    const run = enc.beginComputePass();
    const go = (pass, ...res) => { run.setPipeline(pass.pipeline); run.setBindGroup(0, this.bg(pass, ...res)); run.dispatchWorkgroups(this.groups); };
    const A = () => this.A[this.pa], B = () => this.B[this.pb];
    const base = [this.P, this.rows];
    go(P.apply, ...base, A(), B(), this.dlBuf);
    go(P.soil, ...base, A(), this.A[1 - this.pa], this.stat); this.pa ^= 1;
    go(P.weather, ...base, A(), B(), this.stat, this.acc);
    for (let s = 0; s < L.flowSteps; s++) {
      go(P.flux, ...base, A(), this.flux, this.stat);
      go(P.gather, ...base, A(), B(), this.A[1 - this.pa], this.B[1 - this.pb], this.flux); this.pa ^= 1; this.pb ^= 1;
    }
    go(P.creep, ...base, A(), B(), this.A[1 - this.pa], this.B[1 - this.pb], this.stat, this.acc); this.pa ^= 1; this.pb ^= 1;
    go(P.grow, ...base, A(), B(), this.A[1 - this.pa], this.B[1 - this.pb], this.stat, this.dlBuf, this.acc); this.pa ^= 1; this.pb ^= 1;
    run.end();

    if (count) {
      const bp = enc.beginComputePass();
      bp.setPipeline(P.scatter.pipeline);
      bp.setBindGroup(0, this.bg(P.scatter, this.BP, this.an, this.cell));
      bp.dispatchWorkgroups(Math.ceil(count / 64));
      bp.setPipeline(P.brain.pipeline);
      bp.setBindGroup(0, this.bg(P.brain, this.BP, this.rows, this.an, this.cell, A(), this.stat, this.wts, this.res));
      bp.dispatchWorkgroups(Math.min(count, 65535), Math.ceil(count / 65535));
      bp.end();
      enc.copyBufferToBuffer(this.res, 0, this.readRes, 0, count * 4);
    }
    enc.copyBufferToBuffer(A(), 0, this.readA, 0, size * 16);
    q.submit([enc.finish()]);
    const t1 = performance.now();

    await Promise.all([this.readA.mapAsync(1), count ? this.readRes.mapAsync(1, 0, count * 4) : null]);
    const tWait = performance.now();
    const fa = new Float32Array(this.readA.getMappedRange());
    const G = L.grass, Wt = L.water, S = L.snow, T = L.soil;
    for (let i = 0, j = 0; i < size; i++, j += 4) { G[i] = fa[j]; Wt[i] = fa[j + 1]; S[i] = fa[j + 2]; T[i] = fa[j + 3]; }
    this.readA.unmap();
    let out = new Uint32Array(0);
    if (count) { out = new Uint32Array(this.readRes.getMappedRange(0, count * 4)).slice(); this.readRes.unmap(); }
    this.last = { prep: tPrep - t0, upload: tUp - tPrep, encode: t1 - tUp, wait: tWait - t1, readback: performance.now() - tWait, born: nBorn };
    return out;
  }

  /* ---- reading the rest back, for the nitrogen picture and for checking the books */

  async syncNitrogen() {
    const enc = this.d.createCommandEncoder();
    enc.copyBufferToBuffer(this.B[this.pb], 0, this.readB, 0, this.size * 4);
    this.d.queue.submit([enc.finish()]);
    await this.readB.mapAsync(1);
    this.L.nitrogen.set(new Float32Array(this.readB.getMappedRange()));
    this.readB.unmap();
  }

  /** Bring the ledger up to date: add up what each workgroup has counted since the start. */
  async syncLedger() {
    const enc = this.d.createCommandEncoder();
    enc.copyBufferToBuffer(this.acc, 0, this.readAcc, 0, this.groups * 32);
    this.d.queue.submit([enc.finish()]);
    await this.readAcc.mapAsync(1);
    const a = new Float32Array(this.readAcc.getMappedRange()), s = new Float64Array(8);
    for (let g = 0; g < this.groups; g++) for (let k = 0; k < 6; k++) s[k] += a[g * 8 + k];
    this.readAcc.unmap();
    const led = this.L.ledger;
    led.evap = s[0]; led.seep = s[1]; led.river = s[2]; led.nLeach = s[3] + s[4]; led.uptake = s[5];
  }

  async sync() { await this.syncNitrogen(); await this.syncLedger(); }

  /** Nitrogen the animals have dropped that has not reached the ground yet (for the books). */
  pendingNitrogen() { let s = 0; for (const i of this.touched) s += this.dl[4 * i + 1]; return s; }   // (what the animals dropped since the last step went up)

  destroy() {
    for (const b of [...this.A, ...this.B, this.stat, this.dlBuf, this.flux, this.acc, this.P, this.rows, this.readA, this.readB, this.readAcc, this.wts, this.an, this.res, this.readRes, this.BP, this.CP, this.DP, this.tIdx, this.tVal, this.cell, this.prog, this.bornBuf]) b?.destroy();
    this.L.dev = null;
  }
}
