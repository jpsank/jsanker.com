// Yellowstone: a rebuild of evo/ from github.com/jpsank/thesis in plain JavaScript, with terrain, water, wolves, days and seasons added.
//
// Animals live on a 400x400 map of land, with walls all round (land.js: elevation, water, nitrogen and grass on every cell). Each animal carries a
// genome: a small network (a CPPN) that is never run on the world directly. Instead it is queried once per pair of
// neurons of a fixed "substrate" to paint the weights of the network that does the sensing and acting (HyperNEAT-style).
// An animal sees a 9x9 patch of colours and answers with how much it wants to step to each of the nine cells around it (weighed
// against what the step costs, so climbing is dear) and where to breed. Every animal decides from the same snapshot of the world at the start of the step (decide), then they act one at a time in a random order (act).
// With WebGPU the ground and the decisions are worked out on the graphics card (gpu.js); everything else, including acting, is here either way. A diet gene, from 0 (digests grass) to 1 (digests meat),
// decides what it can live on; hunters are the ones whose diet has moved toward meat.
//
// This file has no DOM in it. app.js draws it.
import { Land, climateRows, dayOfYear, landRgb } from './land.js';
import { TERRAIN } from './terrain.js';
import { LAKES } from './lakes.js';

/* ------------------------------------------------------------------ random numbers */

export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    int: (n) => Math.floor(next() * n),
    normal: (sd) => {
      let u = 0;
      while (u === 0) u = next();
      return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
  };
}

/* ------------------------------------------------------------------ genomes (config.py, genome.py) */

const ACTS = ['sigmoid', 'relu', 'tanh', 'sine', 'cosine'];
const TANH = 2;

const P = {
  addNode: 0.1, addEdge: 0.2, removeNode: 0.02, removeEdge: 0.05,
  actFunc: 0.1, bias: 0.5, biasScale: 0.1, weight: 0.5, weightScale: 0.1,
};

const N_IN = 8;  // input ids are -8 .. -1; only the first six are ever fed (see phenotype())
const N_OUT = 2; // output ids are 0 and 1; only output 0 is ever read, as in the original

const edgeKey = (s, t) => s + ',' + t;

function randomGenome(rng) {
  const nodes = new Map();
  const edges = new Map();
  for (let o = 0; o < N_OUT; o++) nodes.set(o, { act: TANH, bias: rng.uniform(-1, 1) });
  for (let i = -N_IN; i < 0; i++) {
    for (let o = 0; o < N_OUT; o++) edges.set(edgeKey(i, o), { s: i, t: o, w: rng.uniform(-1, 1) });
  }
  return { nodes, edges };
}

function copyGenome(g) {
  const nodes = new Map();
  for (const [k, n] of g.nodes) nodes.set(k, { act: n.act, bias: n.bias });
  const edges = new Map();
  for (const [k, e] of g.edges) edges.set(k, { s: e.s, t: e.t, w: e.w });
  return { nodes, edges };
}

export const genomeSize = (g) => g.nodes.size + g.edges.size;

function crossover(g1, g2, rng) {
  const nodes = new Map();
  for (const [k, n1] of g1.nodes) {
    const n2 = g2.nodes.get(k);
    if (n2) nodes.set(k, { act: rng.next() < 0.5 ? n1.act : n2.act, bias: rng.next() < 0.5 ? n1.bias : n2.bias });
    else nodes.set(k, { act: n1.act, bias: n1.bias });
  }
  for (const [k, n2] of g2.nodes) if (!g1.nodes.has(k)) nodes.set(k, { act: n2.act, bias: n2.bias });
  const edges = new Map();
  for (const [k, e1] of g1.edges) {
    const e2 = g2.edges.get(k);
    edges.set(k, { s: e1.s, t: e1.t, w: e2 && rng.next() >= 0.5 ? e2.w : e1.w });
  }
  for (const [k, e2] of g2.edges) if (!g1.edges.has(k)) edges.set(k, { s: e2.s, t: e2.t, w: e2.w });
  return { nodes, edges };
}

/** `ids` is the species' counter for new hidden nodes: { next } (the original forgot to advance it). */
function mutate(g, rng, ids) {
  for (const n of g.nodes.values()) {
    if (rng.next() < P.actFunc) n.act = rng.int(ACTS.length);
    if (rng.next() < P.bias) n.bias += rng.normal(P.biasScale);
  }
  for (const e of g.edges.values()) if (rng.next() < P.weight) e.w += rng.normal(P.weightScale);

  if (rng.next() < P.addNode && g.edges.size > 0) {
    const keys = [...g.edges.keys()];
    const key = rng.pick(keys);
    const old = g.edges.get(key);
    const id = ids.next++;
    g.nodes.set(id, { act: TANH, bias: rng.uniform(-1, 1) });
    g.edges.set(edgeKey(old.s, id), { s: old.s, t: id, w: 1 });
    g.edges.set(edgeKey(id, old.t), { s: id, t: old.t, w: old.w });
    g.edges.delete(key);
  }
  if (rng.next() < P.addEdge) {
    // As in the original: the source is a hidden node, the target any non-input node.
    const hidden = [...g.nodes.keys()].filter((k) => k >= N_OUT);
    const all = [...g.nodes.keys()];
    if (hidden.length && all.length) {
      const s = rng.pick(hidden), t = rng.pick(all);
      g.edges.set(edgeKey(s, t), { s, t, w: rng.uniform(-1, 1) });
    }
  }
  if (rng.next() < P.removeNode) {
    const hidden = [...g.nodes.keys()].filter((k) => k >= N_OUT);
    if (hidden.length) {
      const id = rng.pick(hidden);
      for (const [k, e] of [...g.edges]) if (e.s === id || e.t === id) g.edges.delete(k);
      g.nodes.delete(id);
    }
  }
  if (rng.next() < P.removeEdge && g.edges.size > 0) g.edges.delete(rng.pick([...g.edges.keys()]));
}

