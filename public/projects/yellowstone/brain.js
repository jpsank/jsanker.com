// The brain viewer: click an organism and see what it sees, what each layer of its network does, what it decides,
// and the NEAT genome that grew the network. Plain SVG; everything is rebuilt from sim.js's World.brain() and genomeGraph().
import { speciesName, genomeGraph, ACT_NAMES, EYES, SAMPLES, fovDeg, BREED_REL } from './sim.js';
import { ES } from './esnet.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent, title) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (title !== undefined) { const t = document.createElementNS(SVGNS, 'title'); t.textContent = title; e.appendChild(t); }
  if (parent) parent.appendChild(e);
  return e;
}
const text = (parent, attrs, str) => { const t = el('text', attrs, parent); t.textContent = str; return t; };

const POS = '235,104,52', NEG = '59,130,196';
const signed = (v) => (v >= 0 ? `rgba(${POS},${Math.min(1, v).toFixed(2)})` : `rgba(${NEG},${Math.min(1, -v).toFixed(2)})`);
const num = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

const COORD = ['to x', 'to y', 'to z', 'from x', 'from y', 'from z'];
const ACT_SHORT = ['sigmoid', 'relu', 'tanh', 'sin', 'cos'];

const HEADINGS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const REL_NAMES = ['straight ahead', 'ahead and to the right', 'to the right', 'behind and to the right', 'behind', 'behind and to the left', 'to the left', 'ahead and to the left'];
/** What action cell k of the movement grid means: columns turn (left, none, right), rows move (forward, stay, back). */
const moveName = (k) => {
  const row = Math.floor(k / 3), col = k % 3;
  if (k === 4) return 'stays put';
  if (row === 1) return col === 0 ? 'turns left on the spot' : 'turns right on the spot';
  const way = row === 0 ? 'forward' : 'back';
  return col === 1 ? `steps ${way}` : `turns ${col === 0 ? 'left' : 'right'} and steps ${way}`;
};
const breedName = (k) => (BREED_REL[k] < 0 ? 'nobody (itself)' : REL_NAMES[BREED_REL[k]]);

/** A ring segment between two radii and two angles (clockwise from straight up), as an SVG path. */
function sector(cx, cy, r0, r1, a0, a1) {
  const pt = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  return `M${pt(r1, a0)} A${r1} ${r1} 0 0 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 0 0 ${pt(r0, a0)} Z`;
}

/** A 3 x 3 (or k x k) grid of cells. Returns the rects, row-major. */
function grid(parent, x, y, k, cell, label) {
  const g = el('g', {}, parent);
  const rects = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    rects.push(el('rect', { class: 'gp-cell', x: x + j * cell, y: y + i * cell, width: cell - 1, height: cell - 1, rx: 1.5 }, g, ''));
  }
  if (label) text(g, { class: 'gp-tick', x: x + (k * cell) / 2, y: y + k * cell + 13, 'text-anchor': 'middle' }, label);
  return rects;
}

