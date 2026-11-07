// The ground: height, water, snow, nitrogen, grass and ground temperature on every cell of a map with walls on all four sides (real elevation data, see terrain.js).
//
// Precipitation falls evenly, more in wetter months, as rain, or as snow where it is cold (higher ground is colder, so it snows there
// first and stays longest). Snow piles up and melts at a rate that grows with how far the air is above freezing; the meltwater
// joins the rest. Water runs downhill (it fills in the low ground, so what
// flows is the difference in water *surface*, elevation plus depth), carrying dissolved nitrogen with it, and leaves by
// evaporation and by being drunk by plants. Nitrogen also creeps from cell to cell on its own. Every amount that enters or
// leaves is written to a ledger so the totals can be checked: start + in - out = now.
//
// Grass grows on every cell from light, water and nitrogen. Growing drinks the water and takes the nitrogen out of the soil
// (the plant holds it until it dies back, or is eaten); an animal standing on a cell shades it, so nothing grows there; and
// grass does not grow when the cell is flooded, dried out or frozen.
//
// The ground temperature follows the air above it (colder up the hill, warmer in sun-facing slopes) and conducts to the cells around it; it melts the snow,
// slows the grass and is warmed by the animals standing on it.
//
// This file is the CPU version, and the reference. With WebGPU gpu.js runs the same passes as compute shaders (and the animals' effects on the ground
// are collected here as deltas, see `delta`). This file has no DOM in it.
import { makeRng } from './sim.js';

// The regional weather the map is given, as it would be for any weather generator: how much precipitation (mm) falls in an average month over the whole
// map, from the PRISM 1991-2020 normals (https://prism.oregonstate.edu/normals/) averaged over it. May and June are the wettest months and July to September the driest.
// Where it falls, how much as snow, and how warm it is are then up to the ground and the height of every cell (see climateRows and Land.step).
const MONTH_RAIN = [36, 33, 38, 51, 66, 56, 30, 27, 35, 40, 35, 38];
const MONTH_MID = [15.5, 45, 74.5, 105, 135.5, 166, 196.5, 227.5, 258, 288.5, 319, 349.5];   // middle day of each month
const RAIN_MEAN = MONTH_RAIN.reduce((x, y) => x + y, 0) / 12;

/** The colours of the land view, which the animals see too: bare ground shaded by height and by how the sun falls on the slope, with grass, water and snow mixed over it.
 *  `landRgb` writes the red, green and blue (0-255) of a cell with the given height, slope light (the sunlight on it minus what flat ground there gets), grass, water and snow into `out`. */
export const LANDVIEW = {
  earth: [222, 212, 186], green: [52, 152, 84], water: [48, 112, 214], snow: [250, 252, 255],
  heightGain: 0.05, slopeGain: 0.8, reliefMax: 1.25,
  grassFull: 4, grassMax: 0.95, waterFull: 1.8, waterMax: 0.8, snowFull: 0.8, snowMax: 0.9,
};
export function landRgb(height, slope, grass, water, snow, out) {
  const V = LANDVIEW, E = V.earth;
  const relief = Math.max(0, Math.min(V.reliefMax, 0.55 + V.heightGain * height + V.slopeGain * slope));
  let r = E[0] * relief, g = E[1] * relief, b = E[2] * relief;
  let f = Math.min(V.grassMax, grass / V.grassFull);
  r += (V.green[0] - r) * f; g += (V.green[1] - g) * f; b += (V.green[2] - b) * f;
  f = Math.min(V.waterMax, water / V.waterFull);
  r += (V.water[0] - r) * f; g += (V.water[1] - g) * f; b += (V.water[2] - b) * f;
  f = Math.min(V.snowMax, snow / V.snowFull);
  r += (V.snow[0] - r) * f; g += (V.snow[1] - g) * f; b += (V.snow[2] - b) * f;
  out[0] = Math.min(255, r); out[1] = Math.min(255, g); out[2] = Math.min(255, b);
}

/** How much more precipitation falls per km of height: `mean` through the year, `amp` more in midwinter and less in midsummer. */
export const ORO = { mean: 0.72, amp: 0.38 };

/** How much rain falls at `doy` (day of the year, from 0) compared with an average day: 1 is average. */
export function rainFactor(doy) {
  let k = 11;
  for (let i = 0; i < 12; i++) if (MONTH_MID[i] <= doy) k = i;
  const d0 = MONTH_MID[k], d1 = k === 11 ? MONTH_MID[0] + 365 : MONTH_MID[k + 1];
  const x = (((doy - d0) % 365) + 365) % 365 / (d1 - d0), f = (1 - Math.cos(Math.PI * x)) / 2;
  return (MONTH_RAIN[k] + (MONTH_RAIN[(k + 1) % 12] - MONTH_RAIN[k]) * f) / RAIN_MEAN;
}

/** The step's date: the world starts at noon on the summer solstice, 21 June (day 172 of 365). */
export function dayOfYear(t, dayLength, yearDays) {
  return (172 + (365 * (t % (dayLength * yearDays))) / (dayLength * yearDays)) % 365;
}

/** The latitude of a row: by default the top of the map is 65 degrees north and the bottom 25, with Yellowstone's 45 in the middle. */
export const latOfRow = (r, n, top = 65, bottom = 25) => top - ((top - bottom) * r) / (n - 1);

const RAD = Math.PI / 180;
const DIRS8 = [[-1, 0], [0, 1], [1, 0], [0, -1], [-1, -1], [-1, 1], [1, 1], [1, -1]];   // up, right, down, left, up-left, up-right, down-right, down-left
const DW8 = DIRS8.map(([a, b]) => (a && b ? Math.SQRT1_2 : 1));      // a diagonal step is longer, so the slope along it is gentler

/** The sun's declination (how far north of the equator it is overhead, in radians) on day N of the year, N = 1 on 1 January: the standard almanac formula, which allows for the Earth's elliptical orbit. It peaks at 23.44 degrees on the June solstice. */
export const declination = (N) => -Math.asin(0.39779 * Math.cos(0.98565 * RAD * (N + 10) + 1.914 * RAD * Math.sin(0.98565 * RAD * (N - 2))));

