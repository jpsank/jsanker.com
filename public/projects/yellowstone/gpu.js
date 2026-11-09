// The graphics card side of Yellowstone (WebGPU compute shaders). Two jobs, both done there when the browser has WebGPU and by sim.js / land.js on the CPU when it does not:
//
//   the ground   grass, water, snow, nitrogen and ground temperature on every cell: a handful of passes over the whole grid per step, one thread per cell. The numbers stay
//                on the card; each step the animals get a copy of grass, water, snow and ground temperature back, and what they did to the ground (grass eaten, nitrogen
//                dropped, heat given off) goes up as a small delta.
//   the brains   every animal's network, run for all of them at once. A brain is grown from the animal's genome (the CPPN, ES-HyperNEAT style: see esnet.js) on the card the moment the
//                animal is born, and kept there as a record of neurons and connections. Each step one workgroup per animal follows its fan of rays out for what it sees, runs the network and picks its action.
//
// The arithmetic is the same as land.js and sim.js, in 32-bit floats instead of 64-bit, so a run is repeatable on the same machine and card but not identical to a CPU run.
import { BRAIN, PROGRAM, encodeProgram, packNet, VISION, EYES, SAMPLES, N_VIEW, RAY_PACKED, RETINA, OUTPUTS } from './sim.js';
import { ES } from './esnet.js';
import { SHADOW_SOFT, SHADOW_REACH, LANDVIEW, PHYS } from './land.js';
import { SUBSTANCES, SNOW } from './substances.js';

const WG = 256;                 // threads per workgroup in the ground passes
const SLOT_CAP = 200000;        // never more brains than this
const EDGE0 = 3 + 4 * PROGRAM.maxNodes;   // where a program's connections start (see encodeProgram)

/* ------------------------------------------------------------------ the ground */

const LAND_FIELDS = [
  ['n', 'u32'], ['size', 'u32'], ['raining', 'f32'], ['rainD', 'f32'], ['heatGain', 'f32'], ['kOro', 'f32'], ['albedo', 'f32'], ['snowAlbedoDepth', 'f32'], ['invWs', 'f32'], ['retain', 'f32'], ['flowMin', 'f32'], ['soakMax', 'f32'], ['floodStart', 'f32'], ['floodEnd', 'f32'], ['nMobile', 'f32'],
  ['waterHeatMax', 'f32'], ['cDry', 'f32'], ['cWaterU', 'f32'], ['kg', 'f32'], ['hUnstable', 'f32'], ['rGround', 'f32'], ['iceRes', 'f32'], ['albedoOld', 'f32'], ['compactK', 'f32'], ['gDeep', 'f32'], ['gLake', 'f32'], ['iceMin', 'f32'], ['snowRetain', 'f32'], ['gTop', 'f32'], ['coldK', 'f32'], ['gammaDry', 'f32'], ['albedoWater', 'f32'], ['albedoIce', 'f32'], ['freeLapse', 'f32'], ['windC', 'f32'], ['windR', 'f32'], ['dtDx', 'f32'], ['hblMin', 'f32'], ['hblMax', 'f32'], ['kBL', 'f32'], ['drain', 'f32'], ['drainMax', 'f32'], ['mixConv', 'f32'], ['mixStable', 'f32'], ['rhoCp', 'f32'], ['deepK', 'f32'], ['lnTrans', 'f32'], ['lwCloud', 'f32'], ['emis', 'f32'], ['hAir', 'f32'], ['hSnow', 'f32'], ['ptAlpha', 'f32'], ['wetCrit', 'f32'], ['dt', 'f32'], ['accel', 'f32'], ['deposit', 'f32'], ['seep', 'f32'], ['floodSeep', 'f32'], ['seepMax', 'f32'],
  ['flow', 'f32'], ['creep', 'f32'], ['leach', 'f32'], ['outletRate', 'f32'], ['regrow', 'f32'], ['gMax', 'f32'], ['waterPer', 'f32'], ['nPer', 'f32'], ['shadows', 'f32'], ['cellRun', 'f32'], ['skyMax', 'f32'],
];
const PARAM_BYTES = LAND_FIELDS.length * 4;
const ROWS = 1536;   // vec4s in the row table: two for every row, then one for every column (so maps up to 512 across)