/* ------------------------------------------------------------------ the CPPN (ffnn.py, graphs.py) */

const ACT_FN = [
  (x) => 1 / (1 + Math.exp(-x)),
  (x) => (x > 0 ? x : 0),
  Math.tanh,
  Math.sin,
  Math.cos,
];

/**
 * The tables a genome compiles to: nodes in the order they fire, and for each its activation, bias and incoming connections.
 * Same rules as the original: only nodes on a path to an output are kept, and a node is computed once all
 * of its sources have been, so nodes caught in a cycle never fire and read as 0.
 */
function cppnTables(g) {
  const incoming = new Map();
  for (const e of g.edges.values()) {
    if (!incoming.has(e.t)) incoming.set(e.t, []);
    incoming.get(e.t).push(e);
  }
  const required = new Set();
  const stack = [0];
  while (stack.length) {
    const n = stack.pop();
    if (n < 0 || required.has(n) || !g.nodes.has(n)) continue;
    required.add(n);
    for (const e of incoming.get(n) || []) stack.push(e.s);
  }

  // Kahn's algorithm over the required nodes
  const pending = new Map();   // node -> number of distinct unfinished sources
  const outgoing = new Map();  // source -> targets
  for (const n of required) {
    let c = 0;
    for (const e of incoming.get(n) || []) {
      if (e.s < 0 || required.has(e.s)) {
        c += e.s < 0 ? 0 : 1;
        if (e.s >= 0) {
          if (!outgoing.has(e.s)) outgoing.set(e.s, []);
          outgoing.get(e.s).push(n);
        }
      }
    }
    pending.set(n, c);
  }
  const order = [];
  const ready = [];
  for (const [n, c] of pending) if (c === 0 && hasInputSource(incoming.get(n))) ready.push(n);
  while (ready.length) {
    const n = ready.pop();
    order.push(n);
    for (const t of outgoing.get(n) || []) {
      const left = pending.get(t) - 1;
      pending.set(t, left);
      if (left === 0) ready.push(t);
    }
  }

  const slot = new Map();
  for (let i = 0; i < N_IN; i++) slot.set(i - N_IN, i);
  order.forEach((n, k) => slot.set(n, N_IN + k));
  const zero = N_IN + order.length;

  const act = new Uint8Array(order.length);
  const bias = new Float64Array(order.length);
  const start = new Int32Array(order.length + 1);
  const srcs = [], ws = [];
  order.forEach((n, k) => {
    act[k] = g.nodes.get(n).act;
    bias[k] = g.nodes.get(n).bias;
    for (const e of incoming.get(n) || []) {
      if (e.s < 0 || required.has(e.s)) { srcs.push(slot.has(e.s) ? slot.get(e.s) : zero); ws.push(e.w); }
    }
    start[k + 1] = srcs.length;
  });
  return { act, bias, start, src: Int32Array.from(srcs), w: Float64Array.from(ws), out: slot.has(0) ? slot.get(0) : zero, zero, count: order.length };
}

/** Compile a genome into a function of six numbers that returns output 0. */
function compileCppn(g) {
  const { act, bias, start, src, w, out, zero } = cppnTables(g);
  const vals = new Float64Array(zero + 1);
  return function cppn(a, b, c, d, e, f) {
    vals[0] = a; vals[1] = b; vals[2] = c; vals[3] = d; vals[4] = e; vals[5] = f;
    for (let k = 0; k < act.length; k++) {
      let sum = bias[k];
      for (let j = start[k]; j < start[k + 1]; j++) sum += w[j] * vals[src[j]];
      vals[N_IN + k] = ACT_FN[act[k]](sum);
    }
    return vals[out];
  };
}

export const ACT_NAMES = ['sigmoid', 'relu', 'tanh', 'sin', 'cos'];

/**
 * The part of a genome that does anything, for drawing: nodes on a path to output 0, the connections between them
 * (only the first six inputs are ever fed), and each node's depth. `unused` counts the genes that have no effect.
 */