/** The equation of time, in minutes, on day N: how far a sundial runs ahead of a clock that keeps even time (about +16 in early November, -14 in mid February). */
export const equationOfTime = (N) => { const B = (2 * Math.PI * (N - 81)) / 365; return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); };

export const SHADOW_SOFT = 0.03;  // the sun is half hidden when its height (as a sine) is just the skyline's, and fully hidden at this much below it, so shadows have soft edges (cells are 1.5 km across: a hill inside one only half covers it)
export const SHADOW_REACH = 40;   // how far a hill can throw a shadow, in cells (60 km)

/**
 * The sun and the weather for every row of an n-row map at step t. The sun is placed where it really would be, from the row's latitude,
 * the date (it is over 23.44 degrees north at midsummer and the same south at midwinter) and the hour by the sundial, which runs a little
 * ahead of or behind the clock through the year (due south at noon, east of south in the morning). From that, `sun` is how high it is for flat ground (0 at night, 1 straight overhead), and `east`, `north`
 * and `up` are the direction to it, which a slope uses to work out how squarely it faces the sun. The air temperature falls with
 * latitude and swings more between summer and winter further north. For the sun's place at a cell that is not on the middle meridian, `sunlight` needs
 * the sine and cosine of the sundial's hour angle there (`ch`, `sh`), of the declination (`sd`, `cd`) and of every row's latitude (`sinLat`, `cosLat`). `rain` is how wet the row's latitude is, and `wet` how wet the month is.
 * `rainSwing` is how much of the real rainfall seasonality to keep (1 = all of it, 0 = none).
 */
export function climateRows(t, n, dayLength = 60, yearDays = 30, rainSwing = 1, top = 65, bottom = 25) {
  const day = (2 * Math.PI * t) / dayLength, yr = day / yearDays;   // `day` is the clock's hour angle: 0 at noon (local solar time)
  const season = Math.cos(yr);   // 1 at midsummer, -1 at midwinter
  const doy = dayOfYear(t, dayLength, yearDays);   // day 1 is 1 January, so the start (21 June) is day 172
  const hour = day + (equationOfTime(doy) * 2 * Math.PI) / 1440;   // the sundial's hour angle: ahead of the clock when the equation of time is positive
  const ch = Math.cos(hour), sh = Math.sin(hour);
  const tday = 4 * Math.cos(day - 0.6);
  const decl = declination(doy), sd = Math.sin(decl), cd = Math.cos(decl);
  const f = 1 + rainSwing * (rainFactor(dayOfYear(t, dayLength, yearDays)) - 1);
  const sun = new Float64Array(n), temp = new Float64Array(n), rain = new Float64Array(n), sinLat = new Float64Array(n), cosLat = new Float64Array(n);
  const east = new Float64Array(n), north = new Float64Array(n), up = new Float64Array(n);
  // The regional climate, fitted to the PRISM normals over the map: at the map's average height the air averages 5.1 C and swings 11.9 C either way
  // through the year, warmest around 21 July. Going north it is colder by about 0.85 C a degree in summer and about nothing in winter. The air cools
  // with height by about 6 C a km in summer but less (2 to 3) in winter, when cold air pools in the valleys.
  const N = doy, mid = (top + bottom) / 2, w = (2 * Math.PI * N) / 365;
  const tRef = 5.1 + 11.9 * Math.cos(w - (2 * Math.PI * 202) / 365), tLat = -0.4 - 0.45 * Math.cos(w - (2 * Math.PI * 200) / 365);
  const lapse = 4.6 + 1.6 * Math.cos(w - (2 * Math.PI * 170) / 365);
  // How much more precipitation falls the higher the ground: about 110% of the average for each km in winter, 35% in summer (the westerlies are stronger in winter),
  // and how much of it falls in the north rather than the south (more in the north, most of all in early summer)
  const kOro = ORO.mean + ORO.amp * Math.cos(w - (2 * Math.PI * 15) / 365), north2south = 0.9 + 0.45 * Math.cos(w - (2 * Math.PI * 190) / 365);
  for (let r = 0; r < n; r++) {
    const lat = latOfRow(r, n, top, bottom), phi = (lat * Math.PI) / 180, sp = Math.sin(phi), cp = Math.cos(phi);
    sinLat[r] = sp; cosLat[r] = cp;
    up[r] = sp * sd + cp * cd * ch;
    east[r] = -cd * sh;
    north[r] = sd * cp - cd * sp * ch;
    sun[r] = Math.max(0, up[r]);
    temp[r] = tRef + tLat * (lat - mid) + tday;
    rain[r] = Math.max(0.05, 1 + (north2south * (lat - mid)) / (top - bottom));
  }
  return { sun, east, north, up, temp, rain, lapse, kOro, wet: Math.sqrt(Math.max(0, f)), season, sd, cd, ch, sh, sinLat, cosLat };
}

