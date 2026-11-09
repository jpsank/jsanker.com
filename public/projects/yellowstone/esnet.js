// The animals' brains, grown from their genomes the ES-HyperNEAT way: the genome (a CPPN, see sim.js) is asked about pairs of places in a 3D space, but this time it also decides where the
// brain's hidden neurons are and how many there are, instead of weights for a fixed layout.
//
// The eye (252 inputs) and the 18 outputs have fixed places. The hidden neurons can only sit on a small grid of candidate places (`grid` along each axis), and each of the `stages` layers has that whole
// grid to itself. A hidden neuron exists where the genome's weight function, asked for a connection from a source into that place, says something strong that differs from what it says next door (the
// "band" test: a connection is kept at the edge of a region, where the weight changes, and not all through the middle of it, so smooth regions are not filled with neurons). The genome is also told the
// layer of the receiving and of the sending neuron, so that the layers can differ. The brain is grown layer by layer:
//   1. places that get connections from the eye are the neurons of layer 1;
//   2. places that get connections from layer 1 neurons are the neurons of layer 2, and places that get connections from layers 1 and 2 are those of layer 3;
//   3. every neuron found is then asked for a connection to each output, and any neuron with no way to reach an output is dropped (with the neurons only it was feeding).
// So how many hidden neurons there are, how deep they go, how densely they are wired and which parts of the eye matter all come out of the genome.
//
// This file is the reference (in 64-bit numbers, on the CPU). gpu.js grows the same brains on the graphics card, one workgroup for each newborn, in the same order and with the same rules.

export const ES = {
  grid: 4,         // candidate places along each axis (so grid^3 of them)
  stages: 3,       // the deepest a hidden neuron can be
  wThr: 0.4,       // a connection must be at least this strong...
  bandThr: 0.3,    // ...and differ at least this much from its neighbour on both sides along some axis
  outThr: 0.6,     // a connection to an output must be at least this strong
  fanH: 32,        // most connections into one hidden neuron (the first found, in a scrambled order of the sources, so that the eye is not favoured on one side)
  fanO: 48,        // and into one output
  scramble: 37,    // the order the eye is asked about is (k x scramble) mod 252, a shuffle because 252 and 37 share no factor
  layerCap: [32, 16, 16],   // the most neurons in each layer (the first found, in the order of the places)
};
ES.layerAt = (l) => -1 + 2 * l;   // the number a genome is told for a layer: 0 is the eye, 1 to 3 the hidden layers, 4 the outputs (so -1, 1, 3, 5, 7)
ES.places = ES.grid ** 3;   // the candidate places for the neurons of one layer
ES.cells = ES.layerCap.reduce((x, y) => x + y, 0);   // the room for hidden neurons altogether
ES.layerOff = ES.layerCap.map((_, i) => ES.layerCap.slice(0, i).reduce((x, y) => x + y, 0));   // where each layer's neurons are numbered from

/** The centres of the candidate places, cell by cell (x slowest, z fastest), three numbers each, in [-1, 1]. */
export function cellCoords() {
  const G = ES.grid, out = new Float64Array(ES.places * 3);
  let k = 0;
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) for (let l = 0; l < G; l++) {
    out[k++] = -1 + (2 * i + 1) / G; out[k++] = -1 + (2 * j + 1) / G; out[k++] = -1 + (2 * l + 1) / G;
  }
  return out;
}
const CELLS = cellCoords();

/** For each cell and axis, the neighbour on the low and high side (or -1 at the edge of the grid): [cell * 6 + axis * 2 + (0 low | 1 high)]. */
const NBR = (() => {
  const G = ES.grid, out = new Int16Array(ES.places * 6).fill(-1);
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) for (let l = 0; l < G; l++) {
    const d = (i * G + j) * G + l, at = [i, j, l], stride = [G * G, G, 1];
    for (let a = 0; a < 3; a++) {
      if (at[a] > 0) out[d * 6 + a * 2] = d - stride[a];
      if (at[a] < G - 1) out[d * 6 + a * 2 + 1] = d + stride[a];
    }
  }
  return out;
})();

/** Where a brain's numbers live. Hidden neuron d's incoming connections are in [d * fanH, d * fanH + cnt[d]); output o's are from `outBase + o * fanO`. A source is an input (0 to nIn - 1) or a
 *  hidden neuron (nIn + its cell). Neurons that do not exist have a depth of 0 and a count of 0. */
export function brainShape(nIn, nOut) {
  const cells = ES.cells;
  return { nIn, nOut, cells, outBase: cells * ES.fanH, slots: cells * ES.fanH + nOut * ES.fanO };
}

