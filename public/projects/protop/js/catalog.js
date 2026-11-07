// ProTop catalog: knotted proteins from a snapshot of AlphaKnot and KnotProt, served by GET /catalog.
// The table is the primary view: real <table>, sortable headers that are buttons, paging, a count and a CSV link.
// The state lives in the URL (?q=&knot=&source=&sort=&order=&page=&per_page=) so a view can be shared.

import { h, $, clear, fmt, flat, knotLabel } from './dom.js';
import { get, isAbort, msgOf, BASE } from './api.js';

const form = $('cat-form'), qIn = $('f-q'), knotSel = $('f-knot'), srcSel = $('f-source'), perSel = $('f-per');
const table = $('cat-table'), thead = table.tHead, tbody = table.tBodies[0];
const countEl = $('cat-count'), csv = $('cat-csv'), pager = $('cat-pager'), snap = $('cat-snapshot');

// Row fields are the old Mongo documents' camelCase names (knotcat.py); a column shows only if some row has it.
const COLS = [
  { id: 'uniprotId', label: 'UniProt', link: true },
  { id: 'pdbId', label: 'PDB', link: true },
  { id: 'chain', label: 'Chain' },
  { id: 'knotType', label: 'Knot type', fmt: knotLabel },
  { id: 'knotCoreLength', label: 'Knot core length', num: true },
  { id: 'proteinName', label: 'Protein' },
  { id: 'organism', label: 'Organism' },
  { id: 'diseases', label: 'Diseases' },
  { id: 'source', label: 'Source', fmt: (v) => ({ alphaknot: 'AlphaKnot', knotprot: 'KnotProt' })[String(v).toLowerCase()] || v },
];
const known = new Set(['uniprotId', 'pdbId', 'knotType', 'knotCoreLength']); // always shown; others once seen
const DEFAULTS = { q: '', knot: '', source: '', sort: '', order: 'asc', page: 1, per_page: 25 };

let state = readUrl();
let ctl = null;
let lastTotal = 0;

function readUrl() {
  const p = new URLSearchParams(location.search);
  const s = { ...DEFAULTS };
  for (const k of ['q', 'knot', 'source', 'sort']) s[k] = (p.get(k) || '').slice(0, 60);
  s.order = p.get('order') === 'desc' ? 'desc' : 'asc';
  s.page = Math.max(1, parseInt(p.get('page'), 10) || 1);
  const pp = parseInt(p.get('per_page'), 10);
  s.per_page = [25, 50, 100].includes(pp) ? pp : 25;
  return s;
}

function query(s, { paged = true } = {}) {
  const p = new URLSearchParams();
  for (const k of ['q', 'knot', 'source', 'sort']) if (s[k]) p.set(k, s[k]);
  if (s.sort) p.set('order', s.order);
  if (paged) { p.set('page', s.page); p.set('per_page', s.per_page); }
  return p;
}

function syncForm() {
  qIn.value = state.q;
  perSel.value = String(state.per_page);
  ensureOption(knotSel, state.knot);
  ensureOption(srcSel, state.source);
}
function ensureOption(sel, v) {
  if (v && ![...sel.options].some((o) => o.value === v)) sel.append(h('option', { value: v, text: v }));
  sel.value = v;
}

function go(next, { push = true } = {}) {
  state = { ...state, ...next };
  if (push) {
    const p = query(state);
    for (const [k, v] of [...p]) if (DEFAULTS[k] !== undefined && String(DEFAULTS[k]) === v) p.delete(k);
    const qs = p.toString();
    history.pushState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }
  load();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  go({ q: qIn.value.trim(), knot: knotSel.value, source: srcSel.value, per_page: +perSel.value, page: 1 });
});
for (const el of [knotSel, srcSel, perSel]) el.addEventListener('change', () => form.requestSubmit());
addEventListener('popstate', () => { state = readUrl(); syncForm(); load(); });

// ------------------------------------------------------------------ loading ---

async function load() {
  if (ctl) ctl.abort();
  ctl = new AbortController();
  const mine = ctl;
  tbody.classList.add('loading');
  table.setAttribute('aria-busy', 'true');
  if (!tbody.rows.length) countEl.textContent = 'Loading the catalog…';
  csv.href = `${BASE}/catalog.csv` + (query(state, { paged: false }).toString() ? '?' + query(state, { paged: false }) : '');
  try {
    const d = await get('/catalog?' + query(state), { signal: mine.signal, timeout: 30000 });
    render(d);
  } catch (e) {
    if (isAbort(e)) return;
    tbody.classList.remove('loading');
    table.removeAttribute('aria-busy');
    countEl.replaceChildren(h('span', { class: 'error', text: msgOf(e) + ' ' }), h('button', { type: 'button', class: 'linkish', text: 'Try again', onclick: load }));
  }
}