export function genomeGraph(g) {
  const incoming = new Map();
  for (const e of g.edges.values()) {
    if (!incoming.has(e.t)) incoming.set(e.t, []);
    incoming.get(e.t).push(e);
  }
  const required = new Set();
  const stack = [0];
  while (stack.length) {
    const n = stack.pop();
    if (n < 0 || required.has(n) || !g.nodes.has(n)) continue;
    required.add(n);
    for (const e of incoming.get(n) || []) stack.push(e.s);
  }
  const edges = [];
  for (const e of g.edges.values()) {
    if (!required.has(e.t)) continue;
    if (e.s < 0 ? e.s + N_IN < 6 : required.has(e.s)) edges.push({ s: e.s, t: e.t, w: e.w });
  }
  const depth = new Map(), busy = new Set();
  const dep = (n) => {
    if (n < 0) return 0;
    if (depth.has(n)) return depth.get(n);
    if (busy.has(n)) return 0;   // a cycle: these never fire
    busy.add(n);
    let d = 1;
    for (const e of edges) if (e.t === n) d = Math.max(d, dep(e.s) + 1);
    busy.delete(n);
    depth.set(n, d);
    return d;
  };
  const nodes = [...required].map((id) => ({ id, act: g.nodes.get(id).act, bias: g.nodes.get(id).bias, depth: dep(id) }));
  const inputs = [...new Set(edges.filter((e) => e.s < 0).map((e) => e.s))].sort((a, b) => a - b);
  return { nodes, edges, inputs, unused: g.nodes.size + g.edges.size - nodes.length - edges.length };
}

function hasInputSource(list) {
  return !!list && list.some((e) => e.s < 0);
}

/* ------------------------------------------------------------------ the phenotype (phenotype_nn.py) */

/** Coordinates of every neuron of one substrate layer, each axis normalised to [-1, 1], C order. */
function layerCoords(dims) {
  const n = dims[0] * dims[1] * dims[2];
  const out = new Float64Array(n * 3);
  let k = 0;
  for (let a = 0; a < dims[0]; a++) {
    for (let b = 0; b < dims[1]; b++) {
      for (let c = 0; c < dims[2]; c++) {
        out[k++] = dims[0] === 1 ? 0 : (a / (dims[0] - 1)) * 2 - 1;
        out[k++] = dims[1] === 1 ? 0 : (b / (dims[1] - 1)) * 2 - 1;
        out[k++] = dims[2] === 1 ? 0 : (c / (dims[2] - 1)) * 2 - 1;
      }
    }
  }
  return out;
}

// The last layer is a 3 x 3 grid of cells, one per place the animal could act on (itself in the middle). It has two such grids:
// how much it wants to step to each cell (weighed against what the step costs), and where to breed.
const ANIMAL_NET = [[9, 9, 3], [3, 3, 3], [3, 3, 2]];
const COORDS = new Map();
function coordsFor(dims) {
  const key = dims.join('x');
  if (!COORDS.has(key)) COORDS.set(key, layerCoords(dims));
  return COORDS.get(key);
}

/** The 3 x 3 action cells, `ch` channels each. The eight steps sit on a circle around the middle cell (stay) instead of on a
 *  square grid: on a square the corners are far from the middle, and a smooth function of position, which is what a CPPN
 *  is, has its largest value at a corner far more often than anywhere else. */
function actionCoords(ch) {
  const out = new Float64Array(9 * ch * 3);
  let k = 0;
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      const m = Math.hypot(a, b) || 1;
      for (let c = 0; c < ch; c++) {
        out[k++] = a / m; out[k++] = b / m; out[k++] = ch === 1 ? 0 : c * 2 - 1;
      }
    }
  }
  return out;
}

function buildNet(g, substrate) {
  const cppn = compileCppn(g);
  const layers = [];
  for (let l = 1; l < substrate.length; l++) {
    const last = l === substrate.length - 1;
    const cj = last ? actionCoords(substrate[l][2]) : coordsFor(substrate[l]), ci = coordsFor(substrate[l - 1]);
    const nj = cj.length / 3, ni = ci.length / 3;
    const W = new Float32Array(nj * ni), B = new Float32Array(nj);
    for (let j = 0; j < nj; j++) {
      const j0 = cj[j * 3], j1 = cj[j * 3 + 1], j2 = cj[j * 3 + 2];
      for (let i = 0; i < ni; i++) W[j * ni + i] = cppn(j0, j1, j2, ci[i * 3], ci[i * 3 + 1], ci[i * 3 + 2]);
      B[j] = cppn(j0, j1, j2, -1, 0, 0);
    }
    layers.push({ W, B, nj, ni });
  }
  const bufs = layers.map((L) => new Float32Array(L.nj));
  return {
    layers, bufs,
    forward(input) {
      let cur = input;
      for (let l = 0; l < layers.length; l++) {
        const { W, B, nj, ni } = layers[l], out = bufs[l];
        for (let j = 0; j < nj; j++) {
          let s = B[j];
          const row = j * ni;
          for (let i = 0; i < ni; i++) s += W[row + i] * cur[i];
          out[j] = l === layers.length - 1 ? s : Math.tanh(s);   // the last layer stays linear so its cells can be compared
        }
        cur = out;
      }
      return cur;
    },
  };
}

/* ------------------------------------------------------------------ what the GPU needs to build and run the brains */

