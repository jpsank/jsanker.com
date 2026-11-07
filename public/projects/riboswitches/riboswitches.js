// Riboswitches: charts for the breaker-lab write-up. Plain SVG, no libraries.
// All numbers come from data.json (built from the search tables in github.com/jpsank/breaker).
(() => {
  'use strict';
  const node = document.getElementById('rs-data');
  if (!node) return;
  const data = JSON.parse(node.textContent);
  const SVG = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString('en-US');
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');
  const NAMES = { nha: 'nhaA-I', duf: 'DUF1646', comb: 'Combined (CMfinder)', lina: 'LiNa' };

  function s(tag, attrs, parent) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, props, parent) {
    const e = document.createElement(tag);
    for (const k in props) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'class') e.className = props[k];
      else e.setAttribute(k, props[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  const sup = (n) => String(n).replace(/-/g, '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
  const eTick = (v) => (v === 0 ? '1' : v > 0 ? String(10 ** v) : '10' + sup(v));
  const eVal = (v) => {
    const x = 10 ** v;
    return x >= 0.001 ? String(+x.toPrecision(2)) : x.toExponential(0).replace('e', '×10^');
  };
  const nice = (m) => { const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  function bar(x, y, w, hgt, r) { // horizontal bar: square at the baseline, rounded data end
    if (w <= 0) return '';
    r = Math.min(r, w, hgt / 2);
    return `M${x} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${hgt - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - r)}z`;
  }

  // tooltip: one shared element; text only ever goes in through textContent
  const tip = h('div', { class: 'rs-tip', role: 'presentation' }, document.body);
  function showTip(x, y, title, rows) {
    tip.replaceChildren();
    if (title) h('div', { class: 'tt', text: title }, tip);
    for (const r of rows) {
      const row = h('div', { class: 'row' }, tip);
      if (r.key) h('span', { class: 'key k-' + r.key }, row);
      h('span', { class: 'v', text: r.value }, row);
      h('span', { text: r.name }, row);
    }
    tip.style.display = 'block';
    const w = tip.offsetWidth, hh = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(x + 14, innerWidth - w - 4)) + 'px';
    tip.style.top = Math.max(4, Math.min(y + 14, innerHeight - hh - 4)) + 'px';
  }
  const hideTip = () => { tip.style.display = 'none'; };
  const atElement = (el, title, rows) => { const b = el.getBoundingClientRect(); showTip(b.left + b.width / 2, b.top + b.height / 2, title, rows); };

  // redraw a chart when its container changes width, so text stays a readable size on phones
  function responsive(el, draw) {
    let w = 0;
    const run = () => { const nw = Math.round(el.clientWidth); if (nw && nw !== w) { w = nw; draw(nw); } };
    run();
    if ('ResizeObserver' in window) new ResizeObserver(run).observe(el);
    else addEventListener('resize', run);
  }

  // 1. funnel table with in-cell bars --------------------------------------------------------
  function funnel() {
    const root = $('funnel'); if (!root) return;
    const cols = [['total', 'All hits'], ['unique', 'Unique'], ['e1', 'E < 1'], ['unique_e1', 'Unique and E < 1']];
    const max = Math.max(...Object.values(data.counts).map((c) => c.total));
    const t = h('table', { class: 'funnel' }, root);
    const hr = h('tr', {}, h('thead', {}, t));
    h('th', { class: 'model', text: 'Search' }, hr);
    for (const [, label] of cols) h('th', { text: label }, hr);
    const body = h('tbody', {}, t);
    for (const m of ['nha', 'duf', 'comb', 'lina']) {
      const tr = h('tr', {}, body);
      const th = h('td', { class: 'model' }, tr);
      h('span', { class: 'swatch sw-' + m }, th);
      th.append(' ' + NAMES[m]);
      for (const [k, label] of cols) {
        const v = data.counts[m][k];
        const td = h('td', { class: 'cell' }, tr);
        h('span', { class: 'num', text: fmt(v) }, td);
        const b = h('span', { class: 'bar c-' + m }, td);
        b.style.width = Math.max(1, (100 * v) / max) + '%';
        td.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, NAMES[m], [{ key: m, value: fmt(v), name: label.toLowerCase() }]));
        td.addEventListener('pointerleave', hideTip);
      }
    }
  }

  // 2. E-value explorer ------------------------------------------------------------------------
  function explorer() {
    const plot = $('hist-plot'); if (!plot) return;
    const sel = $('hist-model'), thr = $('hist-thr'), out = $('hist-out');
    const X0 = -9, X1 = 3, H = 230, M = { l: 38, r: 8, t: 8, b: 34 };
    let W = 0;

    const cum = (m, t) => {
      const hd = data.hist[m]; let c = 0;
      hd.unique.forEach((n, i) => { if (hd.lo + 0.1 * (i + 1) <= t + 1e-9) c += n; });
      return c;
    };
    function readout() {
      const m = sel.value, t = +thr.value, n = cum(m, t), tot = data.counts[m].unique;
      out.replaceChildren();
      h('strong', { text: fmt(n) }, out);
      out.append(` of ${fmt(tot)} unique hits have E < ${eVal(t)} (${pct(n, tot)})`);
    }
    function draw(width) {
      W = width;
      plot.replaceChildren();
      const m = sel.value, t = +thr.value, hd = data.hist[m];
      const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Histogram of E-values for unique hits from the ${NAMES[m]} search. A slider sets the cutoff; the table below lists the same counts.` }, plot);
      const pw = W - M.l - M.r, ph = H - M.t - M.b;
      const X = (v) => M.l + ((v - X0) / (X1 - X0)) * pw;
      const ymax = nice(Math.max(...hd.unique, 1));
      const Y = (v) => M.t + ph - (v / ymax) * ph;
      for (const v of [0, ymax / 2, ymax]) {
        s('line', { class: 'grid', x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v) }, svg);
        s('text', { class: 'tick', x: M.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(v);
      }
      hd.unique.forEach((n, i) => {
        if (!n) return;
        const a = hd.lo + 0.1 * i, x = X(a), w = Math.max(1, X(a + 0.1) - x - 1);
        s('rect', { class: a + 0.1 <= t + 1e-9 ? 'c-' + m : 'c-off', x, y: Y(n), width: w, height: Y(0) - Y(n) }, svg);
      });
      s('line', { class: 'axis', x1: M.l, x2: W - M.r, y1: Y(0), y2: Y(0) }, svg);
      for (const v of [-8, -6, -4, -2, 0, 2]) {
        s('text', { class: 'tick', x: X(v), y: Y(0) + 15, 'text-anchor': 'middle' }, svg).textContent = eTick(v);
      }
      s('text', { class: 'axis-title', x: M.l + pw / 2, y: H - 4, 'text-anchor': 'middle' }, svg).textContent = 'E-value, log scale (lower is a better match)';
      s('line', { class: 'marker', x1: X(t), x2: X(t), y1: M.t, y2: Y(0) }, svg);
      const lab = s('text', { class: 'marker-label', x: X(t) + (X(t) > W - 90 ? -4 : 4), y: M.t + 10, 'text-anchor': X(t) > W - 90 ? 'end' : 'start' }, svg);
      lab.textContent = 'E < ' + eVal(t);
      // one hit area over the whole plot: nearest bin wins, so the pointer never has to land on a 4px bar
      const hit = s('rect', { class: 'hit', x: M.l, y: M.t, width: pw, height: ph }, svg);
      hit.addEventListener('pointermove', (ev) => {
        const r = svg.getBoundingClientRect(), v = X0 + ((ev.clientX - r.left - M.l) / pw) * (X1 - X0);
        const i = Math.floor((v - hd.lo) / 0.1);
        if (i < 0 || i >= hd.unique.length) return hideTip();
        const a = hd.lo + 0.1 * i;
        showTip(ev.clientX, ev.clientY, `E from ${eVal(a)} to ${eVal(a + 0.1)}`, [{ key: m, value: fmt(hd.unique[i]), name: 'unique hits' }]);
      });
      hit.addEventListener('pointerleave', hideTip);
    }
    const redraw = () => { readout(); draw(W || plot.clientWidth); };
    sel.addEventListener('change', redraw);
    thr.addEventListener('input', redraw);
    $('hist-reset').addEventListener('click', () => { thr.value = 0; redraw(); });
    readout();
    responsive(plot, (w) => { W = w; redraw(); });

    // table view of the same numbers
    const tv = $('hist-table');
    if (tv) {
      const ts = [-5, -3, -2, 0, 1, 2, 3];
      const t = h('table', {}, tv), hr = h('tr', {}, h('thead', {}, t));
      h('th', { text: 'Unique hits with E <' }, hr);
      for (const m of ['nha', 'duf', 'comb', 'lina']) h('th', { text: NAMES[m] }, hr);
      const b = h('tbody', {}, t);
      for (const v of ts) {
        const tr = h('tr', {}, b);
        h('td', { text: eVal(v) }, tr);
        for (const m of ['nha', 'duf', 'comb', 'lina']) h('td', { class: 'n', text: fmt(cum(m, v)) }, tr);
      }
    }
  }

  // 3. does the merged model recover both motifs? --------------------------------------------------
  function recall() {
    for (const m of ['comb', 'lina']) {
      const plot = $('recall-' + m); if (!plot) continue;
      const rows = data.compare[m];
      const dufN = rows[0].duf_found + rows[0].duf_missed, nhaN = rows[0].nha_found + rows[0].nha_missed;
      const RH = 34, T = 18, B = 22, LABEL = 62, RIGHT = 54;
      const draw = (W) => {
        plot.replaceChildren();
        const H = T + rows.length * RH + B, bw = W - LABEL - RIGHT - 34;
        const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `For each E-value cutoff, the share of the single-motif hits that the ${NAMES[m]} model recovers. The table below lists the same numbers.` }, plot);
        for (const f of [0, 0.5, 1]) {
          const x = LABEL + f * bw;
          s('line', { class: 'grid', x1: x, x2: x, y1: T - 4, y2: T + rows.length * RH }, svg);
          s('text', { class: 'tick', x, y: H - 6, 'text-anchor': f === 1 ? 'end' : f === 0 ? 'start' : 'middle' }, svg).textContent = Math.round(f * 100) + '%';
        }
        s('text', { class: 'tick', x: W - 2, y: T - 6, 'text-anchor': 'end' }, svg).textContent = 'new hits';
        rows.forEach((r, i) => {
          const y = T + i * RH;
          const g = s('g', { class: 'row', tabindex: 0, role: 'group', 'aria-label': `E < ${r.e}: ${fmt(r.nha_found)} of ${fmt(nhaN)} nhaA-I hits, ${fmt(r.duf_found)} of ${fmt(dufN)} DUF1646 hits, ${fmt(r.novel)} new hits` }, svg);
          s('rect', { class: 'wash', x: 0, y, width: W, height: RH }, g);
          s('text', { x: 0, y: y + 21, 'text-anchor': 'start' }, g).textContent = 'E < ' + r.e;
          for (const [k, found, total, off] of [['nha', r.nha_found, nhaN, 6], ['duf', r.duf_found, dufN, 18]]) {
            const w = (found / total) * bw;
            if (w > 0) s('path', { class: 'c-' + k, d: bar(LABEL, y + off, w, 10, 4) }, g);
            if (i === 0 || i === rows.length - 1) {
              s('text', { x: LABEL + w + 5, y: y + off + 9, 'text-anchor': 'start' }, g).textContent = pct(found, total);
            }
          }
          s('text', { x: W - 2, y: y + 21, 'text-anchor': 'end' }, g).textContent = '+' + fmt(r.novel);
          s('line', { class: 'grid', x1: 0, x2: W, y1: y + RH, y2: y + RH }, g);
          const rowsTip = [
            { key: 'nha', value: `${fmt(r.nha_found)} of ${fmt(nhaN)}`, name: `nhaA-I hits (${pct(r.nha_found, nhaN)})` },
            { key: 'duf', value: `${fmt(r.duf_found)} of ${fmt(dufN)}`, name: `DUF1646 hits (${pct(r.duf_found, dufN)})` },
            { value: fmt(r.novel), name: 'hits that neither single-motif search found' },
          ];
          g.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, `${NAMES[m]}, E < ${r.e}`, rowsTip));
          g.addEventListener('pointerleave', hideTip);
          g.addEventListener('focus', () => atElement(g, `${NAMES[m]}, E < ${r.e}`, rowsTip));
          g.addEventListener('blur', hideTip);
        });
      };
      responsive(plot, draw);

      const last = rows[rows.length - 1], first = rows[0];
      const note = $('recall-note-' + m);
      if (note) note.textContent = `At E < 1 it recovers ${fmt(last.duf_found)} of ${fmt(dufN)} DUF1646 hits and ${fmt(last.nha_found)} of ${fmt(nhaN)} nhaA-I hits. Loosening the cutoff to E < ${first.e} gets to ${fmt(first.duf_found)} and ${fmt(first.nha_found)}.`;
      const tv = $('recall-table-' + m);
      if (tv) {
        const t = h('table', {}, tv), hr = h('tr', {}, h('thead', {}, t));
        for (const c of ['E <', 'nhaA-I found', 'nhaA-I missed', 'DUF1646 found', 'DUF1646 missed', 'New hits']) h('th', { text: c }, hr);
        const b = h('tbody', {}, t);
        for (const r of rows) {
          const tr = h('tr', {}, b);
          for (const v of [r.e, r.nha_found, r.nha_missed, r.duf_found, r.duf_missed, r.novel]) h('td', { class: 'n', text: fmt(v) }, tr);
        }
      }
    }
  }

  // 4. the journey: one dot per commit ---------------------------------------------------------------
  function journey() {
    const plot = $('commits-plot'); if (!plot) return;
    const day = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
    const commits = data.commits.map((c) => ({ ...c, n: day(c.d) }));
    const PHASES = [['2023-02-26', '2023-03-06'], ['2023-03-09', '2023-03-13'], ['2023-04-06', '2023-04-09'], ['2023-04-23', '2023-04-23'], ['2023-05-02', '2023-05-04']];
    const d0 = commits[0].n, d1 = commits[commits.length - 1].n;
    const perDay = {}; commits.forEach((c) => { c.k = perDay[c.n] = (perDay[c.n] ?? -1) + 1; });
    const maxStack = Math.max(...Object.values(perDay)) + 1;
    PHASES.forEach(([a, b], i) => {
      const el = document.querySelector(`[data-phase="${i + 1}"]`);
      if (el) el.textContent = commits.filter((c) => c.d >= a && c.d <= b).length + ' commits';
    });
    const draw = (W) => {
      plot.replaceChildren();
      const P = 12, STEP = 10, T = 22, base = T + maxStack * STEP + 8, H = base + 26;
      const X = (n) => P + ((n - d0) / (d1 - d0)) * (W - 2 * P);
      const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Timeline of the ${commits.length} commits, one dot each, from ${commits[0].d} to ${commits[commits.length - 1].d}. The full list follows the chart.` }, plot);
      PHASES.forEach(([a, b], i) => {
        const x0 = X(day(a)) - 8, x1 = X(day(b)) + 8;
        s('rect', { class: 'c-band', x: x0, y: T - 8, width: x1 - x0, height: base - T + 8 }, svg);
        s('text', { x: (x0 + x1) / 2, y: T - 12, 'text-anchor': 'middle' }, svg).textContent = String(i + 1);
      });
      s('line', { class: 'axis', x1: P, x2: W - P, y1: base, y2: base }, svg);
      for (const [label, d] of [['Mar 1', '2023-03-01'], ['Apr 1', '2023-04-01'], ['May 1', '2023-05-01']]) {
        s('text', { class: 'tick', x: X(day(d)), y: base + 16, 'text-anchor': 'middle' }, svg).textContent = label;
        s('line', { class: 'axis', x1: X(day(d)), x2: X(day(d)), y1: base, y2: base + 4 }, svg);
      }
      for (const c of commits) {
        const cx = X(c.n), cy = base - 8 - c.k * STEP;
        s('circle', { class: 'c-dot ring', cx, cy, r: 4 }, svg);
        const hit = s('circle', { class: 'hit', cx, cy, r: 6 }, svg);
        hit.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, c.d, [{ value: c.s, name: '' }]));
        hit.addEventListener('pointerleave', hideTip);
      }
    };
    responsive(plot, draw);
    const list = $('commit-list');
    if (list) for (const c of commits) { const li = h('li', {}, list); h('span', { class: 'muted', text: c.d + ' ' }, li); li.append(c.s); }
  }

  funnel(); explorer(); recall(); journey();
})();