// state: A = (grass, water, snow, ground temperature) and B = nitrogen, per cell, each kept twice (ping-pong) for the passes that read neighbours.
// stat = per cell two vec4s: (height, km above the map's average height, is-outlet, the height the sun sees) and the slope normal (east, north, up, the height above sea level in km).
// rows = per row two vec4s: (sun up, east, north, flat-ground light on the middle meridian) and (air temperature, rain share, sin and cos of the latitude); then per column one vec4:
//   (cos of the declination x cos of the hour angle there, minus cos of the declination x sin of it, sin of the declination, 0). The sun's place at a cell comes from the two.
// stat.w of a cell's first vec4 = the height the sun sees there (the lakes' surface, not their bed), for the shadows.
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
fn heatCap(w: f32) -> f32 { return P.cDry + P.cWaterU * min(P.waterHeatMax, w); }   // J/m2/K of the ground layer: dry soil and the water in it
fn capRel(w: f32) -> f32 { return heatCap(w) / P.cDry; }
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
  if (w <= P.floodStart) { return 1.0; }
  if (w < P.floodEnd) { return (P.floodEnd - w) / (P.floodEnd - P.floodStart); }
  return 0.0;
}
// the eight neighbours: up, right, down, left, up-left, up-right, down-right, down-left (a cell on the map's edge is its own neighbour there)
fn nbr8(i: u32, d: u32) -> u32 {
  let n = i32(P.n);
  let r = i32(i / P.n);
  let c = i32(i % P.n);
  var dr = 0;
  var dc = 0;
  if (d == 0u) { dr = -1; }
  if (d == 1u) { dc = 1; }
  if (d == 2u) { dr = 1; }
  if (d == 3u) { dc = -1; }
  if (d == 4u) { dr = -1; dc = -1; }
  if (d == 5u) { dr = -1; dc = 1; }
  if (d == 6u) { dr = 1; dc = 1; }
  if (d == 7u) { dr = 1; dc = -1; }
  let rr = r + dr;
  let cc = c + dc;
  if (rr < 0 || rr >= n || cc < 0 || cc >= n) { return i; }
  return u32(rr * n + cc);
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
  a.w = a.w + P.heatGain * d.z / capRel(a.y);
  sA[i] = a;
  sB[i] = sB[i] + d.y;
}`;

// the sunlight on every cell: the beam by how squarely the slope faces the sun where that cell is, unless a hill's skyline is higher than the sun, plus a little skylight (see Land.sunlight)
const LIGHT = /* wgsl */ `
@group(0) @binding(2) var<storage, read> stat: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> lightOut: array<f32>;
${MAIN} {
  let i = g.x;
  if (i >= P.size) { return; }
  let n = P.n;
  let r = i / n;
  let c = i - r * n;
  let rw2 = rows[2u * r + 1u];
  let col = rows[2u * n + c];
  let sp = rw2.z;
  let cp = rw2.w;
  let u = sp * col.z + cp * col.x;
  if (u <= 0.0) { lightOut[i] = 0.0; lightOut[P.size + i] = 0.0; return; }
  let e = col.y;
  let no = col.z * cp - sp * col.x;
  let nm = stat[2u * i + 1u];
  var beam = max(nm.x * e + nm.y * no + nm.z * u, 0.0);
  if (P.shadows > 0.5 && beam > 0.0) {
    let hh = sqrt(e * e + no * no);
    let dx = e / hh;
    let dy = -no / hh;
    let h0 = stat[2u * i].w;
    let rise = (P.skyMax - h0) / P.cellRun;
    var best = 0.0;
    for (var s = 1; s <= ${SHADOW_REACH}; s = s + 1) {
      let fs = f32(s);
      if (rise <= best * fs) { break; }
      let rr = i32(floor(f32(r) + dy * fs + 0.5));
      let cc = i32(floor(f32(c) + dx * fs + 0.5));
      if (rr < 0 || rr >= i32(n) || cc < 0 || cc >= i32(n)) { break; }
      let t = (stat[2u * (u32(rr) * n + u32(cc))].w - h0) / (fs * P.cellRun);
      best = max(best, t);
    }
    let x = clamp((u - best / sqrt(1.0 + best * best)) / ${SHADOW_SOFT} + 0.5, 0.0, 1.0);
    beam = beam * x * x * (3.0 - 2.0 * x);
  }
  let lit = 0.9 * beam + 0.1 * u;
  lightOut[i] = lit;
  lightOut[P.size + i] = lit - u;   // (the second half of the buffer: the light minus what flat ground there gets, the slope's share of the land view's shading)
}`;

// the ground's energy balance (see Land.warmGround): the surface (the skin of snow, ice or ground that meets the air) is where the sun, the sky, the air and evaporation balance, and it passes heat down to the
// ground layer through the snow and ice on it. Snow and ice take the skin no warmer than freezing, and what would warm it melts them; deep water freezes over. These move water, so they are done here too.
const SOIL = /* wgsl */ `
@group(0) @binding(2) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> oA: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> stat: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> lightIn: array<f32>;
@group(0) @binding(6) var<storage, read_write> acc: array<f32>;
@group(0) @binding(7) var<storage, read_write> iceBuf: array<f32>;
@group(0) @binding(8) var<storage, read> thIn: array<f32>;
@group(0) @binding(9) var<storage, read_write> thOut: array<f32>;
fn thFreeAt(j: u32, up: f32) -> f32 {
  let rj = j / P.n;
  return rows[2u * rj + 1u].x + (P.gammaDry - P.freeLapse) * (stat[2u * j + 1u].w + up);
}
${MAIN} {
  let i = g.x;
  var gone = 0.0;
  if (i < P.size) {
    let r = i / P.n;
    let c = i - r * P.n;
    let a = sA[i];
    let nm = stat[2u * i + 1u];
    let tdeep = iceBuf[4u * i + 2u];
    let ta = thIn[i] - P.gammaDry * nm.w;
    let tg = a.w;
    let ak = ta + 273.15;
    let lit = lightIn[i];
    let u = lit - lightIn[P.size + i];
    var w = a.y;
    var sn = a.z;
    var ic = iceBuf[4u * i];
    var pk = iceBuf[4u * i + 1u];
    let covered = sn > 0.02 || ic > 0.02;
    let cover = min(1.0, sn / P.snowAlbedoDepth);
    var bare = P.albedo;
    if (ic > 0.02) { bare = P.albedoIce; } else if (w > P.iceMin) { bare = P.albedoWater; }
    var rho = iceBuf[4u * i + 3u];
    if (sn <= 0.0 || rho <= 0.0) { rho = ${SNOW.rhoNew}.0; }
    let aged = clamp((rho - ${SNOW.rhoNew}.0) / (${SNOW.rhoSettled}.0 - ${SNOW.rhoNew}.0), 0.0, 1.0);
    let snowAlb = ${SNOW.albedoNew} + (P.albedoOld - ${SNOW.albedoNew}) * aged;
    let alb = bare + (snowAlb - bare) * cover;
    let hb = P.hAir + (P.hSnow - P.hAir) * cover;
    let gc = 1.0 / (P.rGround + sn * P.kg / rho / (2.5e-6 * rho * rho - 1.23e-4 * rho + 0.024) + ic * P.iceRes);
    var sw = 0.0;
    if (u > 0.0) { sw = ${PHYS.solar}.0 * exp(P.lnTrans / max(u, 0.08)) * (1.0 - alb) * lit; }
    let clear = 1.0 - 0.261 * exp(-7.77e-4 * ta * ta);
    let lwd = (clear + P.lwCloud * (1.0 - clear)) * ${PHYS.sigma} * ak * ak * ak * ak;
    let e = 0.6108 * exp(17.27 * ta / (ta + 237.3));
    let delta = 4098.0 * e / ((ta + 237.3) * (ta + 237.3));
    let pt = P.ptAlpha * delta / (delta + ${PHYS.gamma});
    var wet = 0.0;
    if (!covered && w > 0.0) { wet = min(1.0, w / P.wetCrit); }
    var ts = tg;
    if (covered) { ts = min(ta, 0.0); }
    var le = 0.0;
    for (var k = 0; k < 4; k = k + 1) {
      let tk = ts + 273.15;
      let rn = sw + lwd - P.emis * ${PHYS.sigma} * tk * tk * tk * tk;
      le = wet * pt * max(0.0, rn);
      let h = hb * (1.0 + P.hUnstable * max(0.0, ts - ta));
      let f = rn - h * (ts - ta) - le - gc * (ts - tg);
      ts = ts + clamp(f / (4.0 * P.emis * ${PHYS.sigma} * tk * tk * tk + h + gc), -30.0, 30.0);
    }
    var q = gc * (ts - tg);
    if (le > 0.0) {
      let x = min(w, P.accel * le * P.dt / (${PHYS.lv}.0 * P.kg));
      w = w - x;
      gone = x;
    }
    if (sn > 0.02) {
      if (ts > 0.0) {
        pk = pk + P.accel * P.dt * (sw + lwd - P.emis * ${PHYS.sigma} * 273.15 * 273.15 * 273.15 * 273.15 + hb * ta) + P.dt * gc * tg;
        ts = 0.0;
        q = -gc * tg;
      } else {
        pk = max(pk - P.accel * P.dt * P.gTop * (0.0 - ts), -P.coldK * 2100.0 * P.kg * sn);
      }
      let over = pk - P.snowRetain * sn * ${PHYS.lf}.0 * P.kg;
      var melted = 0.0;
      if (over > 0.0) {
        melted = min(sn, over / (${PHYS.lf}.0 * P.kg));
        sn = sn - melted;
        w = w + melted;
        pk = pk - melted * ${PHYS.lf}.0 * P.kg;
      }
      if (sn > 0.0) {
        rho = rho + (${SNOW.rhoSettled}.0 - rho) * min(1.0, 1.0 - exp(-P.compactK * exp(0.08 * ta)) + 2.0 * melted / (sn + melted));
      } else { pk = 0.0; rho = 0.0; }
    } else if (ic > 0.02 && ts > 0.0) {
      let m = P.accel * P.dt * (sw + lwd - P.emis * ${PHYS.sigma} * 273.15 * 273.15 * 273.15 * 273.15 + hb * ta) + P.dt * gc * tg;
      if (m > 0.0) { ic = ic - min(ic, m / (${PHYS.lf}.0 * P.kg)); }
      ts = 0.0;
      q = -gc * tg;
    } else { pk = 0.0; }
    var tn = 0.0;
    if (ic > 0.0) {
      let fw = q + P.gLake * tdeep;
      let d = max(-ic, min(w - ic, -P.accel * P.dt * fw / (${PHYS.lf}.0 * P.kg)));
      ic = ic + d;
    } else {
      let cap = heatCap(w);
      var gd = P.gDeep;
      if (w > P.iceMin) { gd = P.gLake; }
      tn = tg + P.dt * (q + gd * (tdeep - tg)) / cap;
      if (w > P.iceMin && tn < 0.0) {
        ic = min(w, cap * (0.0 - tn) / (${PHYS.lf}.0 * P.kg));
        tn = 0.0;
      }
    }
    iceBuf[4u * i] = ic;
    iceBuf[4u * i + 1u] = pk;
    if (sn <= 0.0) { rho = 0.0; }
    iceBuf[4u * i + 3u] = rho;
    iceBuf[4u * i + 2u] = tdeep + (tn - tdeep) * P.deepK;
    // the air: what was upwind a step ago (the free atmosphere, from outside the map), warmed by the surface through the boundary layer, and mixed with the free atmosphere above (see Land.warmGround)
    let hh = hb * (1.0 + P.hUnstable * max(0.0, ts - ta));
    let heat = hh * (ts - ta);
    let hbl = min(P.hblMax, P.hblMin + P.kBL * max(0.0, heat));
    let thf = thFreeAt(i, hbl / 2000.0);
    let dev = max(0.0, thf - thIn[i]);
    let tilt = length(vec2<f32>(nm.x, nm.y));
    var dC = 0.0;
    var dR = 0.0;
    if (dev > 0.0 && tilt > 1e-9) {
      let v = min(P.drainMax, P.drain * sqrt(9.81 * dev / 270.0 * hbl * (tilt / nm.z)));
      let k = v * P.dtDx;
      dC = k * nm.x / tilt;
      dR = k * nm.y / tilt;
    }
    let fc = f32(c) - (P.windC + dC);
    let fr = f32(r) + (P.windR + dR);
    let nf = f32(P.n - 1u);
    var upw = 0.0;
    if (fc < 0.0 || fc > nf || fr < 0.0 || fr > nf) {
      let cc = u32(clamp(round(fc), 0.0, nf));
      let rr = u32(clamp(round(fr), 0.0, nf));
      upw = thFreeAt(rr * P.n + cc, 0.0);
    } else {
      let c0 = u32(floor(fc));
      let r0 = u32(floor(fr));
      let c1 = min(c0 + 1u, P.n - 1u);
      let r1 = min(r0 + 1u, P.n - 1u);
      let tc = fc - floor(fc);
      let tr = fr - floor(fr);
      upw = (thIn[r0 * P.n + c0] * (1.0 - tc) + thIn[r0 * P.n + c1] * tc) * (1.0 - tr) + (thIn[r1 * P.n + c0] * (1.0 - tc) + thIn[r1 * P.n + c1] * tc) * tr;
    }
    var thn = upw + P.dt * heat / (P.rhoCp * hbl);
    var mk = P.mixStable;
    if (heat > 0.0) { mk = P.mixConv; }
    thn = thn + (thf - thn) * mk;
    thOut[i] = thn;
    oA[i] = vec4<f32>(a.x, w, sn, tn);
  }
  let te = wgSum(t, gone);
  if (t == 0u) { acc[wg.x * 8u] = acc[wg.x * 8u] + te; }
}`;

// rain or snow, nitrogen in the rain, soaking away (snowmelt and evaporation are in the ground's energy balance)
const WEATHER = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> sB: array<f32>;
@group(0) @binding(4) var<storage, read> stat: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> acc: array<f32>;
@group(0) @binding(6) var<storage, read_write> iceBuf: array<f32>;
@group(0) @binding(7) var<storage, read> thBuf: array<f32>;
${MAIN} {
  let i = g.x;
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
    let air = thBuf[i] - P.gammaDry * nm.w;
    if (P.raining > 0.5) {
      let d = P.rainD * rw2.y * max(0.1, 1.0 + P.kOro * st.y);
      if (air < 1.0 && w > P.iceMin && iceBuf[4u * i] <= 0.0) {
        w = w + d;
        a.w = a.w - d * P.kg * ${PHYS.lf}.0 / heatCap(w);
      } else if (air < 1.0) {
        var ro = iceBuf[4u * i + 3u];
        if (ro <= 0.0) { ro = ${SNOW.rhoNew}.0; }
        iceBuf[4u * i + 3u] = (sn + d) / (sn / ro + d / ${SNOW.rhoNew}.0);
        sn = sn + d;
      } else { w = w + d; }
    }
    nn = nn + P.deposit;
    let y = min(min(min(w, P.soakMax) * P.seep + P.floodSeep * max(0.0, w - 1.5), P.seepMax), w);
    w = w - y;
    seeped = y;
    a.y = w;
    a.z = sn;
    sA[i] = a;
    sB[i] = nn;
  }
  let ts = wgSum(t, seeped);
  if (t == 0u) { acc[wg.x * 8u + 1u] = acc[wg.x * 8u + 1u] + ts; }
}`;