// A brain is stored as 16-bit numbers, layer by layer: for each layer the weights ordered input-major (so neighbouring GPU threads read
// neighbouring numbers), then the biases. A genome is sent to the GPU as a small program (see encodeProgram) and the GPU paints the weights.
const layerSizes = ANIMAL_NET.slice(1).map((d, l) => ({ ni: ANIMAL_NET[l].reduce((a, b) => a * b, 1), nj: l === ANIMAL_NET.length - 2 ? 9 * d[2] : d.reduce((a, b) => a * b, 1) }));
export const BRAIN = { layers: layerSizes, halves: layerSizes.reduce((a, L) => a + L.ni * L.nj + L.nj, 0) };
BRAIN.words = BRAIN.halves / 2;
export const PROGRAM = { maxNodes: 48, maxEdges: 320 };
PROGRAM.words = 3 + 4 * PROGRAM.maxNodes + 2 * PROGRAM.maxEdges;

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bitsOf = (x) => { f32[0] = x; return u32[0]; };
/** Round a number to the nearest 16-bit float, as its bits. */
function toHalf(x) {
  f32[0] = x;
  const b = u32[0], sign = (b >>> 16) & 0x8000, ex = (b >>> 23) & 0xff;
  let m = b & 0x7fffff, e = ex - 127 + 15;
  if (ex === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const sh = 14 - e, rem = m & ((1 << sh) - 1), half = 1 << (sh - 1);
    let h = m >>> sh;
    if (rem > half || (rem === half && (h & 1))) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (m >>> 13);
  const rem = m & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
  return h;
}

/** Write genome `g` as a program into dst[off ...]: [nodes, output slot, zero slot, then (activation, bias, first edge, last edge) per node, then (source slot, weight) per edge]. False if it is too big for the GPU's fixed-size registers. */
export function encodeProgram(g, dst, off) {
  const T = cppnTables(g);
  if (T.count > PROGRAM.maxNodes || T.w.length > PROGRAM.maxEdges) return false;
  dst.fill(0, off, off + PROGRAM.words);
  dst[off] = T.count; dst[off + 1] = T.out; dst[off + 2] = T.zero;
  for (let k = 0; k < T.count; k++) {
    const p = off + 3 + 4 * k;
    dst[p] = T.act[k]; dst[p + 1] = bitsOf(T.bias[k]); dst[p + 2] = T.start[k]; dst[p + 3] = T.start[k + 1];
  }
  const e0 = off + 3 + 4 * PROGRAM.maxNodes;
  for (let j = 0; j < T.w.length; j++) { dst[e0 + 2 * j] = T.src[j]; dst[e0 + 2 * j + 1] = bitsOf(T.w[j]); }
  return true;
}

/** A genome's whole brain as packed 16-bit weights, built on the CPU (for the rare genome too big for encodeProgram). */
export function packNet(g) {
  const net = buildNet(g, ANIMAL_NET), halves = new Uint16Array(BRAIN.halves);
  let o = 0;
  for (const L of net.layers) {
    for (let i = 0; i < L.ni; i++) for (let j = 0; j < L.nj; j++) halves[o++] = toHalf(L.W[j * L.ni + i]);
    for (let j = 0; j < L.nj; j++) halves[o++] = toHalf(L.B[j]);
  }
  return new Uint32Array(halves.buffer);
}

/** For every number in a brain, in storage order, the six inputs of the CPPN that paints it: where the receiving neuron is, and where the sending one is. */
export function connectionTable() {
  const out = new Float32Array(BRAIN.halves * 6);
  let o = 0;
  for (let l = 1; l < ANIMAL_NET.length; l++) {
    const last = l === ANIMAL_NET.length - 1;
    const cj = last ? actionCoords(ANIMAL_NET[l][2]) : coordsFor(ANIMAL_NET[l]), ci = coordsFor(ANIMAL_NET[l - 1]);
    const nj = cj.length / 3, ni = ci.length / 3;
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) { for (let q = 0; q < 3; q++) { out[o++] = cj[j * 3 + q]; } for (let q = 0; q < 3; q++) out[o++] = ci[i * 3 + q]; }
    for (let j = 0; j < nj; j++) { out[o++] = cj[j * 3]; out[o++] = cj[j * 3 + 1]; out[o++] = cj[j * 3 + 2]; out[o++] = -1; out[o++] = 0; out[o++] = 0; }
  }
  return out;
}

/* ------------------------------------------------------------------ the world */

// What the networks see: a cell's colour, normalised the way the original did ((rgb / 255) - 0.5).
const SEEN_GREY = 128 / 255 - 0.5;
/** How well an animal sees a cell by the sunlight on it: clarity = floor + (1 - floor) x (1 - exp(-light / half)). The light is what that cell's ground gets (full sun on flat ground is about 0.9, the sun
 *  10 degrees up about 0.17, a slope turned away from the sun, shade and the night 0 to 0.02), so a cell is clear when the sun shines squarely on it, dim in the half-light of dawn and dusk, of a hill's shadow or of
 *  a slope that faces away from the sun, and at night leaves only `floor`: starlight, for animals that see well in the dark. With a low clarity colours fade to grey. */
export const VISION = { floor: 0.2, half: 0.15 };
export const clarityOf = (light) => VISION.floor + (1 - VISION.floor) * (1 - Math.exp(-light / VISION.half));

const NEIGHBOURS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const WALL = 1e30;   // the cost of stepping off the edge of the map
const REST = 0.05;   // what it costs just to stay put (part of the basal drain, so only the extra of a move is charged)

/** Animals at 0.5 or more on the diet scale (0 = lives on grass, 1 = lives on meat) are called wolves; the rest, prey. */
export const isWolf = (a) => a.diet >= 0.5;
export const speciesName = (a) => (isWolf(a) ? 'wolf' : 'prey');

