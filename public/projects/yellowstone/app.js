// Yellowstone: the page. The simulation itself is in sim.js; nothing here talks to a server.
import { World } from './sim.js';
import { createBrainPanel } from './brain.js';
import { createGpu } from './gpu.js';
import { LANDVIEW, landRgb } from './land.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}

function s(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

const niceMax = (m) => {
  if (m <= 10) return 10;
  const p = 10 ** Math.floor(Math.log10(m));
  const f = m / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

/* ---------------------------------------------------------------- line chart (plain SVG) */

/**
 * Two lines against a shared axis. `get()` returns { t, grass, prey, mark } so a live run can keep appending.
 * The numbers under the pointer go into `readout`, so no value ever has to be read off the plot.
 */
function lineChart(host, readout, get, label, series) {   // get() returns { t, grass, prey, wolf, xMax }; series: [[key, label]...]
  const W = 640, H = 230, L = 46, R = 58, T = 10, B = 26;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, class: 'gp-svg' });
  host.replaceChildren(svg);
  const g = s('g', {}, svg);
  const cross = s('line', { class: 'gp-cross', y1: T, y2: H - B, visibility: 'hidden' }, svg);
  const hit = s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' }, svg);
  let last = null;

  function draw() {
    const d = get();
    last = d;
    g.replaceChildren();
    const n = d.t.length;
    const xMax = Math.max(100, d.xMax || d.t[n - 1] || 100);
    const keys = series.map((x) => x[0]).filter((k) => k !== 'wolf' || Math.max(0, ...d.wolf) > 0);
    const yMax = niceMax(Math.max(1, ...keys.map((k) => Math.max(0, ...d[k]))));
    const X = (t) => L + (t / xMax) * (W - L - R);
    const Y = (v) => H - B - (v / yMax) * (H - T - B);

    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4, y = Y(v);
      s('line', { class: i ? 'gp-grid' : 'gp-axis', x1: L, x2: W - R, y1: y, y2: y }, g);
      s('text', { class: 'gp-tick', x: L - 6, y: y + 4, 'text-anchor': 'end' }, g).textContent = fmt(v);
    }
    const xs = niceMax(xMax) / (xMax > 2500 ? 5 : 4);
    for (let t = 0; t <= xMax; t += xs) {
      s('text', { class: 'gp-tick', x: X(t), y: H - 8, 'text-anchor': 'middle' }, g).textContent = fmt(t);
    }
    s('text', { class: 'gp-tick gp-axis-title', x: W - R, y: H - 8, 'text-anchor': 'end' }, g).textContent = '';

    const stride = Math.max(1, Math.floor(n / 600));
    for (const key of keys) {
      let path = '';
      for (let i = 0; i < n; i += stride) path += (path ? 'L' : 'M') + X(d.t[i]).toFixed(1) + ' ' + Y(d[key][i]).toFixed(1);
      if ((n - 1) % stride) path += 'L' + X(d.t[n - 1]).toFixed(1) + ' ' + Y(d[key][n - 1]).toFixed(1);
      s('path', { class: 'gp-line gp-' + key, d: path }, g);
      const ly = Y(d[key][n - 1]);
      s('circle', { class: 'gp-dot gp-' + key, cx: X(d.t[n - 1]), cy: ly, r: 3.5 }, g);
    }
    // direct labels at the line ends, nudged apart so they never overlap
    const labels = keys.map((key) => ({ key, y: Y(d[key][n - 1]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    for (const l of labels) s('text', { class: 'gp-label', x: W - R + 8, y: l.y + 4 }, g).textContent = series.find((x) => x[0] === l.key)[1];
  }

  hit.addEventListener('pointermove', (ev) => {
    if (!last) return;
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const xMax = Math.max(100, last.xMax || last.t[last.t.length - 1] || 100);
    const t = Math.round(((px - L) / (W - L - R)) * xMax);
    let i = 0, lo = 0, hi = last.t.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (last.t[m] < t) lo = m + 1; else hi = m - 1; }
    i = Math.min(last.t.length - 1, Math.max(0, lo));
    const x = L + (last.t[i] / xMax) * (W - L - R);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    readout.textContent = `Step ${fmt(last.t[i])}: ` + series.filter((x) => x[0] !== 'wolf' || last.wolf[i]).map((x) => `${fmt(last[x[0]][i])} ${x[2] || x[1]}`).join(', ');
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); readout.textContent = ''; });
  draw();
  return draw;
}

/* ---------------------------------------------------------------- the live run */

const COLORS = {
  weak: [240, 176, 150], prey: [235, 104, 52], breeding: [160, 36, 10],
  wolf: [230, 194, 41],
};
/** An animal's colour is its diet, from orange (lives on grass) to yellow (lives on meat), as the other animals see it; paler when it is low on energy, darker when it can breed. */
function animalColour(o) {
  const d = Math.min(1, Math.max(0, o.diet));
  let c = [COLORS.prey[0] + (COLORS.wolf[0] - COLORS.prey[0]) * d, COLORS.prey[1] + (COLORS.wolf[1] - COLORS.prey[1]) * d, COLORS.prey[2] + (COLORS.wolf[2] - COLORS.prey[2]) * d];
  if (o.energy > 100) c = [c[0] * 0.65, c[1] * 0.65, c[2] * 0.65];
  else if (o.energy < 20) c = [c[0] + (255 - c[0]) * 0.5, c[1] + (255 - c[1]) * 0.5, c[2] + (255 - c[2]) * 0.5];
  return c;
}
const NIGHT = 0.7;   // how bright the picture stays at night (1 would be no change at all)
const WOLVES = 320;   // how many the button releases: the 20 of the old 100 x 100 map, for sixteen times the ground (the label is set from this)

async function init() {
  const canvas = $('gp-canvas');
  if (!canvas) return;
  const gpu = await createGpu();   // null when this browser has no WebGPU: everything then runs on the CPU, as before
  const ctx = canvas.getContext('2d');
  let img = null;
  const btnRun = $('gp-run'), btnStep = $('gp-step'), btnReset = $('gp-reset'), btnWolves = $('gp-wolves');
  const seedIn = $('gp-seed'), speedIn = $('gp-speed');
  const mating = $('gp-mating'), movesBody = $('gp-moves'), useGpu = $('gp-gpu');
  useGpu.checked = !!gpu; useGpu.disabled = !gpu;
  if (!gpu) useGpu.parentElement.title = 'This browser has no WebGPU, so the ground and the brains run on the CPU.';
  const movesCells = [];
  for (let r = 0; r < 3; r++) {
    const tr = h('tr');
    for (let c = 0; c < 3; c++) { const td = h('td'); movesCells.push(td); tr.append(td); }
    movesBody.append(tr);
  }
  const stat = $('gp-stat'), clock = $('gp-clock'), inspect = $('gp-inspect'), readout = $('gp-readout'), readoutGrass = $('gp-readout-grass'), layerIn = $('gp-layer');

  const brain = createBrainPanel($('gp-brain'));
  let world = null, running = false, redrawChart = null, redrawGrass = null, lastChart = 0, lastRate = { at: performance.now(), t: 0, sps: 0 };

  const mix = (dst, a, b, f) => { dst[0] = a[0] + (b[0] - a[0]) * f; dst[1] = a[1] + (b[1] - a[1]) * f; dst[2] = a[2] + (b[2] - a[2]) * f; };   // (dst may be a or b)
  const EARTH = LANDVIEW.earth, GREEN = LANDVIEW.green, WATER = LANDVIEW.water, SOIL_N = [176, 96, 28], PALE = [236, 236, 230], SNOW = LANDVIEW.snow, COLD = [59, 130, 196], WARM = [235, 104, 52];
  const shown = [0, 0, 0];

  /** The ground under cell i for the chosen layer, written into `col`: shaded relief with grass and ponds on it, or one layer on its own. */
  function ground(i, layer, L, col) {
    if (layer === 'land') { landRgb(L.elev[i], L.slope[i], L.grass[i], L.water[i], L.snow[i], col); return; }   // (the animals see this view: see World.look)
    const n = L.n, r = (i / n) | 0, c = i - r * n;
    const shade = 0.5 + 0.9 * (L.elev[i] - L.elev[Math.max(0, r - 1) * n + Math.max(0, c - 1)]);
    // the Height layer is lit from the north-west so the shape of the land reads; every other layer is lit by the sun where it really is
    const lit = layer === 'elevation' ? 0.2 * shade : 0.8 * L.slope[i];
    const relief = Math.max(0, Math.min(1.25, 0.55 + 0.05 * L.elev[i] + lit));
    col[0] = EARTH[0] * relief; col[1] = EARTH[1] * relief; col[2] = EARTH[2] * relief;
    if (layer === 'elevation') return;
    if (layer === 'grass') mix(col, EARTH, GREEN, Math.min(0.95, L.grass[i] / 4));
    if (layer === 'water') mix(col, PALE, WATER, Math.min(0.9, L.water[i] / 2.5));
    if (layer === 'nitrogen') mix(col, PALE, SOIL_N, Math.min(0.85, L.nitrogen[i] / 0.6));
    if (layer === 'temperature') {   // ground temperature: blue below freezing, pale at about 8 degrees, orange when warm
      const t = L.tempAt(i);
      if (t < 8) mix(col, PALE, COLD, Math.min(1, (8 - t) / 20)); else mix(col, PALE, WARM, Math.min(1, (t - 8) / 20));
    }
    if (layer === 'snow') mix(col, col, SNOW, Math.min(0.95, L.snow[i] / 0.8));
  }

  // The ground changes slowly and the animals every step, so the ground is repainted every few steps (or when the layer changes) and only the animals each frame.
  let groundData = null, groundAt = 0, groundWorld = null, groundLayer = '';
  function paint() {
    const d = img.data, L = world.land, layer = layerIn.value, n = world.n;
    if (groundWorld !== world || groundLayer !== layer || world.t - groundAt >= 6 || world.t < groundAt) {
      if (!groundData || groundData.length !== d.length) groundData = new Uint8ClampedArray(d.length);
      if (world.gpu) L.ensureLight(world.clim);   // (the card works out the light itself; the picture needs it here too)
      for (let i = 0, p = 0; i < n * n; i++, p += 4) {
        ground(i, layer, L, shown);
        groundData[p] = shown[0]; groundData[p + 1] = shown[1]; groundData[p + 2] = shown[2]; groundData[p + 3] = 255;
      }
      groundAt = world.t; groundWorld = world; groundLayer = layer;
    }
    d.set(groundData);
    for (const o of world.animals.values()) {
      const c = animalColour(o), p = (o.r * n + o.c) * 4;
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2];
    }
    ctx.putImageData(img, 0, 0);
    const o = brain.selected;
    if (o && world.at(o.r, o.c) === o) {   // ring the animal being watched
      ctx.lineWidth = 1.4; ctx.strokeStyle = '#000'; ctx.strokeRect(o.c - 1.5, o.r - 1.5, 4, 4);
      ctx.lineWidth = 0.7; ctx.strokeStyle = '#fff'; ctx.strokeRect(o.c - 1.5, o.r - 1.5, 4, 4);
    }
    brain.update(world);
  }

  function status() {
    const now = performance.now();
    if (now - lastRate.at > 700) {
      lastRate.sps = ((world.t - lastRate.t) * 1000) / (now - lastRate.at);
      lastRate.at = now; lastRate.t = world.t;
    }
    const total = world.moves.reduce((x, y) => x + y, 0);
    for (let k = 0; k < 9; k++) {
      const share = total ? world.moves[k] / total : 0;
      movesCells[k].textContent = total ? (share * 100).toFixed(0) + '%' : '';
      movesCells[k].style.backgroundColor = `rgba(${COLORS.prey[0]}, ${COLORS.prey[1]}, ${COLORS.prey[2]}, ${Math.min(0.85, share * 2.5)})`;
    }
    const gone = world.animals.size === 0 && world.t > 0;
    const w = world.when();
    canvas.style.filter = `brightness(${(NIGHT + (1 - NIGHT) * world.sun).toFixed(2)})`;   // the world darkens at night, but not to black
    stat.textContent =
      `Step ${fmt(world.t)} · ${fmt(world.nPrey)} prey` + (world.nWolf || world.hunted ? ` · ${fmt(world.nWolf)} wolves` : '') + ` · ${fmt(world.history.grass.at(-1))} grass` +
      (running ? ` · ${lastRate.sps.toFixed(0)} steps/s` : '');
    clock.textContent = `Year ${w.year}, day ${w.day}, ${String(Math.floor(w.hour)).padStart(2, '0')}:00 · ${w.season} · sunlight ${Math.round(world.sun * 100)}% · ${world.temp.toFixed(0)}°C` +
      (world.land.raining ? ' · raining' : '') + (gone ? ' · everyone is dead' : '');
  }

  let busy = false;   // a frame's steps are still being worked out (on the graphics card they finish a moment after they are asked for)
  /** The nitrogen picture needs the nitrogen, which the graphics card only hands over when asked. */
  async function pull(w) { if (w.gpu && layerIn.value === 'nitrogen') await w.gpu.syncNitrogen(); }

  async function frame() {
    if (!running || busy) return;
    busy = true;
    const w = world, budget = 14, start = performance.now(), per = +speedIn.value;
    try {
      for (let i = 0; i < per && performance.now() - start < budget; i++) await w.advance();
      await pull(w);
    } finally { busy = false; }
    if (w !== world) return;   // a new run began meanwhile
    paint(); status();
    const now = performance.now();
    if (now - lastChart > 250) { redrawChart(); redrawGrass(); lastChart = now; }
    if (world.animals.size === 0 && world.t > 0) { setRunning(false); redrawChart(); redrawGrass(); return; }
    if (running) requestAnimationFrame(frame);
  }

  function setRunning(on) {
    running = on;
    btnRun.textContent = on ? 'Pause' : world.t ? 'Resume' : 'Run';
    btnRun.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) { lastRate = { at: performance.now(), t: world.t, sps: 0 }; requestAnimationFrame(frame); }
    status();
  }

  function reset() {
    const seed = Math.max(0, Math.floor(+seedIn.value) || 0);
    brain.clear();
    world?.dispose();
    world = new World({ seed, mating: mating.checked, gpu: useGpu.checked ? gpu : null });
    canvas.width = canvas.height = world.n;
    img = ctx.createImageData(world.n, world.n);
    paint(); status();
    inspect.textContent = 'Click any animal to see its brain.';
    if (!redrawChart) {
      const data = () => ({ ...world.history, xMax: Math.max(500, world.t) });
      redrawChart = lineChart($('gp-chart'), readout, data, 'Prey and wolf population by step for the current run', [['prey', 'prey'], ['wolf', 'wolves']]);
      redrawGrass = lineChart($('gp-chart-grass'), readoutGrass, data, 'Total grass on the map by step for the current run', [['grass', 'grass', 'grass in all']]);
    } else { redrawChart(); redrawGrass(); }
    setRunning(false);
    btnRun.textContent = 'Run';
  }

  btnWolves.textContent = `Release ${WOLVES} wolves`;
  btnRun.addEventListener('click', () => {
    if (world.animals.size === 0 && world.t > 0) reset();
    setRunning(!running);
  });
  btnStep.addEventListener('click', async () => {
    setRunning(false);
    if (busy) return;
    busy = true;
    const w = world;
    try { await w.advance(); await pull(w); } finally { busy = false; }
    if (w !== world) return;
    paint(); brain.update(world, true); status(); redrawChart(); redrawGrass();
  });
  btnReset.addEventListener('click', reset);
  seedIn.addEventListener('change', reset);
  btnWolves.addEventListener('click', () => {
    world.releaseWolves(WOLVES);
    paint(); status(); redrawChart(); redrawGrass();
  });
  layerIn.addEventListener('change', async () => { await pull(world); paint(); });
  useGpu.addEventListener('change', reset);
  mating.addEventListener('change', () => { if (world) world.mating = mating.checked; });

  canvas.addEventListener('click', (ev) => {
    const box = canvas.getBoundingClientRect();
    const n = world.n;
    const c = Math.min(n - 1, Math.max(0, Math.floor(((ev.clientX - box.left) / box.width) * n)));
    const r = Math.min(n - 1, Math.max(0, Math.floor(((ev.clientY - box.top) / box.height) * n)));
    const o = world.at(r, c);
    if (o) { brain.show(world, o); paint(); }
  });

  reset();
}

init();