// water runs to lower neighbours: first how much leaves each cell in each of eight directions (the drop in water surface, in units of water, times a share, and never more than
// this cell has above the first `flowMin` of its water, which stays put)...
const FLUX = /* wgsl */ `
@group(0) @binding(2) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> fluxA: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> fluxB: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> stat: array<vec4<f32>>;
${MAIN} {
  let i = g.x;
  if (i >= P.size) { return; }
  let w = sA[i].y;
  var fa = vec4<f32>(0.0);
  var fb = vec4<f32>(0.0);
  if (w > P.flowMin && w > 0.0) {
    let e = stat[2u * i].x;
    var total = 0.0;
    for (var d = 0u; d < 8u; d = d + 1u) {
      let j = nbr8(i, d);
      let diff = (e - stat[2u * j].x) * P.invWs + (w - sA[j].y);
      var f = 0.0;
      if (diff > 0.0) { f = P.flow * diff * select(1.0, 0.70710678, d >= 4u); }
      if (d < 4u) { fa[d] = f; } else { fb[d - 4u] = f; }
      total = total + f;
    }
    let room = w - P.flowMin;
    let scale = select(1.0, room / total, total > room);
    if (total > 0.0 && total * scale > 0.0) { fa = fa * scale; fb = fb * scale; } else { fa = vec4<f32>(0.0); fb = vec4<f32>(0.0); }
  }
  fluxA[i] = fa;
  fluxB[i] = fb;
}`;