export class Land {
  /**
   * opts: seed, size (100), relief (6: the tallest ground is this much above the lowest, in the same units as water depth),
   *       rainChance (0.1: chance per step of a shower in an average season), rainDepth (0.075: depth of an average shower),
   *       evap (0.008: water lost per step from a bare cell at noon in summer), lapse (1.2: degrees colder per unit of height), meltRate (0.016: snow melted per degree above freezing per step), outletShare (0.03: the lowest ground that drains away as a river) and outletRate (0.3 of its water per step), seep (0.01: share of the surface water that soaks below the roots per step, plus floodSeep = 0.05 of any water deeper than 1.5, at most seepMax = 0.08 a cell), flow (0.2: share of a height difference that runs off per step),
   *       grass (1: starting amount on every cell), gMax (10: the most a cell can hold), regrow (0.04: growth rate per step at full light, moisture and nitrogen),
   *       waterPer (0.3: water used per unit grown), nPer (0.02: nitrogen held per unit of grass),
   *       creep (0.02: share of a cell's nitrogen that spreads to its neighbours per step), leach (0.0005), deposit (0.00005: nitrogen in the rain)
   */
  constructor(opts = {}) {
    const n = (this.n = opts.size ?? 200);
    this.rng = makeRng((opts.seed ?? 1) * 7919 + 13);   // its own stream, so the weather does not shift when the animals do
    this.relief = opts.relief ?? 6;
    this.erodeK = opts.erodeK ?? 0.004;   // how fast rivers dig
    this.pitDepth = opts.pitDepth ?? 1.2;  // pits shallower than this are filled in; deeper ones stay as lakes
    this.rainChance = opts.rainChance ?? 0.1;
    this.rainDepth = opts.rainDepth ?? 0.075;
    this.evap = opts.evap ?? 0.008;
    this.lapse = opts.lapse ?? 1.2;
    this.meltRate = opts.meltRate ?? 0.016;
    this.flow = opts.flow ?? 0.2;
    this.flowSteps = opts.flowSteps ?? 4;
    this.creep = opts.creep ?? 0.02;
    this.seep = opts.seep ?? (opts.terrain ? 0.0005 : 0.01);   // (on a real map only the top layer soaks away, and slowly: most of the rain runs off, is drunk or evaporates)
    this.floodSeep = opts.floodSeep ?? (opts.terrain ? 0 : 0.05);   // (the toy water of a made-up map) flood water, deeper than 1.5, drains this share of the excess per step
    this.seepMax = opts.seepMax ?? 0.08;   // ...but no more than this per cell, so a lake loses water at a fixed rate per square of its surface
    this.leach = opts.leach ?? 0.0005;
    this.deposit = opts.deposit ?? 0.00005;

    const size = n * n;
    this.row = new Uint16Array(size);   // which row each cell is in (rows run from north to south)
    for (let i = 0; i < size; i++) this.row[i] = (i / n) | 0;
    this.rowTemp = new Float64Array(n).fill(8);   // the air temperature at the middle height, row by row (set by each step)
    this.elev = new Float64Array(size);
    this.water = new Float64Array(size).fill(opts.water ?? 0.5);
    this.nitrogen = new Float64Array(size).fill(opts.nitrogen ?? 0.3);
    this.snow = new Float64Array(size);   // snowpack, in water depth
    this.lake = new Uint8Array(size);     // 1 on the cells that are lake
    this.grass = new Float64Array(size).fill(opts.grass ?? 1);
    this.gMax = opts.gMax ?? 10;
    this.regrow = opts.regrow ?? 0.04;
    this.waterPer = opts.waterPer ?? 0.3;
    this.nPer = opts.nPer ?? 0.02;
    this.bury = opts.bury ?? 4;   // the depth of snow that buries the grass completely
    this._g = new Float64Array(size);
    this._w = new Float64Array(size);
    this._n = new Float64Array(size);
    this._f8 = new Float64Array(8);
    this.cellRun = null;
    this.west = this.east = null;
    if (opts.terrain) this.loadTerrain(opts.terrain, opts); else this.makeTerrain();
    // which way each cell's slope faces, for the sun: the unit normal to the ground (east, north, up). `run` is how far across a cell is in the same
    // units as height, so it sets how steep the hills really are.
    this.run = opts.run ?? this.cellRun ?? 1;
    this.nE = new Float32Array(size); this.nN = new Float32Array(size); this.nU = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const gx = (this.elev[this.nb(i, 1)] - this.elev[this.nb(i, 3)]) / (2 * this.run), gy = (this.elev[this.nb(i, 0)] - this.elev[this.nb(i, 2)]) / (2 * this.run);
      const m = Math.hypot(gx, gy, 1);
      this.nE[i] = -gx / m; this.nN[i] = -gy / m; this.nU[i] = 1 / m;
    }
    this.nbr = new Int32Array(4 * size);   // the four neighbours (up, right, down, left) of every cell, so the hot loops need no division
    for (let i = 0; i < size; i++) for (let d = 0; d < 4; d++) this.nbr[4 * i + d] = this.nb(i, d);
    // all eight neighbours (up, right, down, left, then the diagonals), for water: it runs downhill in any of eight directions, the way the ground was filled in. A cell on the map's edge is its own neighbour there.
    this.nbr8 = new Int32Array(8 * size);
    for (let i = 0; i < size; i++) {
      const r = (i / n) | 0, c = i - r * n;
      DIRS8.forEach(([dr, dc], k) => { const rr = r + dr, cc = c + dc; this.nbr8[8 * i + k] = rr < 0 || rr >= n || cc < 0 || cc >= n ? i : rr * n + cc; });
    }
    this.light = new Float32Array(size);   // the sunlight each cell gets now: slopes facing the sun get more than flat ground, slopes facing away less
    this.flat = new Float64Array(n);       // ...and what flat ground at each row gets
    this.slope = new Float32Array(size);   // the sunlight on each cell minus what flat ground there gets: positive on slopes facing the sun, negative on ones turned away or in shade
    // the ground is heated by the sun it absorbs and cooled by radiating heat away (and loses it to the air above): where the air is `a` degrees, bare ground in full sun settles `sunHeat`
    // degrees above it, and the dark ground at night `radCool` below it. Snow reflects most of the sun, so snow-covered ground stays cold.
    this.sunHeat = opts.sunHeat ?? 14;
    this.radCool = opts.radCool ?? 2;
    this.albedo = opts.albedo ?? 0.2;            // the share of sunlight bare, grassy ground reflects
    this.snowAlbedo = opts.snowAlbedo ?? 0.8;    // ...and fresh snow
    this.snowAlbedoDepth = opts.snowAlbedoDepth ?? 0.3;   // (snow this deep covers the ground completely)
    // the river leaves the map: water that reaches the outlet (the lowest ground, or on a real map the edges) drains away, with the nitrogen dissolved in it
    this.outlet = new Uint8Array(size);
    if (opts.terrain) {   // a real map: rivers leave across its edges
      for (let i = 0; i < size; i++) { const r = (i / n) | 0, c = i - r * n; if (r === 0 || c === 0 || r === n - 1 || c === n - 1) this.outlet[i] = 1; }
    } else {
      const sorted = Float64Array.from(this.elev).sort();
      const cut = sorted[Math.floor((opts.outletShare ?? 0.03) * size)];
      for (let i = 0; i < size; i++) if (this.elev[i] <= cut) this.outlet[i] = 1;
    }
    this.outletRate = opts.outletRate ?? 0.3;
    // how high each cell is above the map's average height, in km (the air temperature the page shows is the one at that height)
    this.hKm = new Float64Array(size);
    const meanElev = this.sum(this.elev) / size, kmPerUnit = this.metresPerUnit ? this.metresPerUnit / 1000 : this.lapse / 6.5;
    for (let i = 0; i < size; i++) this.hKm[i] = (this.elev[i] - meanElev) * kmPerUnit;
    this.chill = new Float64Array(size);   // how much colder than the map's average height each cell's air is right now (the air cools faster with height in summer than in winter)
    this.kOro = 0.72;                       // how much more it rains per km of height right now (set each step from the season)
    this.updateChill(6);

