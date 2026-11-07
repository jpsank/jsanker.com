// ProTop search: a PDB ID or a UniProt accession in, summaries from RCSB, UniProt, AlphaKnot and KnotProt plus a
// 3D view out. The browser only ever talks to /projects/protop/api, which asks the databases on our behalf.
// The response shapes are those of the old Render backend (see protop-app/API.md), so the field handling follows
// the 2023 Search page, made defensive: any value may be missing, a list, or an error object.

import { h, $, clear, fmt, flat, knotLabel } from './dom.js';
import { get, post, isAbort, msgOf, ApiError, BASE, WORKSPACE_URL } from './api.js';
import { Viewer } from './viewer.js';
import { rememberRoom } from './room.js';

const PDB_RE = /^[0-9][A-Za-z0-9]{3}$/;
const UNIPROT_RE = /^[A-Za-z0-9_-]{4,20}$/;
const form = $('search-form'), input = $('q'), result = $('result');
const SELF = '/projects/protop/search/';
let run = null; // {ctl, viewer}

const searchLink = (id) => h('a', { href: `${SELF}?q=${encodeURIComponent(id)}`, text: id });

// ------------------------------------------------------------------ routing ---

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  history.pushState(null, '', `${SELF}?q=${encodeURIComponent(q)}`);
  go(q);
});
addEventListener('popstate', () => go(new URLSearchParams(location.search).get('q') || ''));
{
  const q = new URLSearchParams(location.search).get('q');
  if (q) go(q);
}

function go(raw) {
  if (run) { run.ctl.abort(); if (run.viewer) run.viewer.dispose(); }
  run = null;
  clear(result);
  const q = raw.trim();
  input.value = q;
  if (!q) return;
  if (!PDB_RE.test(q) && !UNIPROT_RE.test(q)) {
    result.append(h('p', { class: 'error', role: 'alert', text: 'That does not look like a PDB ID (four characters, like 1R42) or a UniProt accession (like P01308).' }));
    return;
  }
  run = { ctl: new AbortController(), viewer: null };
  document.title = `${q.toUpperCase()} — Search — ProTop`;
  if (PDB_RE.test(q)) pdbSearch(q, run);
  else uniprotSearch(q, run);
}

// ------------------------------------------------------------ section frames ---