// ...then each cell loses what it sends and gains what its neighbours send it (a neighbour in direction d sends to this cell in the opposite direction), nitrogen riding along with the water
const GATHER = /* wgsl */ `
@group(0) @binding(2) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> sB: array<f32>;
@group(0) @binding(4) var<storage, read_write> oA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> oB: array<f32>;
@group(0) @binding(6) var<storage, read> fluxA: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> fluxB: array<vec4<f32>>;
${MAIN} {
  let i = g.x;
  if (i >= P.size) { return; }
  var a = sA[i];
  let w = a.y;
  let nit = sB[i];
  let fo = fluxA[i];
  let fp = fluxB[i];
  let outW = fo.x + fo.y + fo.z + fo.w + fp.x + fp.y + fp.z + fp.w;
  var inW = 0.0;
  var inN = 0.0;
  for (var d = 0u; d < 8u; d = d + 1u) {
    let j = nbr8(i, d);
    if (j == i) { continue; }
    // the neighbour at direction d sends to this cell along the opposite direction
    var o = d + 2u;
    if (d == 2u || d == 3u) { o = d - 2u; }
    if (d == 4u) { o = 6u; }
    if (d == 5u) { o = 7u; }
    if (d == 6u) { o = 4u; }
    if (d == 7u) { o = 5u; }
    var f = 0.0;
    if (o < 4u) { let v = fluxA[j]; f = v[o]; } else { let v = fluxB[j]; f = v[o - 4u]; }
    if (f > 0.0) { inW = inW + f; inN = inN + f * P.nMobile * sB[j] / sA[j].y; }
  }
  a.y = max(0.0, w - outW + inW);
  var nn = nit + inN;
  if (w > 0.0) { nn = nn - nit * P.nMobile * (outW / w); }
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
@group(0) @binding(9) var<storage, read> lightIn: array<f32>;
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
      let light = lightIn[i] * clamp(tl / 12.0, 0.0, 1.0);
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
struct BP { count: u32, n: u32, a: u32, b: u32, climb: f32, swim: f32, snowCost: f32, snowCap: f32, swimDepth: f32, cellRun: f32, eye: f32, tol: f32 }
@group(0) @binding(0) var<uniform> bp: BP;
@group(0) @binding(1) var<uniform> rows: array<vec4<f32>, ${ROWS}>;
@group(0) @binding(2) var<storage, read> an: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> cell: array<u32>;
@group(0) @binding(4) var<storage, read> sA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> stat: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> wts: array<u32>;
@group(0) @binding(7) var<storage, read_write> res: array<u32>;
@group(0) @binding(8) var<storage, read> lightIn: array<f32>;
@group(0) @binding(9) var<uniform> rayTab: array<vec4<u32>, ${RAY_PACKED.length / 4}>;

const GREY: f32 = 0.0019607843;
fn clarityOf(lit: f32) -> f32 { return ${VISION.floor} + (1.0 - ${VISION.floor}) * (1.0 - exp(-lit / ${VISION.half})); }
var<private> BFROM: array<u32, ${SAMPLES}> = array<u32, ${SAMPLES}>(${EYES.from.map((v) => v + 'u').join(', ')});
var<private> BTO: array<u32, ${SAMPLES}> = array<u32, ${SAMPLES}>(${EYES.seen.map((v) => v + 'u').join(', ')});
var<private> DR: array<i32, 8> = array<i32, 8>(-1, -1, 0, 1, 1, 1, 0, -1);
var<private> DC: array<i32, 8> = array<i32, 8>(0, 1, 1, 1, 0, -1, -1, -1);
// the ground as the land view shows it (see landRgb in land.js)
fn landColour(height: f32, slope: f32, grass: f32, water: f32, snow: f32) -> vec3<f32> {
  let relief = clamp(0.55 + ${LANDVIEW.heightGain} * height + ${LANDVIEW.slopeGain} * slope, 0.0, ${LANDVIEW.reliefMax});
  var c = vec3<f32>(${LANDVIEW.earth.join(',')}) * relief;
  c = c + (vec3<f32>(${LANDVIEW.green.join(',')}) - c) * min(${LANDVIEW.grassMax}, grass / ${LANDVIEW.grassFull}.0);
  c = c + (vec3<f32>(${LANDVIEW.water.join(',')}) - c) * min(${LANDVIEW.waterMax}, water / ${LANDVIEW.waterFull});
  c = c + (vec3<f32>(${LANDVIEW.snow.join(',')}) - c) * min(${LANDVIEW.snowMax}, snow / ${LANDVIEW.snowFull});
  return min(c, vec3<f32>(255.0)) / 255.0 - vec3<f32>(0.5);
}
const WORDS: u32 = ${BRAIN.words}u;
const CELLS: u32 = ${ES.cells}u;
const NIN: u32 = ${BRAIN.nIn}u;
const NOUT: u32 = ${BRAIN.nOut}u;
const BIASAT: u32 = ${BRAIN.biasAt}u;
const ENT: u32 = ${BRAIN.entAt}u;
const OUTAT: u32 = ${BRAIN.outAt}u;
var<workgroup> inp: array<f32, ${N_VIEW}>;
var<workgroup> hv: array<f32, ${ES.cells}>;
var<workgroup> ov: array<f32, 18>;

fn unb(base: u32, idx: u32) -> f32 {   // the bias of a neuron (16-bit floats, in pairs)
  let p = unpack2x16float(wts[base + BIASAT + (idx >> 1u)]);
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

  // what it sees: a fan of rays from the way it faces; a thread follows each ray out, and ground that rises into the line of sight hides what is behind it
  let hd = (rec.x >> 24u) & 7u;
  if (canAct && t < ${EYES.rays}u) {
    let lvl = (rec.x >> 27u) & 7u;
    let tab = ((lvl * 8u + hd) * ${EYES.rays}u + t) * ${EYES.march}u;
    let h0 = stat[2u * pos].w + bp.eye;
    let here = clarityOf(lightIn[pos]);
    var best = -3.0e38;
    var si = 0u;
    var acc = vec3<f32>(0.0);
    for (var st = 0u; st < ${EYES.march}u; st = st + 1u) {
      let pk = rayTab[(tab + st) >> 2u][(tab + st) & 3u];
      let dr = i32(pk >> 4u) - 8;
      let dc = i32(pk & 15u) - 8;
      let rr = r + dr;
      let cc = c + dc;
      let off = rr < 0 || rr >= ni || cc < 0 || cc >= ni;
      var k = 0u;
      var visible = true;
      if (!off) {
        k = u32(rr) * n + u32(cc);
        let slope = (stat[2u * k].w - h0) / (sqrt(f32(dr * dr + dc * dc)) * bp.cellRun);
        visible = slope >= best - bp.tol;
        best = max(best, slope);
      }
      if (st >= BFROM[si]) {
        var col = vec3<f32>(GREY, GREY, GREY);   // (behind a hill)
        var f = here;
        if (off) {
          col = vec3<f32>(-0.5, -0.5, -0.5);   // (past the edge of the map)
        } else if (visible) {
          f = clarityOf(lightIn[k]);
          let who = cell[k];
          if (who != 0u) {
            let o = an[who - 1u];
            col = vec3<f32>(0.5, bitcast<f32>(o.z), bitcast<f32>(o.w));
          } else {
            let g4 = sA[k];
            col = landColour(stat[2u * k].x, lightIn[n * n + k], g4.x, g4.y, g4.z);
          }
        }
        acc = acc + vec3<f32>(GREY, GREY, GREY) + (col - vec3<f32>(GREY, GREY, GREY)) * f;
        if (st == BTO[si]) {
          let o3 = acc / f32(st - BFROM[si] + 1u);
          let idx = (t * ${SAMPLES}u + si) * 3u;
          inp[idx] = o3.x;
          inp[idx + 1u] = o3.y;
          inp[idx + 2u] = o3.z;
          acc = vec3<f32>(0.0);
          si = si + 1u;
        }
      }
    }
  }
  workgroupBarrier();

  // the brain: hidden neurons stage by stage (each reads only the eye and shallower neurons), then the outputs
  let base = (rec.x & 0xffffffu) * WORDS;
  for (var stage = 1u; stage <= ${ES.stages}u; stage = stage + 1u) {
    for (var d = t; d < CELLS; d = d + 64u) {
      let hw = wts[base + d];
      if (canAct && (hw & 15u) == stage) {
        var s = unb(base, d);
        let cnt = (hw >> 4u) & 0xfffu;
        let at = base + ENT + d * ${ES.fanH}u;
        for (var q = 0u; q < cnt; q = q + 1u) {
          let e = wts[at + q];
          let j = e & 0xffffu;
          var v = 0.0;
          if (j < NIN) { v = inp[j]; } else { v = hv[j - NIN]; }
          s = s + unpack2x16float(e >> 16u).x * v;
        }
        hv[d] = tanh(s);
      }
    }
    workgroupBarrier();
  }
  if (canAct && t < NOUT) {
    var s = unb(base, CELLS + t);
    let cnt = (wts[base + CELLS + t] >> 4u) & 0xfffu;
    let at = base + OUTAT + t * ${ES.fanO}u;
    for (var q = 0u; q < cnt; q = q + 1u) {
      let e = wts[at + q];
      let j = e & 0xffffu;
      var v = 0.0;
      if (j < NIN) { v = inp[j]; } else { v = hv[j - NIN]; }
      s = s + unpack2x16float(e >> 16u).x * v;
    }
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
        // the actions are turn (columns) by move (rows): turn first, then step along the new heading (see stepOf in sim.js)
        let h2 = (hd + (k % 3u) + 7u) & 7u;
        var di = 0;
        var dj = 0;
        if (k / 3u != 1u) {
          let dir = select((h2 + 4u) & 7u, h2, k / 3u == 0u);
          di = DR[dir];
          dj = DC[dir];
        }
        let rr = r + di;
        let cc = c + dj;
        if (rr < 0 || rr >= ni || cc < 0 || cc >= ni) { continue; }
        let j = u32(rr) * n + u32(cc);
        let land = sA[j];
        let cost = 0.05 + 0.1 * f32(abs(di) + abs(dj)) / 2.0 + bp.climb * max(0.0, stat[2u * j].x - here) + bp.swim * min(1.0, land.y / bp.swimDepth) + select(0.0, bp.snowCost * min(bp.snowCap, land.z), di != 0 || dj != 0);
        let v = ov[k * 2u] - log(cost);
        if (v > bv) { bv = v; best = k; }
      }
      var bk = 0u;
      var bb = -3.0e38;
      for (var k = 0u; k < 9u; k = k + 1u) {
        if (ov[k * 2u + 1u] > bb) { bb = ov[k * 2u + 1u]; bk = k; }
      }
      var total = 0u;
      for (var d = 0u; d < CELLS + NOUT; d = d + 1u) { total = total + ((wts[base + d] >> 4u) & 0xfffu); }
      res[a] = best | (bk << 4u) | (total << 8u);
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
struct BP { count: u32, n: u32, a: u32, b: u32, climb: f32, swim: f32, snowCost: f32, snowCap: f32, swimDepth: f32, cellRun: f32, eye: f32, tol: f32 }
@group(0) @binding(0) var<uniform> bp: BP;
@group(0) @binding(2) var<storage, read> an: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read_write> cell: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x < bp.count) { cell[an[g.x].y] = g.x + 1u; }
}`;