    // ground temperature: one number per cell. It follows the air above it with a lag, conducts to the eight cells around it, and is
    // warmed by the animals standing on it. Snow melts by it, grass grows by it, and animals feel it.
    this.soil = new Float64Array(size);
    this._s = new Float64Array(size);
    this.soilFresh = true;                    // set to the air temperature on the first step
    this.soilLag = opts.soilLag ?? 0.05;      // the share of the gap to the air that closes each step
    this.soilConduct = opts.soilConduct ?? 0.3;  // the share of the gap to its neighbours' average that closes each step
    this.heatGain = opts.heatGain ?? 15;      // degrees of ground warming from an animal burning one unit of energy
    this.immerse = opts.immerse ?? 3;           // standing in cold water makes the chill this many times worse...
    this.immerseDepth = opts.immerseDepth ?? 1; // ...once the water is this deep (shallower is in proportion)
    this.waterHeat = opts.waterHeat ?? 1;     // water holds heat: each unit of depth adds this much to a cell's heat capacity (dry ground is 1; a toy-scale choice, about right for the daily swing)
    this.waterHeatMax = opts.waterHeatMax ?? 5;  // (deeper than this, it is the same as this deep)

    // Water is still counted in the old unit, about 37 mm of water, but on a real map its level is now compared with the ground in real terms (a unit of height is a few hundred metres),
    // and the first `flowMin` of the water on a cell does not run off at all: soil, grass and the small dips of the ground hold it. Only what lies above that flows, so rain soaks in and feeds
    // the grass, snowmelt and storms run off in streams, and deep water (lakes) lies level and spills at its lowest rim. (It is the water above the stored layer that moves, not all of a cell's
    // water once it passes a depth: a cell that was just deeper would otherwise send nearly all it has to its neighbours at once, they would be deeper than it, and the water would slosh back and forth.)
    const phys = !!opts.terrain;
    this.waterMm = opts.waterMm ?? 37.1;                                            // mm of water in a unit
    this.invWs = opts.invWs ?? (phys ? (this.metresPerUnit * 1000) / this.waterMm : 1);   // units of water in a unit of height
    this.retain = opts.retain ?? (phys ? 2.7 : 0);                                  // (2.7 units is 0.1 m)
    this.flowMin = opts.flowMin ?? (phys ? 0.7 : 0);                                // (0.7 units is 26 mm: the depth of water every cell holds back; grass is very sensitive to it)
    this.soakMax = opts.soakMax ?? (phys ? this.retain : Infinity);                // only the top layer soaks away; deep water does not
    this.nMobile = opts.nMobile ?? (phys ? 0.1 : 1);                                 // the share of a cell's nitrogen that is dissolved in its water, and so runs off with it
    this.floodStart = opts.floodStart ?? (phys ? this.retain : 1.5);               // grass is flooded when the water on it is deeper than this...
    this.floodEnd = opts.floodEnd ?? (phys ? 3 * this.retain : 2.5);               // ...and drowned when it is deeper than this
    if (phys && opts.lakes) this.carveLakes(opts.lakes);
    // The sun is not up at the same moment across the map: it reaches a place 4 minutes sooner for every degree of longitude east of it. Each column's sundial
    // is ahead of the middle meridian's by its longitude (in radians) east of the middle.
    this.colCos = new Float64Array(n).fill(1); this.colSin = new Float64Array(n);
    this.colA = new Float64Array(n); this.colB = new Float64Array(n);
    if (this.west !== null) for (let c = 0; c < n; c++) { const d = ((this.west + ((c + 0.5) / n) * (this.east - this.west) - (this.west + this.east) / 2) * Math.PI) / 180; this.colCos[c] = Math.cos(d); this.colSin[c] = Math.sin(d); }
    // ...and ridges throw shadows. The sun sees the lakes' surface, not their bed.
    this.skyH = null;
    if (phys && opts.shadows !== false) {
      this.skyH = new Float32Array(size);
      for (let i = 0; i < size; i++) this.skyH[i] = this.elev[i] + (this.lake[i] ? (this.water[i] * this.waterMm) / 1000 / this.metresPerUnit : 0);
      this.skyMax = this.skyH.reduce((m, v) => Math.max(m, v), -Infinity);
    }

