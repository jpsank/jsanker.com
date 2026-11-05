// Tests for the bit-packed Game of Life stepper in public/life/life.js.
//   node tests/life_test.js
// Compares stepPacked() against a plain one-byte-per-cell reference on random toroidal grids,
// for several rules and grid shapes, and checks a few known patterns.
'use strict';
const path = require('path');
const { parseRLE, parseRule, stepPacked, popcount32 } = require(path.join(__dirname, '..', 'public', 'life', 'life.js'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('FAIL: ' + msg); } }

// tiny deterministic PRNG so failures are reproducible
let seed = 12345;
function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }

function randomGrid(cols, rows, density) {
  const g = new Uint8Array(cols * rows);
  for (let i = 0; i < g.length; i++) g[i] = rnd() < density ? 1 : 0;
  return g;
}

function pack(g, cols, rows) {
  const W = cols >> 5;
  const out = new Int32Array(W * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      if (g[y * cols + x]) out[y * W + (x >> 5)] |= 1 << (x & 31);
  return out;
}

function unpack(p, cols, rows) {
  const W = cols >> 5;
  const g = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) g[y * cols + x] = (p[y * W + (x >> 5)] >>> (x & 31)) & 1;
  return g;
}

function referenceStep(g, cols, rows, rule) {
  const out = new Uint8Array(g.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (dx || dy) n += g[((y + dy + rows) % rows) * cols + ((x + dx + cols) % cols)];
      out[y * cols + x] = g[y * cols + x] ? rule.survive[n] : rule.birth[n];
    }
  }
  return out;
}

// ---- popcount
ok(popcount32(0) === 0, 'popcount 0');
ok(popcount32(-1) === 32, 'popcount all ones');
ok(popcount32(0x80000000 | 0) === 1, 'popcount top bit');
ok(popcount32(0x55555555) === 16, 'popcount alternating');
for (let i = 0; i < 200; i++) {
  const v = (rnd() * 4294967296) | 0;
  let c = 0;
  for (let b = 0; b < 32; b++) c += (v >>> b) & 1;
  ok(popcount32(v) === c, 'popcount random ' + v);
}

// ---- packed vs reference, many rules / shapes / densities
const rules = ['B3/S23', 'B36/S23', 'B2/S', 'B3678/S34678', 'B1357/S1357', 'B012345678/S012345678', 'B/S', 'B45678/S0123'];
const shapes = [[32, 3], [32, 32], [64, 5], [96, 17], [128, 40], [480, 30]];
for (const r of rules) {
  const rule = parseRule(r);
  ok(rule !== null, 'rule parses: ' + r);
  for (const [cols, rows] of shapes) {
    for (const density of [0.05, 0.3, 0.5, 0.9, 1]) {
      let g = randomGrid(cols, rows, density);
      let p = pack(g, cols, rows);
      let q = new Int32Array(p.length);
      for (let gen = 0; gen < 4; gen++) {
        g = referenceStep(g, cols, rows, rule);
        stepPacked(p, q, cols >> 5, rows, rule);
        const t = p; p = q; q = t;
        const same = unpack(p, cols, rows).every((v, i) => v === g[i]);
        ok(same, `${r} ${cols}x${rows} density ${density} gen ${gen + 1}`);
        if (!same) break;
      }
    }
  }
}

// ---- known patterns on the wrapping grid
{
  const cols = 64, rows = 40, rule = parseRule('B3/S23');
  const place = (rle, ox, oy) => {
    const g = new Uint8Array(cols * rows);
    const pat = parseRLE(rle);
    for (let i = 0; i < pat.cells.length; i += 2) g[(pat.cells[i + 1] + oy) * cols + pat.cells[i] + ox] = 1;
    return g;
  };
  const run = (g, n) => {
    let p = pack(g, cols, rows), q = new Int32Array(p.length);
    for (let i = 0; i < n; i++) { stepPacked(p, q, cols >> 5, rows, rule); const t = p; p = q; q = t; }
    return unpack(p, cols, rows);
  };
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  const block = place('x = 2, y = 2\n2o$2o!', 10, 10);
  ok(same(run(block, 7), block), 'block is still');

  const blinker = place('x = 3, y = 1\n3o!', 10, 10);
  ok(!same(run(blinker, 1), blinker) && same(run(blinker, 2), blinker), 'blinker has period 2');

  // a glider moves (+1,+1) every 4 generations
  const glider = place('x = 3, y = 3\nbob$2bo$3o!', 5, 5);
  const moved = run(glider, 4);
  const shifted = place('x = 3, y = 3\nbob$2bo$3o!', 6, 6);
  ok(same(moved, shifted), 'glider moves one cell diagonally in 4 generations');

  // a glider crossing the left/right and top/bottom seams of the torus (word boundaries at x = 31/32)
  const edge = place('x = 3, y = 3\nbob$2bo$3o!', 29, 37);
  const edgeAfter = run(edge, 4 * 6);
  const wrap = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (edge[y * cols + x]) wrap[((y + 6) % rows) * cols + ((x + 6) % cols)] = 1;
  ok(same(edgeAfter, wrap), 'glider crosses a word boundary and the torus seam correctly');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