// grows the brains of newborns (see esnet.js, which this follows step by step): one workgroup for each newborn, one thread for each candidate place for a hidden neuron
const CPPN_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> cp: vec4<u32>;
@group(0) @binding(2) var<storage, read> prog: array<u32>;
@group(0) @binding(3) var<storage, read> born: array<u32>;
@group(0) @binding(4) var<storage, read> places: array<f32>;
@group(0) @binding(5) var<storage, read_write> wts: array<u32>;
const WORDS: u32 = ${BRAIN.words}u;
const PROGW: u32 = ${PROGRAM.words}u;
const EDGE0: u32 = ${EDGE0}u;
const G: u32 = ${ES.grid}u;
const CELLS: u32 = ${ES.cells}u;
const PLACES: u32 = ${ES.places}u;
const NIN: u32 = ${BRAIN.nIn}u;
const NOUT: u32 = ${BRAIN.nOut}u;
const BIASAT: u32 = ${BRAIN.biasAt}u;
const ENT: u32 = ${BRAIN.entAt}u;
const OUTAT: u32 = ${BRAIN.outAt}u;
const FANH: u32 = ${ES.fanH}u;
const FANO: u32 = ${ES.fanO}u;
var<workgroup> wsh: array<f32, PLACES>;
var<workgroup> sc: array<u32, PLACES>;
var<workgroup> stg: array<u32, ${ES.places * ES.fanH}>;   // (the connections found for each place of the layer being grown, until the layer's neurons are known)
var<workgroup> hdep: array<u32, CELLS>;
var<workgroup> hcell: array<u32, CELLS>;
var<workgroup> hcnt: array<u32, CELLS>;
var<workgroup> useful: array<atomic<u32>, CELLS>;
var<workgroup> bsh: array<f32, ${ES.cells + BRAIN.nOut}>;