export class World {
  /**
   * opts: seed, size (100), prey (100: herbivores to start with), wolves (0; see releaseWolves),
   *       mating (true: pairs that point at each other breed), dayLength (60 steps), yearDays (30 days to a year),
   *       plantEnergy (5: energy in a unit of grass for an animal that digests it perfectly), meatShare (0.3: the share of a victim's energy
   *       that its killer gets as meat), climb (0.1: extra energy per unit of height gained in a step), land: options for Land
   */
  constructor(opts = {}) {
    this.rng = makeRng(opts.seed ?? 1);
    this.n = opts.size ?? TERRAIN.n;
    this.mating = opts.mating ?? true;
    this.dayLength = opts.dayLength ?? 60;
    this.yearDays = opts.yearDays ?? 30;
    this.plantEnergy = opts.plantEnergy ?? 5;
    this.meatShare = opts.meatShare ?? 0.3;
    this.climb = opts.climb ?? 0.1;
    const terrain = opts.terrain === false || this.n !== TERRAIN.n ? null : opts.terrain ?? TERRAIN;   // the real ground, unless asked for made-up ground
    this.latTop = opts.latTop ?? (terrain ? terrain.latTop : 65);       // the latitudes of the top and bottom rows of the map
    this.latBottom = opts.latBottom ?? (terrain ? terrain.latBottom : 25);
    this.snowCost = opts.snowCost ?? 0.04; // extra energy per unit of snow depth in the cell stepped into (a unit of snow is a few cm of water, so tens of cm of snow)...
    this.snowCap = opts.snowCap ?? 6;      // ...counted up to this depth
    this.swim = opts.swim ?? (terrain ? 0.5 : 0.15);          // extra energy for a step into water deep enough to swim: several times a step on dry land
    this.rainSwing = opts.rainSwing ?? 1;      // how much of the real seasonal pattern of rainfall to keep
    this.bite = opts.bite ?? 0.5;         // the most grass an animal takes in one step
    this.gutMax = opts.gutMax ?? 2;       // the most it can carry undigested
    this.digestRate = opts.digestRate ?? 0.25;
    this.bodyN = opts.bodyN ?? 0.5;       // nitrogen in a newly released animal's body
    this.excrete = opts.excrete ?? 0.01;  // share of its body nitrogen an animal passes on each step
    this.land = new Land({ seed: opts.seed ?? 1, size: this.n, terrain, lakes: terrain ? (opts.lakes === false ? null : opts.lakes ?? LAKES) : null, ...(opts.land || {}) });
    this.swimDepth = opts.swimDepth ?? (terrain ? 1000 / this.land.waterMm : 3);   // that deep (a metre on the real map): feet leave the bottom
    this.gpu = opts.gpu ? opts.gpu.attach(this) : null;   // the ground and the brains run on the graphics card when there is one (see gpu.js)
    this.moves = new Float64Array(9);     // how often animals chose each of the 9 steps (row-major, middle = stay)
    this.t = 0;
    this.climate();
    this.grid = new Array(this.n * this.n).fill(null);
    this.occ = new Uint8Array(this.n * this.n);   // which cells have an animal on them (they shade the grass)
    this.animals = new Map();
    this.hiddenIds = { next: N_OUT };
    this.history = { t: [], grass: [], prey: [], wolf: [] };
    this.eaten = 0;      // grass eaten
    this.hunted = 0;     // animals killed and eaten
    this.births = { count: 0, mated: 0 };
    this.in9 = new Float32Array(243);
    this.nPrey = 0; this.nWolf = 0;

    this.place = (org) => {
      for (;;) {
        const r = this.rng.int(this.n), c = this.rng.int(this.n);
        if (!this.grid[r * this.n + c]) { org.r = r; org.c = c; this.grid[r * this.n + c] = org; return org; }
      }
    };
    this.introduce(opts.prey ?? Math.round(100 * (this.n / 100) ** 2), 0.1);   // the same density as the 100 x 100 map had
    this.introduce(opts.wolves ?? 0, 0.9);
    this.record();
  }

  /** Put `count` new animals with random brains and the given diet on random empty cells. Their nitrogen comes in from outside, and is logged as such. */
  introduce(count, diet) {
    let k = 0;
    for (let i = 0; i < count && this.animals.size < this.n * this.n && (!this.gpu || this.gpu.hasRoom()); i++) {
      const o = this.spawn(randomGenome(this.rng), diet);
      o.bodyN = this.bodyN; this.land.ledger.nIn += this.bodyN;
      this.place(o);
      k++;
    }
    return k;
  }

  /** Drop `count` wolves (hunters: diet 0.9) with random brains. Returns how many fit. */
  releaseWolves(count) { return this.introduce(count, 0.9); }

  /** Day, season, sunlight and temperature from the step count. The world starts at noon in midsummer. */
  climate() {
    this.clim = climateRows(this.t, this.n, this.dayLength, this.yearDays, this.rainSwing, this.latTop, this.latBottom);   // row by row, north to south
    const mid = (this.n - 1) >> 1;   // the middle of the map is 45 degrees north, for the clock
    this.sun = this.clim.sun[mid]; this.temp = this.clim.temp[mid];
  }

  /** For display: { year, day (of the year), hour (0-24), season (by calendar month: spring is March to May) } */
  when() {
    const perYear = this.dayLength * this.yearDays, doy = dayOfYear(this.t, this.dayLength, this.yearDays);
    const m = (Math.floor(doy / 30.4167)) % 12;
    return {
      year: Math.floor(this.t / perYear) + 1,
      day: Math.floor((this.t % perYear) / this.dayLength) + 1,
      hour: (12 + (24 * this.t) / this.dayLength) % 24,
      season: m >= 2 && m <= 4 ? 'spring' : m >= 5 && m <= 7 ? 'summer' : m >= 8 && m <= 10 ? 'autumn' : 'winter',
    };
  }