/**
 * Grow a brain. `cppn(rx, ry, rz, sx, sy, sz, rl, sl)` is the genome (the receiving place first, then the sending one, then the layer of each, see ES.layerAt), `inputs` and `outputs` the places of the eye and the actions (three numbers each).
 * Returns { depth, cnt, src, w, bias, conns, ... }: see `brainShape`; `bias` has a number for every cell and then every output.
 */
export function growBrain(cppn, inputs, outputs) {
  const nIn = inputs.length / 3, nOut = outputs.length / 3, S = brainShape(nIn, nOut), C = ES.cells, P = ES.places, F = ES.fanH;
  const depth = new Uint8Array(C), cnt = new Uint16Array(C + nOut), src = new Uint16Array(S.slots), w = new Float32Array(S.slots), bias = new Float32Array(C + nOut);
  const cellOf = new Uint8Array(C), wv = new Float64Array(P);
  // one layer's worth of candidate connections, kept by place until the places that get any are known
  const sCnt = new Uint16Array(P), sSrc = new Uint16Array(P * F), sW = new Float32Array(P * F);

  // ask the genome about a source for every place of the layer being grown, and keep the connections that pass
  function ask(s, sx, sy, sz, lr, ls) {
    for (let d = 0; d < P; d++) wv[d] = cppn(CELLS[d * 3], CELLS[d * 3 + 1], CELLS[d * 3 + 2], sx, sy, sz, lr, ls);
    for (let d = 0; d < P; d++) {
      if (sCnt[d] >= F) continue;
      const aw = Math.abs(wv[d]);
      if (!(aw > ES.wThr)) continue;
      let band = 0;
      for (let a = 0; a < 3; a++) {
        const lo = NBR[d * 6 + a * 2], hi = NBR[d * 6 + a * 2 + 1];
        const dl = lo < 0 ? aw : Math.abs(wv[d] - wv[lo]), dh = hi < 0 ? aw : Math.abs(wv[d] - wv[hi]);
        const m = dl < dh ? dl : dh;
        if (m > band) band = m;
      }
      if (band > ES.bandThr) { const at = d * F + sCnt[d]++; sSrc[at] = s; sW[at] = wv[d]; }
    }
  }

  // Layer by layer. Every layer has the whole grid of places to itself (a place in layer 2 is not the same neuron as the place in layer 1), and the neurons of a layer are the places that got a connection,
  // the first of them in the order of the places up to the room that layer has (ES.layerCap). Neuron k of a layer is numbered ES.layerOff + k.
  for (let stage = 1; stage <= ES.stages; stage++) {
    sCnt.fill(0);
    if (stage === 1) {
      for (let k = 0; k < nIn; k++) {
        const s = (k * ES.scramble) % nIn;
        ask(s, inputs[s * 3], inputs[s * 3 + 1], inputs[s * 3 + 2], ES.layerAt(1), ES.layerAt(0));
      }
    } else {
      for (let n = 0; n < ES.layerOff[stage - 1]; n++) if (depth[n]) { const c = cellOf[n]; ask(nIn + n, CELLS[c * 3], CELLS[c * 3 + 1], CELLS[c * 3 + 2], ES.layerAt(stage), ES.layerAt(depth[n])); }
    }
    let rank = 0;
    for (let d = 0; d < P && rank < ES.layerCap[stage - 1]; d++) {
      if (!sCnt[d]) continue;
      const id = ES.layerOff[stage - 1] + rank++;
      depth[id] = stage; cnt[id] = sCnt[d]; cellOf[id] = d;
      for (let q = 0; q < sCnt[d]; q++) { src[id * F + q] = sSrc[d * F + q]; w[id * F + q] = sW[d * F + q]; }
    }
  }

  // the outputs ask every neuron found for a connection
  const useful = new Uint8Array(C);
  for (let o = 0; o < nOut; o++) {
    const base = S.outBase + o * ES.fanO;
    for (let n = 0; n < C; n++) {
      if (!depth[n] || cnt[C + o] >= ES.fanO) continue;
      const v = cppn(outputs[o * 3], outputs[o * 3 + 1], outputs[o * 3 + 2], CELLS[cellOf[n] * 3], CELLS[cellOf[n] * 3 + 1], CELLS[cellOf[n] * 3 + 2], ES.layerAt(4), ES.layerAt(depth[n]));
      if (Math.abs(v) > ES.outThr) { const at = base + cnt[C + o]++; src[at] = nIn + n; w[at] = v; useful[n] = 1; }
    }
  }
  // a neuron that cannot reach an output is dropped, and so are the neurons that only fed it
  for (let stage = ES.stages; stage >= 2; stage--) {
    for (let d = 0; d < C; d++) if (depth[d] === stage && useful[d]) for (let q = 0; q < cnt[d]; q++) { const s = src[d * F + q]; if (s >= nIn) useful[s - nIn] = 1; }
  }
  let conns = 0, hidden = 0, deepest = 0;
  for (let d = 0; d < C; d++) {
    if (!useful[d]) { depth[d] = 0; cnt[d] = 0; continue; }
    const c = cellOf[d];
    hidden++; conns += cnt[d]; if (depth[d] > deepest) deepest = depth[d];
    bias[d] = cppn(CELLS[c * 3], CELLS[c * 3 + 1], CELLS[c * 3 + 2], -1, 0, 0, ES.layerAt(depth[d]), ES.layerAt(0));
  }
  for (let o = 0; o < nOut; o++) { conns += cnt[C + o]; bias[C + o] = cppn(outputs[o * 3], outputs[o * 3 + 1], outputs[o * 3 + 2], -1, 0, 0, ES.layerAt(4), ES.layerAt(0)); }
  return { shape: S, depth, cnt, src, w, bias, conns, hidden, deepest, hv: new Float32Array(C), out: new Float32Array(nOut) };
}