/** A card that shows a spinner, then whatever fill() puts in it, or a calm error. */
function slot(title, parent) {
  const card = h('section', { class: 'card', 'aria-busy': 'true' }, h('h2', { text: title }));
  const body = h('div', {});
  card.append(body);
  parent.append(card);
  return {
    card,
    loading(text) { clear(body); body.append(h('p', { class: 'still' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text)); },
    set(...kids) { clear(body); body.append(...kids.filter(Boolean)); card.removeAttribute('aria-busy'); },
    note(text) { this.set(h('p', { class: 'muted', text })); },
    fail(text) { this.set(h('p', { class: 'error', role: 'alert', text })); },
    remove() { card.remove(); },
  };
}

/** Run a request into a slot with a "still waiting" message if it is slow (UniProt can take 15 s). */
async function fetchInto(s, ctx, path, { what, slowMs = 5000 } = {}) {
  s.loading(`Asking ${what}…`);
  const timer = setTimeout(() => s.loading(`Still waiting for ${what}. It can take up to 15 seconds when it is busy; nothing is wrong.`), slowMs);
  try {
    const data = await get(path, { signal: ctx.ctl.signal, timeout: 50000 });
    return data;
  } catch (e) {
    if (isAbort(e)) return undefined;
    s.fail(e instanceof ApiError && (e.status === 404 || e.status === 400) ? msgOf(e) : `${what} did not answer: ${msgOf(e)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const hasError = (d) => d && typeof d === 'object' && !Array.isArray(d) && typeof d.error === 'string';

// ---------------------------------------------------------------- PDB search ---

async function pdbSearch(id, ctx) {
  const ID = id.toUpperCase();
  const wrap = h('div', { class: 'cards search-view' });
  result.append(wrap);

  const sumSlot = slot(`PDB entry ${ID}`, wrap);
  const viewSlot = h('section', { class: 'card', 'aria-label': `3D structure of ${ID}` });
  wrap.append(viewSlot);
  const knotSlot = slot('KnotProt', wrap);
  const uniHolder = h('div', { class: 'cards' });
  wrap.append(uniHolder);

  buildViewer(ID, viewSlot, ctx);

  fetchInto(knotSlot, ctx, `/knotprot/${encodeURIComponent(id)}`, { what: 'KnotProt' }).then((d) => {
    if (d === undefined) return;
    renderKnotprot(knotSlot, d, id);
  });

  const d = await fetchInto(sumSlot, ctx, `/pdb/${encodeURIComponent(id)}`, { what: 'RCSB PDB' });
  if (d === undefined) return;
  if (hasError(d)) { sumSlot.fail(d.error); return; }
  const entry = d[id] || d[ID] || d[id.toLowerCase()] || Object.values(d)[0];
  if (!entry || hasError(entry)) { sumSlot.note(entry && entry.error ? entry.error : 'RCSB has no entry with this ID.'); return; }
  renderPdb(sumSlot, entry, ID);

  const ids = [...new Set([...(entry.uniprot_ids || []), ...(entry.entities || []).flatMap((x) => x.uniprot_ids || [])])].filter((u) => UNIPROT_RE.test(u)).slice(0, 4);
  for (const u of ids) {
    const s = slot(`UniProt entry ${u}`, uniHolder);
    fetchInto(s, ctx, `/uniprot/${encodeURIComponent(u)}`, { what: 'UniProt' }).then((ud) => { if (ud !== undefined) renderUniprot(s, ud, u); });
  }
}

function renderPdb(s, e, ID) {
  const kv = [];
  const add = (k, v) => { const t = flat(v); if (t) kv.push(h('dt', { text: k }), h('dd', {}, v instanceof Node ? v : t)); };
  add('Method', e.method);
  if (e.resolution !== null && e.resolution !== undefined && e.resolution !== '') add('Resolution', `${flat(e.resolution)} Å`);
  add('R-factor (work)', e.rvalue);
  add('Keywords', e.keywords);
  add('Organisms', e.organisms);
  const authors = Array.isArray(e.authors) ? e.authors : [];
  if (authors.length) add('Authors', authors.length > 6 ? `${authors.slice(0, 6).join(', ')} and ${authors.length - 6} more` : authors.join(', '));
  if (e.deposited) add('Deposited', String(e.deposited).slice(0, 10));
  if (e.released) add('Released', String(e.released).slice(0, 10));
  if (e.mutations) add('Engineered mutations', fmt(e.mutations));
  if (typeof e.prim_doi === 'string' && /^10\.\d{4,9}\/\S+$/.test(e.prim_doi)) add('Primary citation', h('a', { href: 'https://doi.org/' + e.prim_doi, rel: 'noopener noreferrer', text: e.prim_doi }));
  add('Supersedes', e.supersedes);

  const ents = (e.entities || []).filter((x) => x && typeof x === 'object');
  let table = null;
  if (ents.length) {
    table = h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
      h('caption', { class: 'sr-only', text: 'Molecules in this entry' }),
      h('thead', {}, h('tr', {}, ['Molecule', 'Chains', 'Length', 'Organism', 'UniProt'].map((c) => h('th', { scope: 'col', text: c })))),
      h('tbody', {}, ents.map((x) => h('tr', {},
        h('td', { text: x.molecule || '' }),
        h('td', { text: flat(x.auth_chains && x.auth_chains.length ? x.auth_chains : x.chains) }),
        h('td', { text: x.length ? fmt(x.length) : '' }),
        h('td', { text: flat(x.organism) }),
        h('td', {}, ...(x.uniprot_ids || []).flatMap((u, i) => [i ? ', ' : null, searchLink(u)])))))));
  }
  s.card.querySelector('h2').after(h('p', { class: 'sub', text: e.desc || '' }));
  s.set(h('dl', { class: 'kv' }, kv), table, h('p', { class: 'small' }, h('a', { href: `https://www.rcsb.org/structure/${encodeURIComponent(ID)}`, rel: 'noopener noreferrer', text: `${ID} at RCSB` })));
}

// ------------------------------------------------------------- UniProt search ---

async function uniprotSearch(id, ctx) {
  const wrap = h('div', { class: 'cards' });
  result.append(wrap);
  const uSlot = slot(`UniProt entry ${id}`, wrap);
  const kSlot = slot('AlphaKnot', wrap);
  wrap.append(h('p', { class: 'muted small', text: 'The 3D view and the workspace take a PDB ID. A UniProt entry may have several structures; search one of its PDB IDs to see it.' }));

  fetchInto(kSlot, ctx, `/alphaknot/${encodeURIComponent(id)}`, { what: 'AlphaKnot' }).then((d) => { if (d !== undefined) renderAlphaknot(kSlot, d); });
  const d = await fetchInto(uSlot, ctx, `/uniprot/${encodeURIComponent(id)}`, { what: 'UniProt' });
  if (d !== undefined) renderUniprot(uSlot, d, id);
}

function renderUniprot(s, d, id, ctx = run, failure = '') {
  if (hasError(d)) { s.fail(d.error); return; }
  if (!d || typeof d !== 'object') { s.note('UniProt has no entry with this accession.'); return; }
  const kv = [];
  const add = (k, v) => { const t = flat(v); if (t) kv.push(h('dt', { text: k }), h('dd', { text: t })); };
  add('Gene', d.gene);
  add('Organism', d.organism);
  if (d.length) add('Length', `${fmt(d.length)} residues`);
  add('Molecular functions', d.molecular_functions);
  const diseases = (d.diseases || []).map((x) => (x && typeof x === 'object' ? x.diseaseId : x)).filter(Boolean);
  add('Diseases', diseases);

  const seq = typeof d.sequence === 'string' && /^[A-Za-z*]+$/.test(d.sequence) ? d.sequence : '';
  const variants = d.variants && typeof d.variants === 'object' ? Object.entries(d.variants).filter(([, v]) => Array.isArray(v) && v.length) : [];
  if (!s.card.querySelector('.sub')) s.card.querySelector('h2').after(h('p', { class: 'sub', text: d.protein || '' }));

  // Disease variants are a second, slower request. Whatever happens to it, the entry above stays on screen,
  // and the visitor is told what happened: loaded, nothing on record, or failed (with a retry).
  const loaded = !!d.variants && typeof d.variants === 'object' && !d.variants_error;
  const problem = d.variants_error ? `Disease variants are unavailable right now: ${d.variants_error}` : failure;
  let variantsNote = null;
  if (loaded && !variants.length) variantsNote = h('p', { class: 'muted small', text: 'UniProt records no pathogenic variants for this entry\u2019s diseases.' });
  else if (!loaded && !diseases.length && !problem) variantsNote = h('p', { class: 'muted small', text: 'UniProt lists no disease associations for this entry, so there are no disease variants to load.' });
  else if (problem) variantsNote = h('p', { class: 'error small', role: 'alert', text: problem });
  const canAsk = ctx && !loaded && (diseases.length || problem);
  const variantsButton = canAsk ? h('p', { class: 'small' }, h('button', { type: 'button', class: 'linkish', text: problem ? 'Try again' : 'Load disease variants', onclick: async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Asking UniProt for variants\u2026';
    const timer = setTimeout(() => { ev.target.textContent = 'Still waiting for UniProt. Large genes can take a while; nothing is wrong.'; }, 5000);
    try {
      const full = await get(`/uniprot/${encodeURIComponent(id)}?variants=true`, { signal: ctx.ctl.signal, timeout: 50000 });
      renderUniprot(s, { ...full, variants: full.variants_error ? undefined : (full.variants || {}) }, id, ctx);
    } catch (e) { if (!isAbort(e)) renderUniprot(s, d, id, ctx, `Disease variants did not load: ${msgOf(e)}`); } finally { clearTimeout(timer); }
  } })) : null;

  s.set(
    h('dl', { class: 'kv' }, kv),
    seq ? h('details', {}, h('summary', { text: `Sequence (${fmt(seq.length)} residues)` }), h('div', { class: 'seqbox', tabindex: '0', role: 'region', 'aria-label': 'Amino-acid sequence', text: seq })) : null,
    variants.length ? h('details', { open: true }, h('summary', { text: `Disease variants (${variants.reduce((n, [, v]) => n + v.length, 0)})` }),
      variants.map(([disease, vs]) => h('div', { class: 'table-scroll' }, h('table', { class: 'data' },
        h('caption', { text: disease }),
        h('thead', {}, h('tr', {}, ['Begin', 'End', 'Wild type', 'Mutated'].map((c) => h('th', { scope: 'col', text: c })))),
        h('tbody', {}, vs.map((v) => h('tr', {}, h('td', { text: flat(v.begin) }), h('td', { text: flat(v.end) }), h('td', { text: flat(v.wildType) }), h('td', { text: flat(v.mutatedType) })))))))) : null,
    variantsNote,
    variantsButton,
    h('p', { class: 'small' }, h('a', { href: `https://www.uniprot.org/uniprotkb/${encodeURIComponent(id)}`, rel: 'noopener noreferrer', text: `${id} at UniProt` })));
}

// ---------------------------------------------------------------- knot cards ---

const KNOT_FIELDS = [
  ['knotTypeName', 'Knot type', knotLabel],
  ['knotType', 'Knot type', knotLabel],
  ['category', 'Category'],
  ['knotCategory', 'Knot or slipknot'],
  ['chain', 'Chain'],
  ['chainLength', 'Chain length'],
  ['knotCoreRange', 'Knot core range'],
  ['knotRange', 'Knot core range'],
  ['knotCoreLength', 'Knot core length'],
  ['knotProbability', 'Knot probability'],
  ['pLDDT_knotCore', 'pLDDT of the knot core'],
  ['pLDDT_chain', 'pLDDT of the chain'],
];
const KNOTPROT_CATEGORY = { Y: 'published', A: 'artifact', T: 'not published' };
const KNOTPROT_KIND = { K: 'knot', S: 'slipknot' };

/** pandas gave us {col: [v1, v2]} (or {col: v}); turn either into a list of row objects. */
function rowsOf(d) {
  if (!d || typeof d !== 'object') return [];
  if (Array.isArray(d)) return d.filter((x) => x && typeof x === 'object');
  const cols = Object.keys(d);
  const lens = cols.map((c) => (Array.isArray(d[c]) ? d[c].length : null));
  const n = Math.max(0, ...lens.map((l) => l || 0));
  if (!n) return cols.length ? [d] : [];
  return Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map((c) => [c, Array.isArray(d[c]) ? d[c][i] : d[c]])));
}