  spawn(genome, diet) {
    const id = this.nextId = (this.nextId ?? -1) + 1;
    const org = {
      id, genome, diet, r: 0, c: 0, energy: 50,
      bodyN: 0, plant: 0, plantN: 0, meat: 0, meatN: 0,   // body nitrogen, and what is in the gut
      col: [0.5, diet - 0.5, -0.5],
      dec: 255,   // what it decided this step (see decide)
      slot: -1,   // where its brain lives on the GPU
      _net: null,
      get net() { return this._net ??= buildNet(this.genome, ANIMAL_NET); },   // (built when something needs to run or draw it on the CPU)
    };
    if (this.gpu) this.gpu.born(org);
    this.animals.set(id, org);
    return org;
  }

  /** The 3 x 3 steps, row-major: which one the brain's output and the costs agree on. Returns [di, dj, index, cost]. */
  choose(a, out) {
    const n = this.n, E = this.land.elev, W = this.land.water, S = this.land.snow, here = E[a.r * n + a.c];
    let best = 4, bv = -Infinity, bc = REST;
    for (let k = 0; k < 9; k++) {
      const di = ((k / 3) | 0) - 1, dj = (k % 3) - 1;
      const rr = a.r + di, cc = a.c + dj;
      const cost = rr < 0 || rr >= n || cc < 0 || cc >= n ? WALL : this.stepCost(di, dj, E[rr * n + cc] - here, W[rr * n + cc], S[rr * n + cc]);
      // wanting a step twice as much cancels a step that costs twice as much: compare exp(output) / cost
      const v = out[k * 2] - Math.log(cost);
      if (v > bv) { bv = v; best = k; bc = cost; }
    }
    return [((best / 3) | 0) - 1, (best % 3) - 1, best, bc];
  }

  /** Energy a step costs: the effort of acting at all, more for a longer step, more again for each unit of height climbed (going down is free),
   *  for water (`depth` is the water on the cell stepped into: the cost grows with it, from nothing for a puddle to the full cost of swimming at swimming depth
   *  and no further; treading water costs the same) and for ploughing through snow (`snow`, the depth of the pack there: only when moving, standing in it is free). */
  stepCost(di, dj, rise, depth = 0, snow = 0) {
    return REST + (0.1 * (Math.abs(di) + Math.abs(dj))) / 2 + this.climb * Math.max(0, rise) + this.swim * Math.min(1, depth / this.swimDepth) + (di || dj ? this.snowCost * Math.min(this.snowCap, snow) : 0);
  }

  /** Which cell of a 3 x 3 output grid has the strongest signal. `ch` of `chs` picks one of the grid's channels. Returns [di, dj, index]. */
  static argmax9(out, ch, chs) {
    let best = 0, bv = -Infinity;
    for (let k = 0; k < 9; k++) {
      const v = out[k * chs + ch];
      if (v > bv) { bv = v; best = k; }
    }
    return [((best / 3) | 0) - 1, (best % 3) - 1, best];
  }

  /** Fill `buf` with the 9 x 9 x 3 colour field around (r, c): animals are coloured by diet, the ground as it looks in the land view (bare ground shaded by height and by the slope's light, with grass, water
   *  and snow over it: see `landRgb`), each number being the colour's red, green or blue as (value / 255) - 0.5. Every cell fades toward grey by how clearly the sun lights it (see `clarityOf`);
   *  past the edge of the map, where there is nothing to light, by the light on the cell the animal stands on. (`land.light` must be for the current sun: see `Land.ensureLight`.) */
  look(r, c, buf) {
    const n = this.n, L = this.land, LT = L.light, half = 4, here = clarityOf(LT[r * n + c]), rgb = this.seenRgb ??= new Float64Array(3);
    let p = 0;
    for (let i = 0; i < 9; i++) {
      const rr = r + i - half;
      for (let j = 0; j < 9; j++) {
        const cc = c + j - half, off = rr < 0 || rr >= n || cc < 0 || cc >= n;
        const o = off ? null : this.grid[rr * n + cc];
        const f = off ? here : clarityOf(LT[rr * n + cc]);
        let c0, c1, c2;
        if (off) { c0 = c1 = c2 = -0.5; }   // past the edge of the map: black
        else if (o) { [c0, c1, c2] = o.col; }
        else {
          const k = rr * n + cc;
          landRgb(L.elev[k], L.slope[k], L.grass[k], L.water[k], L.snow[k], rgb);
          c0 = rgb[0] / 255 - 0.5; c1 = rgb[1] / 255 - 0.5; c2 = rgb[2] / 255 - 0.5;
        }
        buf[p++] = SEEN_GREY + (c0 - SEEN_GREY) * f; buf[p++] = SEEN_GREY + (c1 - SEEN_GREY) * f; buf[p++] = SEEN_GREY + (c2 - SEEN_GREY) * f;
      }
    }
  }