/** Run a grown brain on an input vector. Returns its output vector (linear: the last layer is compared as it is). */
export function runBrain(b, input) {
  const { depth, cnt, src, w, bias, hv, out, shape: S } = b, nIn = S.nIn, C = S.cells;
  for (let stage = 1; stage <= ES.stages; stage++) {
    for (let d = 0; d < C; d++) {
      if (depth[d] !== stage) continue;
      let s = bias[d];
      const at = d * ES.fanH;
      for (let q = 0; q < cnt[d]; q++) { const j = src[at + q]; s += w[at + q] * (j < nIn ? input[j] : hv[j - nIn]); }
      hv[d] = Math.tanh(s);
    }
  }
  for (let o = 0; o < S.nOut; o++) {
    let s = bias[C + o];
    const at = S.outBase + o * ES.fanO;
    for (let q = 0; q < cnt[C + o]; q++) { const j = src[at + q]; s += w[at + q] * (j < nIn ? input[j] : hv[j - nIn]); }
    out[o] = s;
  }
  return out;
}

/* ---------------------------------------------------------------- how a brain is kept on the card */

// One record of 32-bit words for each brain: a word for every neuron (its depth in the low four bits and how many connections come into it above that: hidden neurons first, then the outputs; a
// depth of 0 means there is no such neuron), then the biases as 16-bit floats in pairs, then the connections, hidden neurons' regions first and then the outputs' (as in `brainShape`): the source
// in the low 16 bits and the weight as a 16-bit float in the high ones.
export function recordLayout(nIn, nOut) {
  const S = brainShape(nIn, nOut), nodes = S.cells + nOut, bias = nodes, ent = bias + Math.ceil(nodes / 2);
  return { ...S, nodes, biasAt: bias, entAt: ent, outAt: ent + S.outBase, words: ent + S.slots };
}

const fb = new Float32Array(1), ub = new Uint32Array(fb.buffer);
/** Round a number to the nearest 16-bit float, as its bits. */
export function toHalf(x) {
  fb[0] = x;
  const b = ub[0], sign = (b >>> 16) & 0x8000, ex = (b >>> 23) & 0xff;
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

/** A grown brain as the record the card keeps (see recordLayout). */
export function packRecord(b, L) {
  const out = new Uint32Array(L.words), C = L.cells, halves = new Uint16Array(L.nodes + (L.nodes & 1));
  for (let d = 0; d < C; d++) { out[d] = b.depth[d] | (b.cnt[d] << 4); halves[d] = toHalf(b.bias[d]); }
  for (let o = 0; o < L.nOut; o++) { out[C + o] = 1 | (b.cnt[C + o] << 4); halves[C + o] = toHalf(b.bias[C + o]); }
  for (let k = 0; k < halves.length; k += 2) out[L.biasAt + (k >> 1)] = halves[k] | (halves[k + 1] << 16);
  for (let d = 0; d < C; d++) for (let q = 0; q < b.cnt[d]; q++) { const at = d * ES.fanH + q; out[L.entAt + at] = (b.src[at] | (toHalf(b.w[at]) << 16)) >>> 0; }
  for (let o = 0; o < L.nOut; o++) for (let q = 0; q < b.cnt[C + o]; q++) { const at = L.outBase + o * ES.fanO + q; out[L.entAt + at] = (b.src[at] | (toHalf(b.w[at]) << 16)) >>> 0; }
  return out;
}