    this.start = { water: this.sum(this.water), nitrogen: this.sum(this.nitrogen) + this.nPer * this.sum(this.grass) };
    this.ledger = { rain: 0, evap: 0, seep: 0, river: 0, uptake: 0, nIn: 0, nLeach: 0 };
    this.raining = false;
    this.dev = null;   // the GPU side (gpu.js), when the ground runs there
  }
  // (this.lake: see the constructor)

  sum(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }

  /**
   * Ground that looks like ground, and wraps around the edges: layers of gradient noise (broad hills under finer and finer
   * detail) with the ridges sharpened, then eroded the way rivers do it. Water that runs downhill digs the cells it passes,
   * the more the more cells drain through them, so the hills fold into branching valleys that all lead to the lowest ground.
   * Pits too shallow to hold a pond are filled in; the few deep ones stay as lakes.
   */
  makeTerrain() {
    const n = this.n, size = n * n, rng = this.rng, E = this.elev;

    // --- gradient noise on a lattice that wraps: `g` cells across the map
    const lattice = (g) => {
      const v = new Float64Array(g * g * 2);
      for (let i = 0; i < g * g; i++) { const a = rng.uniform(0, 2 * Math.PI); v[i * 2] = Math.cos(a); v[i * 2 + 1] = Math.sin(a); }
      return { g, v };
    };
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const noise = (L, x, y) => {   // x, y in lattice units
      const g = L.g, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const ix0 = ((x0 % g) + g) % g, ix1 = (ix0 + 1) % g, iy0 = ((y0 % g) + g) % g, iy1 = (iy0 + 1) % g;
      const dot = (ix, iy, dx, dy) => L.v[(iy * g + ix) * 2] * dx + L.v[(iy * g + ix) * 2 + 1] * dy;
      const u = fade(fx), w = fade(fy);
      const a = dot(ix0, iy0, fx, fy), b = dot(ix1, iy0, fx - 1, fy), c = dot(ix0, iy1, fx, fy - 1), d = dot(ix1, iy1, fx - 1, fy - 1);
      return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * w;
    };
    const unit = n / 100;   // features keep their size in cells however big the map is
    const octaves = [3, 6, 12, 24, 48].map((g) => g * unit).map((g, k) => ({ L: lattice(g), amp: Math.pow(0.5, k) }));
    const warp = [lattice(3 * unit), lattice(3 * unit)];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      // bend the map a little so nothing lines up with the grid
      const wx = (c / n) * 3 * unit, wy = (r / n) * 3 * unit;
      const x = c / n + 0.12 * noise(warp[0], wx, wy), y = r / n + 0.12 * noise(warp[1], wx, wy);
      let base = 0, ridge = 0;
      for (let k = 0; k < octaves.length; k++) {
        const o = octaves[k], v = noise(o.L, x * o.L.g, y * o.L.g);
        base += o.amp * v;
        if (k < 4) ridge += o.amp * (1 - Math.abs(v * 1.8)) ** 2;   // sharp crests
      }
      E[r * n + c] = base + 0.9 * ridge;
    }
    this.normalise();

    // --- erosion: rivers dig valleys (stream power: erosion ~ sqrt(area drained) x slope), the hillsides slump a little
    const root = this.lowest();
    for (let it = 0; it < 30; it++) {
      const { F, down, order } = this.drainage(root);
      const area = new Float64Array(size).fill(1);
      for (let k = size - 1; k >= 0; k--) { const i = order[k]; if (down[i] >= 0) area[down[i]] += area[i]; }   // from the highest cell down
      const dE = new Float64Array(size);
      for (let i = 0; i < size; i++) {
        const j = down[i];
        if (j < 0) continue;
        const dist = this.dist(i, j), slope = (F[i] - F[j]) / dist;
        dE[i] = Math.min(this.erodeK * Math.sqrt(area[i]) * slope, 0.5 * Math.max(0, E[i] - E[j]));
      }
      for (let i = 0; i < size; i++) E[i] -= dE[i];
      for (let i = 0; i < size; i++) {   // hillslope creep
        let m = 0; for (let d = 0; d < 4; d++) m += E[this.nb(i, d)];
        dE[i] = 0.06 * (m / 4 - E[i]);
      }
      for (let i = 0; i < size; i++) E[i] += dE[i];
      this.normalise();
    }

    // --- fill the pits too shallow to be ponds, and leave the deep ones as lakes
    const { F } = this.drainage(root);
    for (let i = 0; i < size; i++) if (F[i] - E[i] < this.pitDepth) E[i] = F[i];
    this.normalise();
  }

  /**
   * The ground from real elevation data (see terrain.js): `T.metres` is n x n heights in metres, 16 bits each, top row north. They are rescaled
   * to run from 0 to `relief`, so a unit of height is (highest - lowest) / relief metres. Heights and across-the-cell distances then share a unit, which
   * sets how steep the slopes are, and the air cools 6.5 degrees for every kilometre of height. Only the pits too shallow to be real are filled.
   */
  loadTerrain(T, opts) {
    const n = this.n, size = n * n;
    if (T.n !== n) throw new Error(`the terrain is ${T.n} cells across, the map ${n}`);
    const bin = atob(T.metres);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < size; i++) { const m = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); this.elev[i] = m; if (m < lo) lo = m; if (m > hi) hi = m; }
    const metresPerUnit = (hi - lo) / this.relief;
    this.metresPerUnit = metresPerUnit;
    this.cellRun = ((T.sideKm * 1000) / n) / metresPerUnit;
    this.west = T.west; this.east = T.east;   // the longitudes of the map's edges
    if (opts.lapse === undefined) this.lapse = (6.5 * metresPerUnit) / 1000;
    this.pitDepth = opts.pitDepth ?? 0.04;
    this.normalise();
    const { F } = this.drainage(this.lowest());
    for (let i = 0; i < size; i++) if (F[i] - this.elev[i] < this.pitDepth) this.elev[i] = F[i];
  }

  /** Rescale the ground to run from 0 to `relief`. */
  normalise() {
    const E = this.elev;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < E.length; i++) { if (E[i] < lo) lo = E[i]; if (E[i] > hi) hi = E[i]; }
    for (let i = 0; i < E.length; i++) E[i] = ((E[i] - lo) / (hi - lo)) * this.relief;
  }

  lowest() {
    let best = 0;
    for (let i = 1; i < this.elev.length; i++) if (this.elev[i] < this.elev[best]) best = i;
    return best;
  }

  dist(i, j) {
    const n = this.n, di = Math.abs(((i / n) | 0) - ((j / n) | 0)), dj = Math.abs((i % n) - (j % n));
    return di === 1 && dj === 1 ? Math.SQRT2 : 1;
  }

  /**
   * Which way water runs on the ground as it is. Pits are filled (priority flood from the lowest cell, which on a map with
   * no edge is where everything ends up) so every cell has a way down; F is the filled surface, `down[i]` the cell water
   * leaves i for (-1 for the lowest), and `order` the cells from lowest to highest.
   */
  drainage(root) {
    const n = this.n, size = n * n, E = this.elev, F = new Float64Array(size).fill(Infinity);
    const done = new Uint8Array(size), order = new Int32Array(size), down = new Int32Array(size).fill(-1);
    const heap = [];   // [value, cell] pairs as a binary min-heap
    const push = (v, i) => { heap.push([v, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { let l = 2 * k + 1, r = l + 1, m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    F[root] = E[root]; push(F[root], root);
    let count = 0;
    while (heap.length) {
      const [, i] = pop();
      if (done[i]) continue;
      done[i] = 1; order[count++] = i;
      const r = (i / n) | 0, c = i - r * n;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        if (r + dr < 0 || r + dr >= n || c + dc < 0 || c + dc >= n) continue;   // the edges of the map are walls
        const j = (r + dr) * n + c + dc;
        if (done[j]) continue;
        const v = Math.max(E[j], F[i] + 1e-5);
        if (v < F[j]) { F[j] = v; down[j] = i; push(v, j); }
      }
    }
    return { F, down, order };
  }

  /** The cell `d` steps away (0 up, 1 right, 2 down, 3 left) from cell i. The edges of the map are walls, and a step into one stays put. */
  nb(i, d) {
    const n = this.n, r = (i / n) | 0, c = i - r * n;
    return d === 0 ? (r > 0 ? i - n : i) : d === 2 ? (r < n - 1 ? i + n : i) : d === 1 ? (c < n - 1 ? i + 1 : i) : (c > 0 ? i - 1 : i);
  }

  /** When the ground runs on the GPU, what the animals do to it (grass eaten, nitrogen dropped, heat given off) is collected here, per cell, and sent up with the next step. */
  delta(i, k, v) {
    const D = this.dev;
    if (!D.seen[i]) { D.seen[i] = 1; D.touched.push(i); }
    D.dl[4 * i + k] += v;
  }

  /** Set how much colder than the average height every cell's air is, from the lapse rate (degrees a km) of the season. */
  updateChill(lapse) {
    const C = this.chill, H = this.hKm;
    for (let i = 0; i < C.length; i++) C[i] = lapse * H[i];
  }

  /** Dig the lakes: `L.cells` is [cell, mean depth in metres] for each lake cell. The bed is dug below the surface the elevation data shows, and the lake starts full. */
  carveLakes(L) {
    if (L.n !== this.n) throw new Error(`the lakes are for a map ${L.n} cells across, this one is ${this.n}`);
    for (const [i, d] of L.cells) { this.elev[i] -= d / this.metresPerUnit; this.water[i] = (d * 1000) / this.waterMm; this.grass[i] = 0; this.lake[i] = 1; }
  }

  /** An animal burned `energy` at cell i: it is given off as heat into the ground there. */
  heat(i, energy) {
    this.soil[i] += (this.heatGain * energy) / this.capacity(i);
    if (this.dev) this.delta(i, 2, energy);
  }

  /** How much heat it takes to warm cell i by a degree: wet ground and ponds change temperature slowly, because water has a high specific heat. */
  capacity(i) { return 1 + this.waterHeat * Math.min(this.waterHeatMax, this.water[i]); }

  /** The air temperature at cell i: colder up the hill. */
  airAt(i) { return this.rowTemp[this.row[i]] - this.chill[i]; }

  /** The sun's place along each column of the map (see climateRows): colA = cos of the declination x cos of the hour angle there, colB = east component of the sun. */
  sunColumns(clim) {
    const n = this.n, { cd, ch, sh } = clim, cC = this.colCos, sC = this.colSin, A = this.colA, B = this.colB;
    this.flat = clim.sun;
    for (let c = 0; c < n; c++) { const cosH = ch * cC[c] - sh * sC[c], sinH = sh * cC[c] + ch * sC[c]; A[c] = cd * cosH; B[c] = -cd * sinH; }
  }

  /** The share of the beam that reaches cell i (row r, column c) when the sun is at (east e, north no, up u): 1 in the open, 0 behind a hill, in between at the soft edge. */
  sunSees(i, r, c, e, no, u) {
    const n = this.n, sky = this.skyH, run = this.run;
    const h = Math.hypot(e, no), dx = e / h, dy = -no / h, h0 = sky[i], rise = (this.skyMax - h0) / run;   // (rows run south, so north is up the page)
    const lo = u - SHADOW_SOFT / 2, need = lo > 0 ? lo / Math.sqrt(1 - lo * lo) : 0;   // ground lower than this angle cannot hide any of the sun
    let best = need;   // the tangent of the skyline's height
    let seen = 0;
    for (let s = 1; s <= SHADOW_REACH && rise > best * s; s++) {   // (the highest ground there is, at this distance, could not rise above `best` any more)
      const rr = Math.floor(r + dy * s + 0.5), cc = Math.floor(c + dx * s + 0.5);
      if (rr < 0 || rr >= n || cc < 0 || cc >= n) break;
      const t = (sky[rr * n + cc] - h0) / (s * run);
      if (t > best) { best = t; seen = 1; }
    }
    if (!seen) return 1;
    const x = Math.min(1, Math.max(0, (u - best / Math.sqrt(1 + best * best)) / SHADOW_SOFT + 0.5));
    return x * x * (3 - 2 * x);
  }

  /** How much sun each cell gets: the direct beam in proportion to how squarely the slope faces it, plus a little skylight. Nothing at night.
   *  The sun's place is worked out for each cell's own longitude. A hill between the cell and the sun hides the beam: a ray is followed from the cell toward the sun,
   *  and the highest ground it passes (as an angle above the cell's own level) is the skyline; the beam is hidden when the sun is below it, with a soft edge. */
  sunlight(clim) {
    const n = this.n, L = this.light, S = this.slope, nE = this.nE, nN = this.nN, nU = this.nU, sky = this.skyH, A = this.colA, B = this.colB;
    const { sd, sinLat, cosLat } = clim;
    this.sunColumns(clim);
    for (let r = 0; r < n; r++) {
      const sp = sinLat[r], cp = cosLat[r], base = r * n;
      for (let c = 0; c < n; c++) {
        const i = base + c, a = A[c], u = sp * sd + cp * a;
        if (u <= 0) { L[i] = 0; S[i] = 0; continue; }
        const e = B[c], no = sd * cp - sp * a;
        let beam = nE[i] * e + nN[i] * no + nU[i] * u;
        if (beam > 0) {
          if (sky) beam *= this.sunSees(i, r, c, e, no, u);
        } else beam = 0;
        L[i] = 0.9 * beam + 0.1 * u;
        S[i] = L[i] - u;
      }
    }
    this.lightClim = clim;
  }

  /** Make sure `light` is for the sun described by `clim` (on the card the ground's own light is worked out there, so this is only done when something here wants to look at it). */
  ensureLight(clim) { if (this.lightClim !== clim) this.sunlight(clim); }

  /** Ground temperature: closes in on the air above it, and on what its neighbours are. Heat only moves around, so a neighbour's gain is
   * this cell's loss; what a degree of it is worth depends on the cell's heat capacity, so wet cells swing slowly. */
  warmGround() {
    const n = this.n, size = n * n, S = this.soil, T = this._s, chill = this.chill, lag = this.soilLag, k = this.soilConduct / 8;
    if (this.soilFresh) { for (let i = 0; i < size; i++) S[i] = this.rowTemp[this.row[i]] - chill[i]; this.soilFresh = false; }
    for (let r = 0; r < n; r++) {
      const mid = r * n, up = r > 0 ? mid - n : mid, dn = r < n - 1 ? mid + n : mid;   // (a wall counts as the cell itself)
      const air = this.rowTemp[r];
      for (let c = 0; c < n; c++) {
        const l = c > 0 ? c - 1 : c, rt = c < n - 1 ? c + 1 : c, i = mid + c;
        const around = S[up + l] + S[up + c] + S[up + rt] + S[mid + l] + S[mid + rt] + S[dn + l] + S[dn + c] + S[dn + rt];
        const alb = this.albedo + (this.snowAlbedo - this.albedo) * Math.min(1, this.snow[i] / this.snowAlbedoDepth);
        T[i] = S[i] + (lag * (air - chill[i] + this.sunHeat * (1 - alb) * this.light[i] - this.radCool - S[i]) + k * around - this.soilConduct * S[i]) / this.capacity(i);
      }
    }
    this.soil = T; this._s = S;
  }

  /**
   * The part of a step that stays on the CPU when the ground runs on the GPU: the sun (the picture needs it), whether it rains (the random numbers
   * stay in one place), and the totals that are known without looking at the cells. Returns what the GPU needs: the first step also needs the ground temperature set.
   */
  gpuPrep(clim) {
    this.sunColumns(clim);   // (the cells' light is worked out on the card; `sunlight` fills `light` here only when the picture wants it)
    this.updateChill(clim.lapse); this.kOro = clim.kOro;
    this.rowTemp = clim.temp;
    this.temp = clim.temp[(this.n - 1) >> 1];
    const n = this.n, size = n * n;
    let fresh = false;
    if (this.soilFresh) { for (let i = 0; i < size; i++) this.soil[i] = this.rowTemp[this.row[i]] - this.chill[i]; this.soilFresh = false; fresh = true; }
    this.raining = this.rng.next() < this.rainChance * clim.wet;
    if (this.raining) {
      let fell = 0;
      for (let i = 0; i < size; i++) fell += this.rainDepth * clim.wet * clim.rain[this.row[i]] * Math.max(0.1, 1 + this.kOro * this.hKm[i]);
      this.ledger.rain += fell;
    }
    this.ledger.nIn += this.deposit * size;
    return fresh;
  }

  /** One step of weather and water. `clim` comes from climateRows. */
  step(clim, occupied = null) {
    this.sunlight(clim);
    this.updateChill(clim.lapse); this.kOro = clim.kOro;
    this.rowTemp = clim.temp;   // row by row, at middle height; every cell is colder or warmer than this by its height (see airAt)
    this.temp = clim.temp[(this.n - 1) >> 1];
    this.warmGround();
    const n = this.n, size = n * n, W = this.water, N = this.nitrogen, E = this.elev, rng = this.rng;

    // --- rain: evenly over the whole grid, more often and heavier in the wet season
    this.raining = rng.next() < this.rainChance * clim.wet;
    const S = this.snow, chill = this.chill;
    if (this.raining) {
      let fell = 0;
      for (let i = 0; i < size; i++) {
        const r = this.row[i], d = this.rainDepth * clim.wet * clim.rain[r] * Math.max(0.1, 1 + this.kOro * this.hKm[i]);   // more falls in the north, and more the higher the ground
        if (clim.temp[r] - chill[i] < 1) S[i] += d; else W[i] += d;           // snow where the air is near freezing
        fell += d;
      }
      this.ledger.rain += fell;
    }
    // snowmelt: faster the warmer it is; the water soaks into the ground it lies on
    for (let i = 0; i < size; i++) {
      if (S[i] <= 0) continue;
      const above = this.soil[i];   // melts by how warm the ground under it is
      if (above <= 0) continue;
      const m = Math.min(S[i], this.meltRate * above);
      S[i] -= m; W[i] += m;
    }
    for (let i = 0; i < size; i++) N[i] += this.deposit;
    this.ledger.nIn += this.deposit * size;

    // --- evaporation: most at noon in summer, from the surface of bare ground and open water alike
    let gone = 0;
    for (let i = 0; i < size; i++) {
      const r = this.row[i], e = this.evap * (0.25 + 0.75 * this.light[i]);
      const warm = 0.6 + 0.4 * Math.min(1.5, Math.max(0, (clim.temp[r] - chill[i]) / 15));   // less evaporates where it is colder
      const x = Math.min(W[i], e * warm); W[i] -= x; gone += x;
    }
    this.ledger.evap += gone;
    let soaked = 0;
    for (let i = 0; i < size; i++) { const x = Math.min(Math.min(W[i], this.soakMax) * this.seep + this.floodSeep * Math.max(0, W[i] - 1.5), this.seepMax); W[i] -= x; soaked += x; }
    this.ledger.seep += soaked;

    // --- flow: water runs to lower neighbours in proportion to the drop in water surface, taking its nitrogen with it
    const nw = this._w, nn = this._n, K = this.flow, nbr = this.nbr, nbr8 = this.nbr8, fl = this._f8, iw = this.invWs, fmin = this.flowMin, nm = this.nMobile;
    for (let sub = 0; sub < this.flowSteps; sub++) {
      nw.set(W); nn.set(N);
      for (let i = 0; i < size; i++) {
        const w = W[i];
        if (w <= fmin) continue;   // (thin water stays put)
        const e = E[i];
        let total = 0;
        for (let k = 0; k < 8; k++) {
          const j = nbr8[8 * i + k], d = (e - E[j]) * iw + (w - W[j]);   // (the drop in water surface, in units of water)
          const f = d > 0 ? K * d * DW8[k] : 0; fl[k] = f; total += f;
        }
        if (total <= 0) continue;
        const free = w - fmin, scale = total > free ? free / total : 1;   // (never more than the cell has above the water it holds)
        const moved = total * scale;
        if (!(moved > 0)) continue;   // (so thin that nothing moves)
        const out = N[i] * nm * (moved / w);   // the share of this cell's water that leaves carries the same share of its dissolved nitrogen
        nw[i] -= moved; nn[i] -= out;
        const kn = out / moved;           // nitrogen per unit of water that leaves
        for (let k = 0; k < 8; k++) { if (fl[k] > 0) { const j = nbr8[8 * i + k], q = fl[k] * scale; nw[j] += q; nn[j] += q * kn; } }
      }
      W.set(nw); N.set(nn);
    }

    // --- the river: whatever has run down to the lowest ground leaves the map
    let river = 0, nRiver = 0;
    for (let i = 0; i < size; i++) {
      if (!this.outlet[i]) continue;
      const w = W[i] * this.outletRate, nit = N[i] * this.outletRate;
      W[i] -= w; N[i] -= nit; river += w; nRiver += nit;
    }
    this.ledger.river += river; this.ledger.nLeach += nRiver;

    // --- nitrogen also creeps to the neighbours on its own, and a little is washed out of the system
    const D = this.creep, lost = this.leach;
    let leached = 0;
    nn.set(N);
    N.fill(0);
    for (let i = 0; i < size; i++) {
      const v = nn[i], l = v * lost, m = v * D * 0.25;
      leached += l;
      N[i] += v - l - 4 * m;
      N[nbr[4 * i]] += m; N[nbr[4 * i + 1]] += m; N[nbr[4 * i + 2]] += m; N[nbr[4 * i + 3]] += m;
    }
    this.ledger.nLeach += leached;

    this.grow(clim, occupied);
  }

  /** How well a cell's water suits grass: none when dried out or flooded, full in between. */
  moisture(w) {
    if (w <= 0.05) return 0;
    if (w < 0.3) return (w - 0.05) / 0.25;
    if (w <= this.floodStart) return 1;
    if (w < this.floodEnd) return (this.floodEnd - w) / (this.floodEnd - this.floodStart);
    return 0;
  }

  /** Grass: growth (drinking and taking nitrogen), dying back (giving nitrogen back as litter), and seeds spreading in. */
  grow(clim, occupied) {
    const n = this.n, size = n * n, G = this.grass, G0 = this._g, W = this.water, N = this.nitrogen;
    const chill = this.chill, nbr = this.nbr;
    G0.set(G);
    let drunk = 0;
    for (let i = 0; i < size; i++) {
      const g = G0[i], w = W[i], m = this.moisture(w);
      // dying back: a little all the time, more in the cold, and fast when the ground is flooded or dried out
      const tl = this.soil[i];   // the ground temperature here: colder up the hill, and warmer where animals have been
      const lose = g * (0.0005 * (1 + 0.05 * Math.max(0, 12 - tl)) + 0.004 * (1 - m));
      if (lose > 0) { G[i] -= lose; N[i] += lose * this.nPer; }
      if (occupied && occupied[i]) continue;   // an animal standing here blocks the light
      if (this.snow[i] > 0.02) continue;       // and so does snow
      const nb = (G0[nbr[4 * i]] + G0[nbr[4 * i + 1]] + G0[nbr[4 * i + 2]] + G0[nbr[4 * i + 3]]) / 4;
      const base = g + 0.5 * nb + 0.002;     // the plant itself, seed blowing in from the neighbours, and a trace of seed in the soil
      const light = this.light[i] * Math.min(1, Math.max(0, tl / 12));   // no growth in the dark or below freezing
      let grow = this.regrow * light * m * (N[i] / (N[i] + 0.03)) * base * (1 - g / this.gMax);
      grow = Math.min(grow, w / this.waterPer, N[i] / this.nPer);
      if (grow <= 0) continue;
      G[i] += grow;
      W[i] -= grow * this.waterPer; drunk += grow * this.waterPer;
      N[i] -= grow * this.nPer;
    }
    this.ledger.uptake += drunk;
  }

  /** How much of the grass on cell i an animal can get at: all of it on bare ground, none when buried under snow `bury` deep. */
  open(i) { return Math.max(0, 1 - this.snow[i] / this.bury); }

  /** An animal eats up to `amount` of the grass on cell i. Returns { grass, nitrogen }: what was eaten and the nitrogen that went with it. */
  graze(i, amount) {
    const x = Math.min(amount, this.grass[i]);
    this.grass[i] -= x;
    if (this.dev && x > 0) this.delta(i, 0, x);
    return { grass: x, nitrogen: x * this.nPer };
  }

  /** The air temperature at cell i right now: colder the higher it is. */
  tempAt(i) { return this.soilFresh ? this.airAt(i) : this.soil[i]; }   // the ground temperature at cell i

  /** How much more energy an animal burns in the cold at cell i (1 when it is mild), and more again when standing in water. */
  coldAt(i) {
    const chill = 0.05 * Math.max(0, 12 - this.tempAt(i));
    // water carries heat off a body far faster than air does, so wading in cold water is much worse than standing in the same cold on dry ground
    return 1 + chill * (1 + this.immerse * Math.min(1, this.water[i] / this.immerseDepth));
  }

  /** Droppings and carcasses put nitrogen back in the soil of cell i. (It was counted when it left the soil, so this is not new nitrogen.) */
  fertilise(i, amount) {
    if (this.dev) this.delta(i, 1, amount); else this.nitrogen[i] += amount;
  }

  /** Check the books. `animalNitrogen` is the nitrogen the animals are carrying (eaten and not yet returned). Errors should be ~0. */
  audit(animalNitrogen = 0) {
    const L = this.ledger;
    const w = this.sum(this.water) + this.sum(this.snow), soil = this.sum(this.nitrogen), plants = this.nPer * this.sum(this.grass);
    return {
      water: w, nitrogen: soil + plants + animalNitrogen, soil, plants,
      grassTotal: this.sum(this.grass),
      waterError: w - (this.start.water + L.rain - L.evap - L.seep - L.river - L.uptake),
      nitrogenError: soil + plants + animalNitrogen - (this.start.nitrogen + L.nIn - L.nLeach),
    };
  }
}
