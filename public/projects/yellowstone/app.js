// Yellowstone: the page. The simulation itself is in sim.js; nothing here talks to a server.
import { World } from './sim.js';
import { createBrainPanel } from './brain.js';

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
const WOLVES = 80;   // how many the button releases: the 20 of the old 100 x 100 map, for four times the ground (the label is set from this)

function init() {
  const canvas = $('gp-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let img = null;
  const btnRun = $('gp-run'), btnStep = $('gp-step'), btnReset = $('gp-reset'), btnWolves = $('gp-wolves');
  const seedIn = $('gp-seed'), speedIn = $('gp-speed');
  const mating = $('gp-mating'), movesBody = $('gp-moves');
  const movesCells = [];
  for (let r = 0; r < 3; r++) {
    const tr = h('tr');
    for (let c = 0; c < 3; c++) { const td = h('td'); movesCells.push(td); tr.append(td); }
    movesBody.append(tr);
  }
  const stat = $('gp-stat'), clock = $('gp-clock'), inspect = $('gp-inspect'), readout = $('gp-readout'), readoutGrass = $('gp-readout-grass'), layerIn = $('gp-layer');

  const brain = createBrainPanel($('gp-brain'));
  let world = null, running = false, redrawChart = null, redrawGrass = null, lastChart = 0, lastRate = { at: performance.now(), t: 0, sps: 0 };

  const mix = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  const EARTH = [222, 212, 186], GREEN = [52, 152, 84], WATER = [48, 112, 214], SOIL_N = [176, 96, 28];

  /** The ground under cell i for the chosen layer: shaded relief with grass and ponds on it, or one layer on its own. */
  function ground(i, layer, L) {
    const n = L.n, r = (i / n) | 0, c = i - r * n;
    const shade = 0.5 + 0.9 * (L.elev[i] - L.elev[Math.max(0, r - 1) * n + ((c + n - 1) % n)]);
    // the Height layer is lit from the north-west so the shape of the land reads; every other layer is lit by the sun where it really is
    const lit = layer === 'elevation' ? 0.2 * shade : 0.8 * (L.light[i] - L.flat[r]);
    const relief = Math.max(0, Math.min(1.25, 0.55 + 0.05 * L.elev[i] + lit));
    let col = [EARTH[0] * relief, EARTH[1] * relief, EARTH[2] * relief];
    if (layer === 'elevation') return col;
    if (layer === 'grass' || layer === 'land') col = mix(layer === 'grass' ? EARTH : col, GREEN, Math.min(0.95, L.grass[i] / 4));
    if (layer === 'water' || layer === 'land') col = mix(layer === 'water' ? [236, 236, 230] : col, WATER, Math.min(layer === 'water' ? 0.9 : 0.8, L.water[i] / (layer === 'water' ? 2.5 : 1.8)));
    if (layer === 'nitrogen') col = mix([236, 236, 230], SOIL_N, Math.min(0.85, L.nitrogen[i] / 0.6));
    if (layer === 'temperature') {   // ground temperature: blue below freezing, pale at about 8 degrees, orange when warm
      const t = L.tempAt(i);
      col = t < 8 ? mix([236, 236, 230], [59, 130, 196], Math.min(1, (8 - t) / 20)) : mix([236, 236, 230], [235, 104, 52], Math.min(1, (t - 8) / 20));
    }
    if (layer === 'snow') col = mix(col, [250, 252, 255], Math.min(0.95, L.snow[i] / 0.8));
    if (layer === 'land') col = mix(col, [250, 252, 255], Math.min(0.9, L.snow[i] / 0.8));   // snow lies over everything
    return col;
  }

  function paint() {
    const d = img.data, grid = world.grid, L = world.land, layer = layerIn.value;
    for (let i = 0; i < grid.length; i++) {
      const o = grid[i], p = i * 4;
      let c;
      if (!o) c = ground(i, layer, L);
      else c = animalColour(o);
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
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
    canvas.style.filter = `brightness(${(0.4 + 0.6 * world.sun).toFixed(2)})`;   // the world darkens at night
    stat.textContent =
      `Step ${fmt(world.t)} · ${fmt(world.nPrey)} prey` + (world.nWolf || world.hunted ? ` · ${fmt(world.nWolf)} wolves` : '') + ` · ${fmt(world.history.grass.at(-1))} grass` +
      (running ? ` · ${lastRate.sps.toFixed(0)} steps/s` : '');
    clock.textContent = `Year ${w.year}, day ${w.day}, ${String(Math.floor(w.hour)).padStart(2, '0')}:00 · ${w.season} · sunlight ${Math.round(world.sun * 100)}% · ${world.temp.toFixed(0)}°C` +
      (world.land.raining ? ' · raining' : '') + (gone ? ' · everyone is dead' : '');
  }

  function frame() {
    if (!running) return;
    const budget = 14, start = performance.now(), per = +speedIn.value;
    for (let i = 0; i < per && performance.now() - start < budget; i++) world.step();
    paint(); status();
    const now = performance.now();
    if (now - lastChart > 250) { redrawChart(); redrawGrass(); lastChart = now; }
    if (world.animals.size === 0 && world.t > 0) { setRunning(false); redrawChart(); redrawGrass(); return; }
    requestAnimationFrame(frame);
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
    world = new World({ seed, mating: mating.checked });
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
  btnStep.addEventListener('click', () => {
    setRunning(false);
    world.step(); paint(); brain.update(world, true); status(); redrawChart(); redrawGrass();
  });
  btnReset.addEventListener('click', reset);
  seedIn.addEventListener('change', reset);
  btnWolves.addEventListener('click', () => {
    world.releaseWolves(WOLVES);
    paint(); status(); redrawChart(); redrawGrass();
  });
  layerIn.addEventListener('change', paint);
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