  /** What an animal sees and decides right now, without changing anything. */
  brain(org) {
    this.land.ensureLight(this.clim);
    this.look(org.r, org.c, this.in9);
    const input = Float32Array.from(this.in9);
    if (org.energy <= 1) return { k: 9, input, layers: [], act: false, why: 'too weak to act' };
    const out = org.net.forward(this.in9);
    const layers = org.net.bufs.map((b) => Float32Array.from(b));
    const move = this.choose(org, out);
    const breed = World.argmax9(out, 1, 2);
    const n = this.n, E = this.land.elev, W = this.land.water, S = this.land.snow, here = E[org.r * n + org.c], costs = [];
    for (let k = 0; k < 9; k++) {
      const di = ((k / 3) | 0) - 1, dj = (k % 3) - 1, rr = org.r + di, cc = org.c + dj, j = rr * n + cc;
      costs.push(rr < 0 || rr >= n || cc < 0 || cc >= n ? WALL : this.stepCost(di, dj, E[j] - here, W[j], S[j]));
    }
    return { k: 9, input, layers, act: true, move, breed, costs };
  }

  remove(org) {
    this.grid[org.r * this.n + org.c] = null;
    this.animals.delete(org.id);
    if (this.gpu) this.gpu.died(org);
  }

  /** The nitrogen an animal carries goes back into the soil where it falls. */
  die(org) {
    this.land.fertilise(org.r * this.n + org.c, org.bodyN + org.plantN + org.meatN);
    this.remove(org);
  }

  /** `att` bites `victim`: it takes part of the energy as meat, and half the nitrogen; the rest of the carcass fertilises the cell. */
  kill(att, victim) {
    const N = victim.bodyN + victim.plantN + victim.meatN;
    att.meat += victim.energy * this.meatShare;
    att.meatN += N / 2;
    this.land.fertilise(victim.r * this.n + victim.c, N / 2);
    this.remove(victim);
    this.hunted++;
  }

  /** Graze the cell it stands on, then digest: food turns into energy as well as the animal's diet allows, and what it cannot use is dropped as nitrogen on the ground below. */
  feed(a) {
    const L = this.land, i = a.r * this.n + a.c;
    const room = this.gutMax - a.plant;
    if (room > 0) {
      const e = L.graze(i, Math.min(this.bite * L.open(i), room));   // snow over the grass makes it harder to get at
      if (e.grass > 0) { a.plant += e.grass; a.plantN += e.nitrogen; this.eaten += e.grass; }
    }
    const r = this.digestRate;
    if (a.plant > 0) {
      const eff = Math.max(0.05, 1 - a.diet), x = a.plant * r, xn = a.plantN * r;
      a.plant -= x; a.plantN -= xn;
      a.energy += x * this.plantEnergy * eff; a.bodyN += xn * eff; L.fertilise(i, xn * (1 - eff));
    }
    if (a.meat > 0) {
      const eff = Math.max(0.05, a.diet), x = a.meat * r, xn = a.meatN * r;
      a.meat -= x; a.meatN -= xn;
      a.energy += x * eff; a.bodyN += xn * eff; L.fertilise(i, xn * (1 - eff));
    }
    const ex = a.bodyN * this.excrete;
    a.bodyN -= ex; L.fertilise(i, ex);
  }

  /** Pair breeding: random order, mutual pointers mate, otherwise breed into an empty target. Only animals with similar diets mate. */
  breed(wants) {
    const n = this.n, rng = this.rng, pool = this.animals;
    const ids = rng.shuffle([...wants.keys()]);
    const waiting = new Set(ids);
    const cost = 25;

    const child = (p1, p2, r, c) => {
      if (this.gpu && !this.gpu.hasRoom()) return;   // (no room left for another brain on the card)
      const g = p1 === p2 ? copyGenome(p1.genome) : crossover(p1.genome, p2.genome, rng);
      mutate(g, rng, this.hiddenIds);
      const diet = Math.min(1, Math.max(0, (p1 === p2 ? p1.diet : (p1.diet + p2.diet) / 2) + rng.normal(0.02)));
      const o = this.spawn(g, diet);
      // the child's body nitrogen comes from its parents'
      const g1 = p1.bodyN * 0.2; p1.bodyN -= g1; o.bodyN += g1;
      const g2 = p2.bodyN * 0.2; p2.bodyN -= g2; o.bodyN += g2;
      o.r = r; o.c = c;
      this.grid[r * n + c] = o;
      p1.energy -= cost; p2.energy -= cost;   // an asexual parent pays twice, as in the original
      this.births.count++;
      if (p1 !== p2) this.births.mated++;
    };

    for (const id1 of ids) {
      if (!waiting.has(id1)) continue;
      const org1 = pool.get(id1);
      if (!org1) { waiting.delete(id1); continue; }   // eaten after it asked to breed
      const [r, c] = wants.get(id1);
      if (this.mating && (r !== org1.r || c !== org1.c)) {
        const org2 = this.grid[r * n + c];
        if (org2 && waiting.has(org2.id) && Math.abs(org2.diet - org1.diet) < 0.3) {
          const [r2, c2] = wants.get(org2.id);
          if (r2 === org1.r && c2 === org1.c) {
            const open = [];
            for (const [i, j] of NEIGHBOURS) {
              const rr = org1.r + i, cc = org1.c + j;
              if (rr >= 0 && rr < n && cc >= 0 && cc < n && !this.grid[rr * n + cc]) open.push([rr, cc]);
            }
            if (open.length) {
              const [rr, cc] = rng.pick(open);
              child(org1, org2, rr, cc);
              waiting.delete(id1); waiting.delete(org2.id);
              continue;
            }
          }
        }
      }
      if (!this.grid[r * n + c]) child(org1, org1, r, c);
      waiting.delete(id1);
    }
  }