fn offOf(stage: u32) -> u32 {
  if (stage == 1u) { return ${ES.layerOff[0]}u; }
  if (stage == 2u) { return ${ES.layerOff[1]}u; }
  return ${ES.layerOff[2]}u;
}
fn capOf(stage: u32) -> u32 {
  if (stage == 1u) { return ${ES.layerCap[0]}u; }
  if (stage == 2u) { return ${ES.layerCap[1]}u; }
  return ${ES.layerCap[2]}u;
}
fn layerAt(l: u32) -> f32 { return (${ES.layerAt(0).toFixed(1)}) + (${(ES.layerAt(1) - ES.layerAt(0)).toFixed(1)}) * f32(l); }

fn actv(k: u32, x: f32) -> f32 {
  if (k == 0u) { return 1.0 / (1.0 + exp(-x)); }
  if (k == 1u) { return max(x, 0.0); }
  if (k == 2u) { return tanh(x); }
  if (k == 3u) { return sin(x); }
  return cos(x);
}
// the genome's answer for a receiving place and a sending place
fn cppn(pb: u32, r: vec3<f32>, s: vec3<f32>, lr: f32, ls: f32) -> f32 {
  var vals: array<f32, 64>;
  vals[0] = r.x; vals[1] = r.y; vals[2] = r.z; vals[3] = s.x; vals[4] = s.y; vals[5] = s.z; vals[6] = lr; vals[7] = ls;
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
fn cellAt(d: u32) -> vec3<f32> {
  return vec3<f32>(-1.0 + (2.0 * f32(d / (G * G)) + 1.0) / f32(G), -1.0 + (2.0 * f32((d / G) % G) + 1.0) / f32(G), -1.0 + (2.0 * f32(d % G) + 1.0) / f32(G));
}
fn place(i: u32) -> vec3<f32> { return vec3<f32>(places[i * 3u], places[i * 3u + 1u], places[i * 3u + 2u]); }
fn toH(w: f32) -> u32 { return pack2x16float(vec2<f32>(w, 0.0)) & 0xffffu; }

@compute @workgroup_size(${ES.places})
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) t: u32) {
  let b = wg.y * 65535u + wg.x;
  if (b >= cp.x) { return; }   // (every thread of the workgroup agrees)
  let pb = b * PROGW;
  let base = born[b] * WORDS;
  let me = cellAt(t);
  let ci = t / (G * G);
  let cj = (t / G) % G;
  let cl = t % G;
  if (t < CELLS) { hdep[t] = 0u; hcell[t] = 0u; hcnt[t] = 0u; atomicStore(&useful[t], 0u); }
  workgroupBarrier();

  // layer by layer, every layer with the whole grid of places to itself: a connection is kept where it is strong and differs from what is next door (see esnet.js)
  for (var stage = 1u; stage <= ${ES.stages}u; stage = stage + 1u) {
    var cnt = 0u;
    var nSrc = NIN;
    if (stage > 1u) { nSrc = offOf(stage); }
    for (var k = 0u; k < nSrc; k = k + 1u) {
      var s = vec3<f32>(0.0);
      var sid = 0u;
      var ls = layerAt(0u);
      var isSrc = true;
      if (stage == 1u) {
        sid = (k * ${ES.scramble}u) % NIN;
        s = place(sid);
      } else {
        let ds = workgroupUniformLoad(&hdep[k]);
        let dc = workgroupUniformLoad(&hcell[k]);
        isSrc = ds >= 1u;
        sid = NIN + k;
        s = cellAt(dc);
        ls = layerAt(ds);
      }
      if (isSrc) {
        let w = cppn(pb, me, s, layerAt(stage), ls);
        wsh[t] = w;
        workgroupBarrier();
        let aw = abs(w);
        var band = 0.0;
        for (var a = 0u; a < 3u; a = a + 1u) {
          var st = 1u;
          var pos = cl;
          if (a == 0u) { st = G * G; pos = ci; } else if (a == 1u) { st = G; pos = cj; }
          var dl = aw;
          var dh = aw;
          if (pos > 0u) { dl = abs(w - wsh[t - st]); }
          if (pos < G - 1u) { dh = abs(w - wsh[t + st]); }
          band = max(band, min(dl, dh));
        }
        if (cnt < FANH && aw > ${ES.wThr} && band > ${ES.bandThr}) {
          stg[t * FANH + cnt] = sid | (toH(w) << 16u);
          cnt = cnt + 1u;
        }
        workgroupBarrier();
      }
    }
    // the places with a connection are the layer's neurons (the first of them, in the order of the places, as far as there is room)
    sc[t] = cnt;
    workgroupBarrier();
    var rank = 0u;
    for (var j = 0u; j < t; j = j + 1u) { if (sc[j] > 0u) { rank = rank + 1u; } }
    if (cnt > 0u && rank < capOf(stage)) {
      let id = offOf(stage) + rank;
      for (var q = 0u; q < cnt; q = q + 1u) { wts[base + ENT + id * FANH + q] = stg[t * FANH + q]; }
      hdep[id] = stage;
      hcell[id] = t;
      hcnt[id] = cnt;
    }
    workgroupBarrier();
  }

  // the outputs ask every neuron found for a connection
  var cntO = 0u;
  if (t < NOUT) {
    let oc = place(NIN + t);
    for (var n = 0u; n < CELLS; n = n + 1u) {
      let dn = hdep[n];
      if (dn > 0u && cntO < FANO) {
        let v = cppn(pb, oc, cellAt(hcell[n]), layerAt(${ES.stages + 1}u), layerAt(dn));
        if (abs(v) > ${ES.outThr}) {
          wts[base + OUTAT + t * FANO + cntO] = (NIN + n) | (toH(v) << 16u);
          cntO = cntO + 1u;
          atomicStore(&useful[n], 1u);
        }
      }
    }
  }
  workgroupBarrier();
  // a neuron that cannot reach an output is dropped, and so are the neurons that only fed it
  for (var stage = ${ES.stages}u; stage >= 2u; stage = stage - 1u) {
    if (t < CELLS && hdep[t] == stage && atomicLoad(&useful[t]) == 1u) {
      for (var q = 0u; q < hcnt[t]; q = q + 1u) {
        let src = wts[base + ENT + t * FANH + q] & 0xffffu;
        if (src >= NIN) { atomicStore(&useful[src - NIN], 1u); }
      }
    }
    workgroupBarrier();
  }
  if (t < CELLS) {
    if (atomicLoad(&useful[t]) == 1u) {
      wts[base + t] = hdep[t] | (hcnt[t] << 4u);
      bsh[t] = cppn(pb, cellAt(hcell[t]), vec3<f32>(-1.0, 0.0, 0.0), layerAt(hdep[t]), layerAt(0u));
    } else {
      wts[base + t] = 0u;
      bsh[t] = 0.0;
    }
  }
  if (t < NOUT) {
    wts[base + CELLS + t] = 1u | (cntO << 4u);
    bsh[CELLS + t] = cppn(pb, place(NIN + t), vec3<f32>(-1.0, 0.0, 0.0), layerAt(${ES.stages + 1}u), layerAt(0u));
  }
  workgroupBarrier();
  for (var p = t; p < ${Math.ceil((ES.cells + BRAIN.nOut) / 2)}u; p = p + PLACES) {
    var hi = 0.0;
    if (2u * p + 1u < CELLS + NOUT) { hi = bsh[2u * p + 1u]; }
    wts[base + BIASAT + p] = pack2x16float(vec2<f32>(bsh[2u * p], hi));
  }
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
      light: await make('light', PRELUDE + LIGHT, { ...U2, 2: 'r', 3: 'w' }),
      soil: await make('soil', PRELUDE + SOIL, { ...U2, 2: 'r', 3: 'w', 4: 'r', 5: 'r', 6: 'w', 7: 'w', 8: 'r', 9: 'w' }),
      weather: await make('weather', PRELUDE + WEATHER, { ...U2, 2: 'w', 3: 'w', 4: 'r', 5: 'w', 6: 'w', 7: 'r' }),
      flux: await make('flux', PRELUDE + FLUX, { ...U2, 2: 'r', 3: 'w', 4: 'w', 5: 'r' }),
      gather: await make('gather', PRELUDE + GATHER, { ...U2, 2: 'r', 3: 'r', 4: 'w', 5: 'w', 6: 'r', 7: 'r' }),
      creep: await make('creep', PRELUDE + CREEP, { ...U2, 2: 'r', 3: 'r', 4: 'w', 5: 'w', 6: 'r', 7: 'w' }),
      grow: await make('grow', PRELUDE + GROW, { ...U2, 2: 'r', 3: 'r', 4: 'w', 5: 'w', 6: 'r', 7: 'r', 8: 'w', 9: 'r' }),
      brain: await make('brain', BRAIN_WGSL, { 0: 'u', 1: 'u', 2: 'r', 3: 'r', 4: 'r', 5: 'r', 6: 'r', 7: 'w', 8: 'r', 9: 'u' }),
      scatter: await make('scatter', SCATTER, { 0: 'u', 2: 'r', 3: 'w' }),
      deltas: await make('deltas', DELTAS, { 0: 'u', 2: 'r', 3: 'r', 4: 'w' }),
      cppn: await make('cppn', CPPN_WGSL, { 0: 'u', 2: 'r', 3: 'r', 4: 'r', 5: 'w' }),
    };
    const table = new Float32Array([...RETINA, ...OUTPUTS]);   // where the eye's neurons and the outputs sit, for growing brains
    this.conn = d.createBuffer({ size: table.byteLength, usage: STORE, label: 'places' });
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
    if (3 * L.n > ROWS) throw new Error('the map is too big for the GPU row table');
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
    this.lightBuf = buf(size * 8, STORE, 'light');
    this.iceBuf = buf(size * 16, STORE, 'extra');   // per cell: the ice on the water (a depth of water; it only insulates), the heat a snowpack holds, and the temperature of the deep ground, kept on the card
    this.theta = [buf(size * 4, STORE, 'air0'), buf(size * 4, STORE, 'air1')]; this.pt = 0;   // the air's potential temperature, twice (what was there, what is now)
    this.readT = buf(size * 4, MAP_READ, 'readAir');
    this.dlBuf = buf(size * 16, STORE, 'deltas');
    this.fluxA = buf(size * 16, STORE, 'fluxA');
    this.fluxB = buf(size * 16, STORE, 'fluxB');
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
      st[8 * i] = L.elev[i]; st[8 * i + 1] = L.hKm[i]; st[8 * i + 2] = L.outlet[i]; st[8 * i + 3] = L.skyH ? L.skyH[i] : 0;
      st[8 * i + 4] = L.nE[i]; st[8 * i + 5] = L.nN[i]; st[8 * i + 6] = L.nU[i]; st[8 * i + 7] = L.zKm[i];
    }
    d.queue.writeBuffer(this.stat, 0, st);
    this.fresh = true;   // the first step sends the starting ground up

    // animals
    this.cap = 0; this.next = 0; this.free = [];
    this.wts = null;
    this.pending = [];
    this.anCap = 0;
    this.progCap = 0;
    this.BP = buf(48, UNI, 'brain params');
    this.rayTab = buf(RAY_PACKED.length * 4, UNI, 'rays');
    d.queue.writeBuffer(this.rayTab, 0, RAY_PACKED);
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
      const th = Float32Array.from(L.theta), ex = new Float32Array(size * 4); for (let i = 0; i < size; i++) ex[4 * i + 2] = L.tDeep[i];
      q.writeBuffer(this.theta[this.pt], 0, th); q.writeBuffer(this.iceBuf, 0, ex);
      this.fresh = false;
    }

    // parameters and the row table
    const dx = L.cellMetres ?? L.run * (L.metresPerUnit || 1);
    const pd = this.paramData, vals = { n, size, raining: L.raining ? 1 : 0, rainD: L.rainDepth * w.clim.wet, heatGain: L.heatGain, gammaDry: L.gammaDry, albedoWater: SUBSTANCES.water.albedo, albedoIce: SUBSTANCES.ice.albedo, freeLapse: w.clim.freeLapse, windC: (L.windFactor * w.clim.w700E * w.clim.dt) / dx, windR: (L.windFactor * w.clim.w700N * w.clim.dt) / dx, dtDx: w.clim.dt / dx, hblMin: L.hblMin, hblMax: L.hblMax, kBL: L.kBL, drain: L.drain, drainMax: L.drainMax, mixConv: 1 - Math.exp(-w.clim.dt / L.tauConv), mixStable: 1 - Math.exp(-w.clim.dt / L.tauStable), rhoCp: PHYS.rhoAir * PHYS.cpAir, deepK: 1 - Math.exp((-w.clim.accel * w.clim.dt) / L.tauDeep), kOro: w.clim.kOro, albedo: L.albedo, snowAlbedoDepth: L.snowAlbedoDepth, invWs: L.invWs, retain: L.retain, flowMin: L.flowMin, soakMax: Math.min(L.soakMax, 1e30), floodStart: L.floodStart, floodEnd: L.floodEnd, nMobile: L.nMobile, waterHeatMax: L.waterHeatMax, cDry: L.cDry, cWaterU: (PHYS.cWater * L.waterMm) / 1000, kg: L.waterMm, hUnstable: L.hUnstable, rGround: L.dGround / L.kGround, albedoOld: L.albedoOld, compactK: (w.clim.accel * w.clim.dt) / (L.compactDays * 86400), iceRes: L.waterMm / L.rhoIce / L.kIce, gDeep: L.gDeep, gLake: L.gLake, iceMin: L.iceMin, snowRetain: L.snowRetain, gTop: L.gTop, coldK: L.coldK, lnTrans: Math.log(L.trans), lwCloud: L.lwCloud, emis: L.emis, hAir: L.hAir, hSnow: L.hSnow, ptAlpha: L.ptAlpha, wetCrit: L.wetCrit, dt: w.clim.dt, accel: w.clim.accel, deposit: L.deposit, seep: L.seep, floodSeep: L.floodSeep, seepMax: L.seepMax, flow: L.flow, creep: L.creep, leach: L.leach, outletRate: L.outletRate, regrow: L.regrow, gMax: L.gMax, waterPer: L.waterPer, nPer: L.nPer, shadows: L.skyH ? 1 : 0, cellRun: L.run, skyMax: L.skyMax ?? 0 };
    LAND_FIELDS.forEach(([k, t], i) => (t === 'u32' ? pd.setUint32(i * 4, vals[k], true) : pd.setFloat32(i * 4, vals[k], true)));
    q.writeBuffer(this.P, 0, pd);
    const rd = this.rowData, c = w.clim;
    for (let r = 0; r < n; r++) {
      const o = r * 8;
      rd[o] = c.up[r]; rd[o + 1] = c.east[r]; rd[o + 2] = c.north[r]; rd[o + 3] = c.sun[r]; rd[o + 4] = c.free[r]; rd[o + 5] = c.rain[r]; rd[o + 6] = c.sinLat[r]; rd[o + 7] = c.cosLat[r];
    }
    for (let k = 0; k < n; k++) { const o = 8 * n + 4 * k; rd[o] = L.colA[k]; rd[o + 1] = L.colB[k]; rd[o + 2] = c.sd; rd[o + 3] = 0; }
    q.writeBuffer(this.rows, 0, rd, 0, n * 12);

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
      ad[4 * k] = (a.slot | (a.h << 24) | (a.eyes << 27) | (a.energy > 1 ? 0x80000000 : 0)) >>> 0;
      ad[4 * k + 1] = a.r * n + a.c;
      af[4 * k + 2] = a.col[1]; af[4 * k + 3] = a.col[2];
    }
    if (count) q.writeBuffer(this.an, 0, ad, 0, count * 4);
    const bpd = new ArrayBuffer(48), bpu = new Uint32Array(bpd), bpf = new Float32Array(bpd);
    bpu[0] = count; bpu[1] = n; bpf[4] = w.climb; bpf[5] = w.swim; bpf[6] = w.snowCost; bpf[7] = w.snowCap; bpf[8] = w.swimDepth; bpf[9] = L.cellRun ?? 1; bpf[10] = L.metresPerUnit ? EYES.eye / L.metresPerUnit : 0; bpf[11] = EYES.tol;
    q.writeBuffer(this.BP, 0, bpd);

    // newborn brains: grown from their genomes' programs
    const born = this.pending.filter((o) => w.animals.get(o.id) === o && o.slot >= 0);
    this.pending = [];
    const progs = [], slots = [];
    let progData = null;
    if (born.length) {
      progData = new Uint32Array(born.length * PROGRAM.words);
      for (const o of born) {
        const at = progs.length * PROGRAM.words;
        if (encodeProgram(o.genome, progData, at)) { progs.push(o); slots.push(o.slot); }
        else q.writeBuffer(this.wts, o.slot * BRAIN.words * 4, packNet(o.genome));   // too big for the card's fixed registers: grown here instead
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
      p.dispatchWorkgroups(Math.min(nBorn, 65535), Math.ceil(nBorn / 65535));
      p.end();
    }
    const run = enc.beginComputePass();
    const go = (pass, ...res) => { run.setPipeline(pass.pipeline); run.setBindGroup(0, this.bg(pass, ...res)); run.dispatchWorkgroups(this.groups); };
    const A = () => this.A[this.pa], B = () => this.B[this.pb];
    const base = [this.P, this.rows];
    go(P.apply, ...base, A(), B(), this.dlBuf);
    go(P.light, ...base, this.stat, this.lightBuf);
    go(P.soil, ...base, A(), this.A[1 - this.pa], this.stat, this.lightBuf, this.acc, this.iceBuf, this.theta[this.pt], this.theta[1 - this.pt]); this.pa ^= 1; this.pt ^= 1;
    go(P.weather, ...base, A(), B(), this.stat, this.acc, this.iceBuf, this.theta[this.pt]);
    for (let s = 0; s < L.flowSteps; s++) {
      go(P.flux, ...base, A(), this.fluxA, this.fluxB, this.stat);
      go(P.gather, ...base, A(), B(), this.A[1 - this.pa], this.B[1 - this.pb], this.fluxA, this.fluxB); this.pa ^= 1; this.pb ^= 1;
    }
    go(P.creep, ...base, A(), B(), this.A[1 - this.pa], this.B[1 - this.pb], this.stat, this.acc); this.pa ^= 1; this.pb ^= 1;
    go(P.grow, ...base, A(), B(), this.A[1 - this.pa], this.B[1 - this.pb], this.stat, this.dlBuf, this.acc, this.lightBuf); this.pa ^= 1; this.pb ^= 1;
    run.end();

    if (count) {
      const bp = enc.beginComputePass();
      bp.setPipeline(P.scatter.pipeline);
      bp.setBindGroup(0, this.bg(P.scatter, this.BP, this.an, this.cell));
      bp.dispatchWorkgroups(Math.ceil(count / 64));
      bp.setPipeline(P.brain.pipeline);
      bp.setBindGroup(0, this.bg(P.brain, this.BP, this.rows, this.an, this.cell, A(), this.stat, this.wts, this.res, this.lightBuf, this.rayTab));
      bp.dispatchWorkgroups(Math.min(count, 65535), Math.ceil(count / 65535));
      bp.end();
      enc.copyBufferToBuffer(this.res, 0, this.readRes, 0, count * 4);
    }
    enc.copyBufferToBuffer(A(), 0, this.readA, 0, size * 16);
    enc.copyBufferToBuffer(this.theta[this.pt], 0, this.readT, 0, size * 4);
    q.submit([enc.finish()]);
    const t1 = performance.now();

    await Promise.all([this.readA.mapAsync(1), this.readT.mapAsync(1), count ? this.readRes.mapAsync(1, 0, count * 4) : null]);
    const tWait = performance.now();
    const fa = new Float32Array(this.readA.getMappedRange());
    const G = L.grass, Wt = L.water, S = L.snow, T = L.soil;
    for (let i = 0, j = 0; i < size; i++, j += 4) { G[i] = fa[j]; Wt[i] = fa[j + 1]; S[i] = fa[j + 2]; T[i] = fa[j + 3]; }
    this.readA.unmap();
    { const th = new Float32Array(this.readT.getMappedRange()), TH = L.theta, AIR = L.air, Z = L.zKm, gd = L.gammaDry; for (let i = 0; i < size; i++) { TH[i] = th[i]; AIR[i] = th[i] - gd * Z[i]; } this.readT.unmap(); L.temp = AIR[((this.n >> 1) * this.n) + (this.n >> 1)]; }
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
    for (const b of [...this.A, ...this.B, this.stat, this.lightBuf, this.iceBuf, ...this.theta, this.readT, this.dlBuf, this.fluxA, this.fluxB, this.acc, this.P, this.rows, this.readA, this.readB, this.readAcc, this.wts, this.an, this.res, this.readRes, this.BP, this.CP, this.DP, this.tIdx, this.tVal, this.cell, this.prog, this.bornBuf]) b?.destroy();
    this.L.dev = null;
  }
}