function knotRecord(row, { knotprot = false } = {}) {
  const kv = [];
  const seen = new Set();
  for (const [key, label, f] of KNOT_FIELDS) {
    let v = flat(row[key]);
    if (!v || seen.has(label)) continue;
    if (knotprot && key === 'category') v = `${v}${KNOTPROT_CATEGORY[v] ? ' (' + KNOTPROT_CATEGORY[v] + ')' : ''}`;
    if (knotprot && key === 'knotCategory') v = KNOTPROT_KIND[v] || v;
    seen.add(label);
    kv.push(h('dt', { text: label }), h('dd', { text: f ? f(v) : v }));
  }
  if (!seen.has('Knot core range') && row.knotRangeStart !== undefined && row.knotRangeEnd !== undefined && flat(row.knotRangeEnd) !== '0') {
    kv.push(h('dt', { text: 'Knot core range' }), h('dd', { text: `${flat(row.knotRangeStart)}–${flat(row.knotRangeEnd)}` }));
  }
  return kv;
}

function renderKnotprot(s, d, id) {
  if (hasError(d)) { s.fail(d.error); return; }
  const rec = d && (d[id] || d[id.toLowerCase()] || d[id.toUpperCase()] || Object.values(d)[0]);
  // the API gives the first chain's fields plus `chains`: every chain of the entry
  const chains = rec && Array.isArray(rec.chains) && rec.chains.length ? rec.chains : rec;
  const rows = rowsOf(chains).filter((r) => flat(r.knotType) !== '' || flat(r.category) !== '');
  if (!rows.length) { s.note('KnotProt does not list this entry among its knotted chains. That usually means no knot was found, not that nobody looked.'); return; }
  s.set(...rows.map((r) => h('dl', { class: 'kv' }, knotRecord(r, { knotprot: true }))), h('p', { class: 'small' }, h('a', { href: `https://knotprot.cent.uw.edu.pl/view/${encodeURIComponent(id)}`, rel: 'noopener noreferrer', text: 'Open in KnotProt' })));
}