export function createBrainPanel(host) {
  const head = host.querySelector('.brain-head');
  const note = host.querySelector('.brain-note');
  const subHost = host.querySelector('.brain-sub');
  const genomeHost = host.querySelector('.brain-genome');
  const genomeNote = host.querySelector('.brain-genome-note');
  let sel = null, parts = null, deadAt = null, lastDraw = 0;

  /* ---- the network, layer by layer (built once per organism, repainted as it runs) */

  function buildSub(org) {
    subHost.replaceChildren();
    const k = 9, W = 720, cellO = 24, H = 236, fan = 90;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'gp-svg', role: 'img', 'aria-label': 'The animal\'s network: what it sees, the hidden neurons its genome grew, and what it picks' }, subHost);
    const p = { k, input: [], move: [], breed: [] };
    let marked = [];
    const mark = (e, how, a = 1) => { e.dataset.hl = how; e.style.setProperty('--hl-a', a.toFixed(2)); marked.push(e); };
    const unhighlight = () => { for (const e of marked) { delete e.dataset.hl; e.style.removeProperty('--hl-a'); } marked = []; };
    // the eye sectors a neuron depends on through the neurons it listens to (and theirs), with how strongly the connections along the way pass it on (the product of the weights is too small to mean much, so just the strongest link)
    const reach = new Map();
    const eyeVia = (d) => {
      if (reach.has(d)) return reach.get(d);
      const m = new Map(); reach.set(d, m);
      const l = p.listens.get(d);
      for (let q = 0; q < l.hid.length; q++) {
        const a = Math.abs(l.hw[q]);
        for (let t = 0; t < p.listens.get(l.hid[q]).eye.length; t++) { const i = p.listens.get(l.hid[q]).eye[t] / 3 | 0; m.set(i, Math.max(m.get(i) || 0, a * Math.abs(p.listens.get(l.hid[q]).ew[t]))); }
        for (const [i, v] of eyeVia(l.hid[q])) m.set(i, Math.max(m.get(i) || 0, a * v));
      }
      return m;
    };
    // what a neuron listens to (the parts of the eye and the neurons) and what it feeds (the pick cells), lit up around it
    const highlight = (d) => {
      unhighlight();
      mark(p.neuron.get(d), 'self');
      const l = p.listens.get(d), f = p.feeds.get(d), fw = p.feedW.get(d);
      // darker where the connection is stronger (as a share of the strongest one of that kind)
      const top = (v) => Math.max(1e-9, ...v.map(Math.abs)), te = top(l.ew), th = top(l.hw), tf = top(fw);
      const via = eyeVia(d), tv = Math.max(1e-9, ...via.values());
      for (const [i, v] of via) mark(p.input[i], 'via', 0.45 + 0.55 * v / tv);
      const direct = new Map();   // (the eye's numbers come three to a sector of the fan: red, green and blue, so the sector keeps its strongest)
      l.eye.forEach((i, q) => direct.set((i / 3) | 0, Math.max(direct.get((i / 3) | 0) || 0, Math.abs(l.ew[q]) / te)));
      for (const [i, v] of direct) mark(p.input[i], 'in', 0.3 + 0.7 * v);
      l.hid.forEach((n, q) => mark(p.neuron.get(n), 'in', 0.3 + 0.7 * Math.abs(l.hw[q]) / th));
      f.forEach((o, q) => mark((o & 1 ? p.breed : p.move)[o >> 1], 'out', 0.3 + 0.7 * Math.abs(fw[q]) / tf));
    };
    const y0 = 22;
    let x = 10;
    text(svg, { class: 'gp-label', x, y: 12 }, 'Sees');
    // the fan it sees, as it faces: straight ahead is up. Each ray is a wedge, and each distance a ring along it (the rings end at 1, 2, 4 and 6 cells out, each averaging the cells since the last).
    const fov = fovDeg(org.eyes), half = (fov / 2) * Math.PI / 180, wedge = (fov * Math.PI / 180) / (EYES.rays - 1);
    const cx = x + fan + 2, cy = y0 + fan + 4, edge = [0.4, 1.5, 3, 5, 7].map((c) => (c / 7) * fan), dist = EYES.seen.map((st) => st + 1);
    for (let ray = 0; ray < EYES.rays; ray++) for (let d = 0; d < SAMPLES; d++) {
      const mid = -half + ray * wedge;
      p.input.push(el('path', { class: 'gp-cell', d: sector(cx, cy, edge[d], edge[d + 1], mid - wedge / 2, mid + wedge / 2) }, svg, `${dist[d]} cell${dist[d] === 1 ? '' : 's'} out, ${Math.round(mid * 180 / Math.PI)}° from straight ahead`));
    }
    el('path', { class: 'gp-arrow', d: `M${cx} ${cy - 4} v-10 m-4 4 l4 -4 l4 4`, fill: 'none' }, svg);
    p.facing = text(svg, { class: 'gp-tick', x: cx, y: cy + fan * 0.88 + 14, 'text-anchor': 'middle' }, '');
    text(svg, { class: 'gp-tick', x: cx, y: H - 4, 'text-anchor': 'middle' }, `${Math.round(fov)}° field of view`);
    x += 2 * fan + 30;
    // the hidden neurons, by layer: layer 1 listens to the eye, layer 2 to layer 1, layer 3 to layers 1 and 2, and the outputs to all of them. Hover one to see what it listens to and what it feeds.
    const net = org.net, nIn = net.shape.nIn, C = ES.cells, PER = 7, CELL = 11, COLW = PER * CELL + 18;
    const layers = [[], [], [], []];
    for (let d = 0; d < C; d++) if (net.depth[d] > 0) layers[net.depth[d]].push(d);
    const fromEye = [0, 0, 0, 0], fromLayer = [[], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];   // (connections into each layer: from the eye, and from each layer)
    const listens = new Map(), feeds = new Map(), feedW = new Map();   // (per neuron: eye inputs, neurons, and outputs it connects to)
    for (let d = 0; d < C; d++) {
      const L = net.depth[d];
      if (!L) continue;
      const eye = [], hid = [], ew = [], hw = [];
      for (let q = 0; q < net.cnt[d]; q++) { const sidx = net.src[d * ES.fanH + q], wq = net.w[d * ES.fanH + q]; if (sidx < nIn) { eye.push(sidx); ew.push(wq); fromEye[L]++; } else { hid.push(sidx - nIn); hw.push(wq); fromLayer[L][net.depth[sidx - nIn]]++; } }
      listens.set(d, { eye, hid, ew, hw }); feeds.set(d, []); feedW.set(d, []);
    }
    const toOut = [0, 0, 0, 0];
    for (let o = 0; o < net.shape.nOut; o++) for (let q = 0; q < net.cnt[C + o]; q++) { const n = net.src[net.shape.outBase + o * ES.fanO + q] - nIn; feeds.get(n).push(o); feedW.get(n).push(net.w[net.shape.outBase + o * ES.fanO + q]); toOut[net.depth[n]]++; }
    const colX = [0, 1, 2].map((c) => x + c * COLW);
    p.neuron = new Map();
    const flowText = ['', `${fromEye[1].toLocaleString()} from eye`, `${fromLayer[2][1]} from layer 1`, `${fromLayer[3][1] + fromLayer[3][2]} from 1 and 2`];
    for (let L = 1; L <= 3; L++) {
      const cx0 = colX[L - 1], list = layers[L];
      text(svg, { class: 'gp-label', x: cx0, y: 12 }, `Layer ${L}` + (list.length ? ` · ${list.length}` : ''));
      if (!list.length) text(svg, { class: 'gp-tick', x: cx0, y: y0 + 40 }, 'none');
      list.forEach((d, i) => {
        const r = el('rect', { class: 'gp-cell', x: cx0 + (i % PER) * CELL, y: y0 + 30 + Math.floor(i / PER) * CELL, width: CELL - 1, height: CELL - 1, rx: 1.5, tabindex: 0 }, svg, '');
        const l = listens.get(d), f = feeds.get(d);
        const parts = [];
        if (l.eye.length) parts.push(`${l.eye.length} eye input${l.eye.length === 1 ? '' : 's'}`);
        if (l.hid.length) parts.push(`${l.hid.length} neuron${l.hid.length === 1 ? '' : 's'} in earlier layers`);
        r.dataset.info = `Layer ${L} neuron. Listens to ${parts.join(' and ')}. Feeds ${f.length} output${f.length === 1 ? '' : 's'}.`;
        r.addEventListener('mouseenter', () => highlight(d)); r.addEventListener('mouseleave', unhighlight);
        r.addEventListener('focus', () => highlight(d)); r.addEventListener('blur', unhighlight);
        p.neuron.set(d, r);
      });
      if (list.length) text(svg, { class: 'gp-tick', x: cx0, y: y0 + 178 - 22 }, flowText[L]);
    }
    p.arch = text(svg, { class: 'gp-tick', x: colX[0] + (3 * COLW - 18) / 2, y: y0 + 178, 'text-anchor': 'middle' }, '');
    p.net = net; p.listens = listens; p.feeds = feeds; p.feedW = feedW; p.toOut = toOut;
    x += 3 * COLW + 22;
    text(svg, { class: 'gp-label', x, y: 12 }, 'Picks');
    p.outX = x;
    p.move = grid(svg, x, y0 + 30, 3, cellO, 'move');
    p.breed = grid(svg, x + 3 * cellO + 14, y0 + 30, 3, cellO, 'breed');
    const mid = y0 + 30 + 36;
    const arrow = (ax) => el('path', { class: 'gp-arrow', d: `M${ax - 22} ${mid} h14 m-5 -4 l5 4 l-5 4`, fill: 'none' }, svg);
    arrow(10 + 2 * fan + 30); arrow(p.outX);
    p.say = text(svg, { class: 'gp-tick', x: 10 + 2 * fan + 30, y: H - 4 }, '');
    p.unhighlight = unhighlight;
    parts = p;
  }

  function paintSub(world, org) {
    const b = world.brain(org);
    const p = parts;
    p.facing.textContent = `facing ${HEADINGS[org.h]}`;
    for (let i = 0; i < b.input.length / 3; i++) {
      const r = Math.round((b.input[i * 3] + 0.5) * 255), g = Math.round((b.input[i * 3 + 1] + 0.5) * 255), bl = Math.round((b.input[i * 3 + 2] + 0.5) * 255);
      p.input[i].style.fill = `rgb(${r},${g},${bl})`;
    }
    const clear = (rects) => rects.forEach((r) => { r.style.fill = 'transparent'; r.setAttribute('class', 'gp-cell'); });
    if (!b.act) {
      for (const r of p.neuron.values()) { r.style.fill = 'transparent'; } clear(p.move); clear(p.breed); p.arch.textContent = '';
      p.say.textContent = `Doing nothing this step: ${b.why}.`;
      return;
    }
    const net = b.net, hid = b.hidden;
    for (const [d, rect] of p.neuron) {
      rect.style.fill = signed(hid[d]);
      rect.firstChild.textContent = `${rect.dataset.info} Value now ${num(hid[d])}.`;
    }
    p.arch.textContent = `${net.hidden} hidden neuron${net.hidden === 1 ? '' : 's'} in ${net.deepest} layer${net.deepest === 1 ? '' : 's'}, ${net.conns.toLocaleString()} connections (${p.toOut.reduce((x, y) => x + y, 0)} into the outputs)`;
    const out = b.out;
    for (let ch = 0; ch < 2; ch++) {
      const rects = ch === 0 ? p.move : p.breed;
      // the step grid shows what the animal weighs: how much it wants each step minus the log of what the step costs
      const val = (i) => (ch === 0 ? (b.costs[i] >= 1e29 ? -3 : out[i * 2] - Math.log(b.costs[i])) : out[i * 2 + 1]);   // (a wall is the worst there is)
      let mx = 1e-9;
      for (let i = 0; i < 9; i++) mx = Math.max(mx, Math.abs(val(i)));
      const pick = ch === 0 ? b.move[2] : b.breed[2];
      for (let i = 0; i < 9; i++) {
        rects[i].style.fill = signed(val(i) / mx);
        rects[i].setAttribute('class', i === pick ? 'gp-cell gp-pick' : 'gp-cell');
        const where = ch === 0 ? moveName(i) : breedName(i);
        rects[i].firstChild.textContent = ch === 0
          ? (b.costs[i] >= 1e29 ? `${where}: into the edge of the map` : `${where}: wants ${num(out[i * 2])}, costs ${b.costs[i].toFixed(2)}${i === pick ? ' (picked)' : ''}`)
          : `breed with whoever is ${where}: ${num(out[i * 2 + 1])}${i === pick ? ' (picked)' : ''}`;
      }
    }
    p.say.textContent = `It ${moveName(b.move[2])}; would breed with whoever is ${breedName(b.breed[2])} if it had the energy.`;
  }

  /* ---- the genome (built once per organism: it never changes during a life) */

  function buildGenome(org) {
    genomeHost.replaceChildren();
    const gg = genomeGraph(org.genome);
    const hidden = gg.nodes.filter((n) => n.id !== 0);
    const maxD = hidden.reduce((m, n) => Math.max(m, n.depth), 0);
    const cols = [gg.inputs.map((id) => ({ id, input: true }))];
    for (let d = 1; d <= maxD; d++) cols.push(hidden.filter((n) => n.depth === d));
    cols.push(gg.nodes.filter((n) => n.id === 0));
    const most = Math.max(1, ...cols.map((c) => c.length));
    const W = 640, H = Math.max(150, most * 30 + 30), L = 76, R = 110;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'gp-svg', role: 'img', 'aria-label': `The organism's NEAT genome: ${gg.nodes.length} neurons and ${gg.edges.length} connections that do something` }, genomeHost);
    const pos = new Map();
    cols.forEach((col, ci) => {
      const x = L + (ci / Math.max(1, cols.length - 1)) * (W - L - R);
      col.forEach((n, i) => pos.set(n.id, [x, ((i + 1) / (col.length + 1)) * H]));
    });
    const ge = el('g', {}, svg);
    for (const e of gg.edges) {
      const a = pos.get(e.s), b = pos.get(e.t);
      if (!a || !b) continue;
      el('path', {
        class: e.w >= 0 ? 'gp-edge gp-pos' : 'gp-edge gp-neg',
        d: `M${a[0]} ${a[1]} C${(a[0] + b[0]) / 2} ${a[1]} ${(a[0] + b[0]) / 2} ${b[1]} ${b[0]} ${b[1]}`,
        'stroke-width': (0.6 + Math.min(3.5, Math.abs(e.w) * 1.6)).toFixed(2), fill: 'none',
      }, ge, `weight ${num(e.w)}`);
    }
    for (const n of cols.flat()) {
      const [x, y] = pos.get(n.id);
      if (n.input) {
        el('circle', { class: 'gp-node', cx: x, cy: y, r: 5 }, svg, COORD[n.id + 8]);
        text(svg, { class: 'gp-tick', x: x - 10, y: y + 4, 'text-anchor': 'end' }, COORD[n.id + 8]);
      } else {
        const g = gg.nodes.find((q) => q.id === n.id);
        el('rect', { class: 'gp-node', x: x - 17, y: y - 9, width: 34, height: 18, rx: 6 }, svg, `${ACT_NAMES[g.act]}, bias ${num(g.bias)}`);
        text(svg, { class: 'gp-node-t', x, y: y + 3.5, 'text-anchor': 'middle' }, ACT_SHORT[g.act]);
        if (n.id === 0) text(svg, { class: 'gp-tick', x: x + 24, y: y + 4 }, 'connection weight');
      }
    }
    genomeNote.textContent = `${gg.nodes.length} neuron${gg.nodes.length === 1 ? '' : 's'} and ${gg.edges.length} connection${gg.edges.length === 1 ? '' : 's'} do something` +
      (gg.unused ? `, and ${gg.unused} more gene${gg.unused === 1 ? '' : 's'} are carried along but have no effect` : '') + '.';
  }

  /* ---- public */

  function describe(world) {
    const o = sel;
    const kind = speciesName(o)[0].toUpperCase() + speciesName(o).slice(1);
    head.textContent = `${kind} at row ${o.r}, column ${o.c}`;
    note.textContent = deadAt === null
      ? `Energy ${o.energy.toFixed(1)}. Diet ${o.diet.toFixed(2)} (0 digests only grass, 1 only meat).`
      : `Died at step ${deadAt}. This is its last view.`;
  }

  return {
    get selected() { return sel; },
    show(world, org) {
      sel = org; deadAt = null;
      host.hidden = false;
      buildSub(org);
      buildGenome(org);
      paintSub(world, org);
      describe(world);
    },
    clear() { sel = null; host.hidden = true; },
    /** Call after the world moves. Cheap when nothing is selected; throttled while running. */
    update(world, force = false) {
      if (!sel) return;
      const now = performance.now();
      if (!force && now - lastDraw < 120) return;
      lastDraw = now;
      if (deadAt === null) {
        const alive = world.animals.get(sel.id) === sel;
        if (!alive) deadAt = world.t;
      }
      if (deadAt === null) paintSub(world, sel);
      describe(world);
    },
  };
}