  /** One step on the CPU: the ground changes, then every animal looks and decides from the same snapshot of the world, then they act one at a time in a random order. */
  step() {
    this.land.step(this.clim, this.occ);
    const list = [...this.animals.values()];
    this.decide(list);
    this.act(list);
  }

  /** The same step with the ground and the brains on the graphics card (see gpu.js). Returns a promise. */
  async stepGpu() {
    const list = [...this.animals.values()];
    const res = await this.gpu.step(list);
    for (let i = 0; i < list.length; i++) list[i].dec = res[i] === 0xffffffff ? 255 : res[i];
    this.act(list);
  }

  /** Give back what this world holds on the graphics card. */
  dispose() { this.gpu?.destroy(); this.gpu = null; }

  /** Take one step, on whichever side this world runs. Always await it. */
  advance() { return this.gpu ? this.stepGpu() : this.step(); }

  /** Every animal that can act looks, thinks and picks a step and a place to breed, all from the world as it stands at the start of the step. Stored in `dec`: the step (0-8) and the breeding cell (0-8) times 16, or 255 for nothing. */
  decide(list) {
    this.land.ensureLight(this.clim);
    for (const a of list) {
      if (a.energy <= 1) { a.dec = 255; continue; }
      this.look(a.r, a.c, this.in9);
      const out = a.net.forward(this.in9);
      a.dec = this.choose(a, out)[2] | (World.argmax9(out, 1, 2)[2] << 4);
    }
  }

  /** Everyone carries out what they decided, one at a time in a fresh random order (so no one always goes first), then feeds, burns energy, breeds or dies. */
  act(list) {
    const n = this.n, rng = this.rng, E = this.land.elev, W = this.land.water, S = this.land.snow;
    const wants = new Map(), dead = [];
    for (const a of rng.shuffle(list)) {
      if (this.animals.get(a.id) !== a) continue;               // eaten earlier this step
      if (a.dec !== 255) {
        const pick = a.dec & 15, bk = a.dec >> 4, di = ((pick / 3) | 0) - 1, dj = (pick % 3) - 1;
        this.moves[pick]++;
        if (di || dj) {
          const r2 = a.r + di, c2 = a.c + dj, to = r2 * n + c2;   // (the brain never picks a wall)
          const cost = this.stepCost(di, dj, E[to] - E[a.r * n + a.c], W[to], S[to]);
          const o = this.grid[to];
          if (o) { if (rng.next() < a.diet * a.diet) this.kill(a, o); }   // someone is there now: a hunter bites, a grazer all but never does
          else {
            this.grid[a.r * n + a.c] = null;
            a.r = r2; a.c = c2;
            this.grid[to] = a;
          }
          a.energy -= cost - REST;   // trying costs the same whether or not it works
          this.land.heat(a.r * n + a.c, cost - REST);
        } else {
          const here = a.r * n + a.c, tread = this.swim * Math.min(1, W[here] / this.swimDepth);   // staying put in water deep enough to swim is not rest: it keeps itself afloat
          if (tread > 0) { a.energy -= tread; this.land.heat(here, tread); }
        }
        if (a.energy > 100) {
          const bi = ((bk / 3) | 0) - 1, bj = (bk % 3) - 1;
          if (a.r + bi >= 0 && a.r + bi < n && a.c + bj >= 0 && a.c + bj < n) wants.set(a.id, [a.r + bi, a.c + bj]);   // (no breeding into a wall)
        }
      }
      this.feed(a);
      const here = a.r * n + a.c, burn = rng.uniform(0, 0.05) * this.land.coldAt(here);   // burning more where it is colder: up the hill, and in winter
      a.energy -= burn;
      this.land.heat(here, burn);   // and giving it off as warmth to the cell, and so to its neighbours
      a.col[2] = 0.5 - Math.min(1, Math.max(0, (a.energy - 10) / 100));
      if (a.energy <= 0) { dead.push(a); wants.delete(a.id); }
    }
    for (const a of dead) if (this.animals.get(a.id) === a) this.die(a);   // (one that starved may have been eaten since)
    this.breed(wants);

    this.occ.fill(0);
    for (const a of this.animals.values()) this.occ[a.r * n + a.c] = 1;

    this.t++;
    this.climate();
    this.record();
  }

  record() {
    let p = 0, w = 0;
    for (const a of this.animals.values()) if (a.diet >= 0.5) w++; else p++;
    this.nPrey = p; this.nWolf = w;
    this.history.t.push(this.t);
    this.history.grass.push(this.land.sum(this.land.grass));
    this.history.prey.push(p);
    this.history.wolf.push(w);
  }

  /** Nitrogen the animals are carrying, for the land's audit. */
  animalNitrogen() {
    let s = 0;
    for (const a of this.animals.values()) s += a.bodyN + a.plantN + a.meatN;
    return s;
  }

  meanEnergy(list) {
    if (!list.length) return 0;
    let s = 0;
    for (const o of list) s += o.energy;
    return s / list.length;
  }

  at(r, c) {
    return this.grid[r * this.n + c];
  }
}