function renderAlphaknot(s, d) {
  if (hasError(d)) { s.fail(d.error); return; }
  const rows = rowsOf(d).filter((r) => flat(r.knotType) !== '' || flat(r.category) !== '');
  if (!rows.length) { s.note('AlphaKnot has no knot recorded for this accession (it only covers AlphaFold models of knotted chains).'); return; }
  s.set(...rows.map((r) => h('dl', { class: 'kv' }, knotRecord(r))));
}

// ------------------------------------------------------------------ viewer ---

async function buildViewer(ID, section, ctx) {
  const note = h('p', { class: 'viewer-note' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading the structure…');
  const el = h('div', { class: 'viewer', role: 'img', 'aria-label': `Interactive 3D cartoon of PDB entry ${ID}. Drag to rotate, scroll to zoom.` });
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const openBtn = h('button', { type: 'button', text: 'Open in workspace' });
  const reset = h('button', { type: 'button', text: 'Reset view', disabled: 'disabled' });
  section.append(
    h('h2', { text: '3D structure' }),
    h('div', { class: 'viewer-wrap' }, el, note),
    h('div', { class: 'vtools' }, openBtn, reset,
      h('a', { class: 'btn', href: `${BASE}/structure/${encodeURIComponent(ID)}.pdb`, download: `${ID}.pdb`, text: 'Download PDB file' })),
    h('p', { class: 'muted small', text: 'Drag to rotate, scroll or pinch to zoom, right-drag to move. The workspace adds shared selections, annotations and mutation proposals.' }),
    status);

  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    status.className = 'status';
    status.textContent = 'Creating a room…';
    try {
      const r = await post('/rooms', { pdb: ID }, { timeout: 60000 });
      rememberRoom(r.id, r.structure && r.structure.title);
      location.href = `${WORKSPACE_URL}#${r.id}`;
    } catch (e) {
      status.className = 'status error';
      status.textContent = msgOf(e);
      openBtn.disabled = false;
    }
  });

  try {
    const text = await get(`/structure/${encodeURIComponent(ID)}.pdb`, { text: true, signal: ctx.ctl.signal, timeout: 60000 });
    const viewer = await Viewer.create(el);
    if (ctx !== run) { viewer.dispose(); return; }
    ctx.viewer = viewer;
    await viewer.load(text, 'pdb');
    note.hidden = true;
    note.style.display = 'none';
    reset.disabled = false;
    reset.addEventListener('click', () => viewer.resetView());
  } catch (e) {
    if (isAbort(e)) return;
    note.classList.add('error');
    note.textContent = e instanceof ApiError && e.status === 404
      ? 'RCSB has no coordinate file for this ID.'
      : (e instanceof ApiError ? msgOf(e) : (e && e.message) || 'The structure could not be shown.');
  }
}