const field = (row, col) => {
  for (const k of [col.id, ...(col.alt || [])]) {
    const v = row[k] ?? (row.alphaknot && row.alphaknot[k]) ?? (row.knotprot && row.knotprot[k]);
    if (v !== undefined && v !== null && flat(v) !== '') return v;
  }
  if (col.id === 'source') return row.alphaknot ? 'alphaknot' : row.knotprot ? 'knotprot' : '';
  return '';
};

function render(d) {
  const rows = Array.isArray(d.rows) ? d.rows : [];
  lastTotal = d.total || 0;
  for (const r of rows) for (const c of COLS) if (field(r, c) !== '') known.add(c.id);
  const cols = COLS.filter((c) => known.has(c.id));

  // each facet ignores its own filter, so the selects always offer the alternatives
  fillFacet(knotSel, d.facets && d.facets.knot_types, 'All', knotLabel);
  fillFacet(srcSel, d.facets && d.facets.sources, 'Both', (v) => ({ alphaknot: 'AlphaKnot', knotprot: 'KnotProt' })[v] || v);
  syncForm();

  clear(thead);
  thead.append(h('tr', {}, cols.map((c) => {
    const active = state.sort === c.id;
    const th = h('th', { scope: 'col', class: c.num ? 'num' : '', 'aria-sort': active ? (state.order === 'desc' ? 'descending' : 'ascending') : 'none' },
      h('button', { type: 'button', onclick: () => go({ sort: c.id, order: active && state.order === 'asc' ? 'desc' : 'asc', page: 1 }) },
        c.label, h('span', { 'aria-hidden': 'true', text: active ? (state.order === 'desc' ? '▼' : '▲') : '⇅' })));
    return th;
  })));

  clear(tbody);
  for (const r of rows) {
    tbody.append(h('tr', {}, cols.map((c) => {
      const v = field(r, c);
      const text = v === '' ? '' : c.fmt ? c.fmt(flat(v)) : flat(v);
      const td = h('td', { class: c.num ? 'num' : '' });
      if (c.link && text) td.append(h('a', { href: `/projects/protop/search/?q=${encodeURIComponent(text)}`, text }));
      else td.textContent = text || '–';
      return td;
    })));
  }
  if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: cols.length || 1, class: 'muted', text: 'No proteins match these filters.' })));
  tbody.classList.remove('loading');
  table.removeAttribute('aria-busy');

  const total = d.total || 0, per = d.per_page || state.per_page, page = d.page || state.page;
  const first = total ? (page - 1) * per + 1 : 0, last = Math.min(total, page * per);
  const filtered = state.q || state.knot || state.source;
  countEl.textContent = total
    ? `${fmt(total)} ${total === 1 ? 'protein' : 'proteins'}${filtered ? ' match' : ''}. Showing ${fmt(first)}–${fmt(last)}.`
    : 'No proteins match these filters.';

  const pages = Math.max(1, Math.ceil(total / per));
  clear(pager);
  if (pages > 1) {
    const b = (label, to, disabled, aria) => h('button', { type: 'button', text: label, 'aria-label': aria || null, disabled: disabled ? 'disabled' : null, onclick: () => { go({ page: to }); table.scrollIntoView({ block: 'start' }); } });
    pager.append(b('« First', 1, page <= 1, 'First page'), b('‹ Previous', page - 1, page <= 1, 'Previous page'),
      h('span', { class: 'where', text: `Page ${fmt(page)} of ${fmt(pages)}` }),
      b('Next ›', page + 1, page >= pages, 'Next page'), b('Last »', pages, page >= pages, 'Last page'));
  }

  const s = d.snapshot || {};
  snap.textContent = s.date
    ? [`Snapshot taken ${String(s.date).slice(0, 10)}${s.total ? ` (${fmt(s.total)} rows in all)` : ''}.`, s.note, Array.isArray(s.sources) && s.sources.length ? 'Sources: ' + s.sources.join('; ') + '.' : '', 'The databases may have changed since.'].filter(Boolean).join(' ')
    : '';
}

function fillFacet(sel, items, allLabel, fmtName) {
  if (!Array.isArray(items)) return;
  const keep = sel.value;
  clear(sel);
  sel.append(h('option', { value: '', text: allLabel }));
  for (const it of items) sel.append(h('option', { value: it.name, text: `${fmtName(String(it.name))} (${fmt(it.count)})` }));
  if (keep && !items.some((it) => String(it.name) === keep)) sel.append(h('option', { value: keep, text: fmtName(keep) }));
  sel.value = keep;
}

syncForm();
load();
