// ProTop workspace: one structure, a sequence panel, and a shared log of annotations and mutation proposals that
// everyone with the link sees within a couple of seconds. See protop-app/API.md for the contract.

import { h, $, clear, relTime } from './dom.js';
import { get, post, ApiError, msgOf, ROOM_ID, roomPath, BASE, WORKSPACE_URL } from './api.js';
import { Viewer } from './viewer.js';
import { SeqPanel } from './seqpanel.js';
import { Syncer } from './sync.js';
import {
  AMINO, PALETTE, Residues, OpLog, rangeSele, mutationsByResidue, sortedAnnotations, resLabel,
  randomId, remembered, remember, recentRooms, rememberRoom, forgetRooms,
} from './room.js';

const MAX_UPLOAD = 5 * 1024 * 1024;
const root = $('ws');
let current = null;

// ------------------------------------------------------------------ routing ---

async function route() {
  if (current) current.destroy();
  current = null;
  clear(root);
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return showStart();
  if (!ROOM_ID.test(id)) return showStart('That link does not look like a workspace link. Check that it was copied whole.');
  current = await openRoom(id);
}
addEventListener('hashchange', route);
route();

// -------------------------------------------------------------- start panel ---

function showStart(message) {
  clear(root);
  const msg = h('p', { class: 'status error', role: 'alert', text: message || '' });
  const pdbIn = h('input', { id: 'start-pdb', type: 'text', name: 'pdb', maxlength: '4', autocomplete: 'off', spellcheck: 'false', placeholder: '1R42', 'aria-describedby': 'start-pdb-hint' });
  const pdbBtn = h('button', { type: 'submit', text: 'Open structure' });
  const pdbForm = h('form', { class: 'row', 'aria-label': 'Start from a PDB ID' }, pdbIn, pdbBtn);
  const fileIn = h('input', { id: 'start-file', type: 'file', accept: '.pdb,.ent,.cif,.mmcif,text/plain' });
  const fileBtn = h('button', { type: 'submit', text: 'Upload and open' });
  const fileForm = h('form', { class: 'row', 'aria-label': 'Start from a file' }, fileIn, fileBtn);
  const busy = (b, on, text) => { for (const x of [pdbBtn, fileBtn, pdbIn, fileIn]) x.disabled = on; b.textContent = on ? 'Creating the room…' : text; };

  async function create(body, btn, label) {
    msg.textContent = '';
    busy(btn, true, label);
    try {
      const r = await post('/rooms', body, { timeout: 60000 });
      rememberRoom(r.id, r.structure && r.structure.title);
      location.hash = '#' + r.id;
    } catch (e) {
      msg.textContent = msgOf(e);
      busy(btn, false, label);
    }
  }
  pdbForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = pdbIn.value.trim();
    if (!/^[0-9][A-Za-z0-9]{3}$/.test(v)) { msg.textContent = 'A PDB ID is four characters, a digit then three letters or digits, like 1R42.'; pdbIn.focus(); return; }
    create({ pdb: v.toUpperCase() }, pdbBtn, 'Open structure');
  });
  fileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = fileIn.files[0];
    if (!f) { msg.textContent = 'Choose a .pdb or .cif file first.'; fileIn.focus(); return; }
    if (f.size > MAX_UPLOAD) { msg.textContent = `That file is ${(f.size / 1048576).toFixed(1)} MB; the limit is 5 MB.`; return; }
    let text;
    try { text = await f.text(); } catch { msg.textContent = 'Could not read that file.'; return; }
    create({ upload: { name: f.name.slice(0, 100), text } }, fileBtn, 'Upload and open');
  });

  const recents = recentRooms();
  const recent = recents.length
    ? h('div', { class: 'panel' },
        h('h2', { text: 'Your recent rooms' }),
        h('p', { class: 'muted small', text: 'Remembered in this browser only. A room is deleted 14 days after its last use.' }),
        h('ul', { class: 'plain' }, recents.map((r) => h('li', {}, h('a', { href: WORKSPACE_URL + '#' + r.id, text: r.title || 'Untitled structure' }), h('span', { class: 'muted small', text: ' · ' + relTime(new Date(r.at).toISOString()) })))),
        h('button', { type: 'button', class: 'linkish', text: 'Forget these', onclick: () => { forgetRooms(); showStart(); } }))
    : null;

  root.append(
    h('div', { class: 'panel start' },
      h('h2', { text: 'Start a room' }),
      h('p', { text: 'A room is one structure that you and anyone you send the link to can look at together: the selection each person is making, annotations on stretches of residues, and proposed mutations that the group can accept or reject. There are no accounts. The link is the key, so share it only with people you want in.' }),
      msg,
      h('label', { for: 'start-pdb', text: 'Open a structure from the PDB' }), pdbForm,
      h('p', { id: 'start-pdb-hint', class: 'muted small', text: 'Four-character ID, such as 1R42 (an enzyme with a zinc ion) or 1AKI (lysozyme).' }),
      h('label', { for: 'start-file', text: 'Or upload your own file (.pdb or .cif, up to 5 MB)' }), fileForm,
      h('p', { class: 'muted small', text: 'Uploaded files are stored on this site so that everyone in the room can load them, and are deleted with the room.' })),
    recent);
}

// ---------------------------------------------------------------- the room ---

async function openRoom(id) {
  root.append(h('p', { class: 'status', role: 'status', text: 'Opening the room…' }));
  let info;
  try {
    info = await get(roomPath(id));
  } catch (e) {
    clear(root);
    if (e instanceof ApiError && e.status === 404) { showStart('That room does not exist (any more). Rooms are deleted after 14 days without use.'); return null; }
    root.append(
      h('p', { class: 'status error', role: 'alert', text: msgOf(e) }),
      h('p', {}, h('button', { type: 'button', text: 'Try again', onclick: route }), ' ', h('a', { href: WORKSPACE_URL, text: 'Start a different room' })));
    return null;
  }
  clear(root);
  rememberRoom(id, info.structure && info.structure.title);
  return new Room(id, info);
}

class Room {
  constructor(id, info) {
    this.id = id;
    this.info = info;
    this.residues = new Residues(info.chains || []);
    // identity: a client id per tab, a name and colour per browser
    this.client = remembered('protop.client', () => randomId(16), 'session');
    this.name = (remembered('protop.name', () => 'guest-' + randomId(4)) || '').slice(0, 32);
    this.color = remembered('protop.color', () => PALETTE[Math.floor(Math.random() * PALETTE.length)]);
    if (!PALETTE.includes(this.color)) this.color = PALETTE[0];
    this.log = new OpLog(this.client);
    this.others = []; // presence entries of other clients
    this.sel = null; // {chain, a, b} positions in the chain
    this.viewer = null;
    this.editing = null; // annotation key being edited
    this.editDraft = '';
    this.confirming = null; // key of the item whose delete is awaiting confirmation
    this.queue = Promise.resolve();
    this.dead = false;
    this.lastSig = '';
    this.build();
    this.syncer = new Syncer({
      roomId: id,
      client: this.client,
      getSeq: () => this.log.seq,
      onOps: (ops) => { if (this.log.addServerOps(ops)) this.opsChanged(); },
      onPresence: (list) => this.presenceChanged(list),
      onState: (s) => this.setConn(s),
    });
    this.syncer.setPresence(this.presencePayload());
    this.syncer.start();
    this.startViewer();
    this.tick = setInterval(() => this.refreshTimes(), 30000);
  }

  destroy() {
    this.dead = true;
    this.syncer.stop();
    clearInterval(this.tick);
    if (this.viewer) this.viewer.dispose();
    this.viewer = null;
  }

  // ------------------------------------------------------------- building ---

  build() {
    const { info } = this;
    const base = `${BASE}${roomPath(this.id)}/export?format=`;
    const slug = (info.structure.source || 'room').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);

    this.conn = h('span', { class: 'conn', role: 'status', 'aria-live': 'polite', text: 'Connecting…' });
    this.msg = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    this.link = h('input', { type: 'text', readonly: 'readonly', value: location.href, 'aria-label': 'Link to this room', onfocus: (e) => e.target.select() });
    this.copyBtn = h('button', { type: 'button', text: 'Copy link', onclick: () => this.copyLink() });

    const head = h('div', { class: 'ws-head' },
      h('div', {},
        h('h2', { class: 'ws-title', text: info.structure.title || 'Untitled structure' }),
        h('p', { class: 'muted small', text: [info.structure.source, `${info.chains.length} chain${info.chains.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') })),
      this.conn);

    const share = h('div', { class: 'ws-share' },
      h('div', { class: 'row' }, this.link, this.copyBtn),
      h('div', { class: 'row export' },
        h('span', { class: 'muted small', text: 'Export' }),
        h('a', { class: 'btn', href: base + 'fasta', download: slug + '.fasta', text: 'FASTA with accepted mutations' }),
        h('a', { class: 'btn', href: base + 'json', download: slug + '.json', text: 'JSON' })),
      h('p', { class: 'muted small', text: 'Anyone with this link can read and edit this room. It is deleted 14 days after its last use.' }));

    // viewer ---------------------------------------------------------------
    this.viewerEl = h('div', { class: 'viewer', role: 'img', 'aria-label': `3D view of ${info.structure.title || 'the structure'}. The sequence panel does the same selecting from the keyboard.` });
    this.viewerNote = h('p', { class: 'viewer-note', text: 'Loading the 3D view…' });
    this.bf = h('input', { type: 'checkbox', id: 'bf', disabled: 'disabled', onchange: () => this.toggleBf() });
    this.bfLegend = h('span', { class: 'bf-legend', hidden: 'hidden' }, h('span', { class: 'bf-lo' }), h('span', { class: 'bf-bar', 'aria-hidden': 'true' }), h('span', { class: 'bf-hi' }));
    const vtools = h('div', { class: 'vtools' },
      h('button', { type: 'button', text: 'Reset view', onclick: () => this.viewer && this.viewer.resetView() }),
      h('label', { class: 'check', for: 'bf' }, this.bf, ' Colour by B-factor'), this.bfLegend);
    const vcaption = h('p', { class: 'muted small', id: 'bf-caption', text: 'B-factor is the flexibility of each atom as measured in the experiment and stored in the file: blue is rigid, red is mobile. Models predicted by AlphaFold keep a confidence score in that column instead, so read those the other way round.' });
    this.bf.setAttribute('aria-describedby', 'bf-caption');
    this.vwrap = h('div', { class: 'viewer-wrap' }, this.viewerEl, this.viewerNote);

    // people ---------------------------------------------------------------
    this.nameIn = h('input', { id: 'me-name', type: 'text', maxlength: '32', value: this.name, autocomplete: 'off', onchange: () => this.renamed() });
    this.swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Your colour' }, PALETTE.map((c) => {
      const b = h('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-label': 'Colour ' + c, 'aria-checked': String(c === this.color), onclick: () => this.recolor(c) });
      b.style.background = c;
      b.dataset.color = c;
      return b;
    }));
    this.peopleList = h('ul', { class: 'plain people' });
    const people = h('section', { class: 'panel people-panel', 'aria-labelledby': 'h-people' },
      h('h3', { id: 'h-people', text: 'People here' }),
      h('div', { class: 'me' }, h('label', { for: 'me-name', text: 'Your name' }), this.nameIn),
      this.swatches,
      this.peopleList);

    // selection + sequence ---------------------------------------------------
    this.selbar = h('div', { class: 'selbar', role: 'status', 'aria-live': 'polite' });
    this.seqRoot = h('div', { class: 'seqroot' });
    this.seqRoot.style.setProperty('--me', this.color);
    const seqBox = h('div', { class: 'scrollbox', role: 'region', 'aria-label': 'Sequence', 'aria-describedby': 'seq-help' }, this.seqRoot);
    const seqHelp = h('p', { id: 'seq-help', class: 'muted small', text: 'Click a residue to select it, shift-click for a range. With the keyboard: arrow keys move, Enter or Space selects, Shift with an arrow extends, Home and End go along the row, Escape clears. Coloured bars under a letter are other people\'s selections.' });
    this.seq = new SeqPanel(this.seqRoot, this.residues, {
      onPick: (chain, i, extend) => this.pick(chain, i, extend),
      onClear: () => this.setSel(null),
    });

    // annotations ----------------------------------------------------------
    this.annText = h('textarea', { id: 'ann-text', rows: '2', maxlength: '500', placeholder: 'What is interesting about this stretch?', 'aria-describedby': 'ann-hint' });
    this.annBtn = h('button', { type: 'submit', text: 'Add annotation', disabled: 'disabled' });
    this.annForm = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); this.addAnnotation(); } },
      h('label', { for: 'ann-text', text: 'Annotate the selection' }), this.annText,
      h('p', { id: 'ann-hint', class: 'muted small', text: 'Select residues first. Up to 500 characters.' }), this.annBtn);
    this.annList = h('ul', { class: 'items', 'aria-label': 'Annotations' });
    this.annCount = h('span', { class: 'muted small' });
    const annotations = h('section', { class: 'panel', 'aria-labelledby': 'h-ann' }, h('h3', { id: 'h-ann' }, 'Annotations ', this.annCount), this.annForm, this.annList);

    // mutations ------------------------------------------------------------
    this.mutTo = h('select', { id: 'mut-to', 'aria-describedby': 'mut-hint' });
    this.mutNote = h('input', { id: 'mut-note', type: 'text', maxlength: '500', placeholder: 'Why? (optional)' });
    this.mutBtn = h('button', { type: 'submit', text: 'Propose mutation', disabled: 'disabled' });
    this.mutHint = h('p', { id: 'mut-hint', class: 'muted small' });
    this.mutForm = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); this.addMutation(); } },
      h('label', { for: 'mut-to', text: 'Change the selected residue to' }), this.mutTo,
      h('label', { for: 'mut-note', text: 'Note' }), this.mutNote, this.mutHint, this.mutBtn);
    this.mutList = h('ul', { class: 'items', 'aria-label': 'Mutation proposals' });
    this.mutCount = h('span', { class: 'muted small' });
    const mutations = h('section', { class: 'panel', 'aria-labelledby': 'h-mut' }, h('h3', { id: 'h-mut' }, 'Mutation proposals ', this.mutCount),
      h('p', { class: 'muted small', text: 'Anyone can accept or reject a proposal, and the last click wins. Accepted ones show as the new letter in the sequence and in the FASTA export.' }),
      this.mutForm, this.mutList);

    this.wrap = h('div', { class: 'ws' },
      head, this.msg,
      h('div', { class: 'ws-grid' },
        h('div', { class: 'area-viewer' }, this.vwrap, vtools, vcaption),
        h('div', { class: 'area-side' }, this.selbar, h('section', { class: 'panel', 'aria-labelledby': 'h-seq' }, h('h3', { id: 'h-seq', text: 'Sequence' }), seqHelp, seqBox), annotations, mutations),
        h('div', { class: 'area-people' }, people, share)));
    root.append(this.wrap);
    this.fillMutChoices(null);
    this.renderSel();
    this.opsChanged();
    this.renderPeople();
  }

  async startViewer() {
    try {
      const [viewer, text] = await Promise.all([
        Viewer.create(this.viewerEl, { onPick: (p) => this.pickFromViewer(p) }),
        get(`${roomPath(this.id)}/structure`, { text: true, timeout: 60000 }),
      ]);
      if (this.dead) { viewer.dispose(); return; }
      this.viewer = viewer;
      const r = await viewer.load(text, this.info.structure.format === 'cif' ? 'cif' : 'pdb');
      if (this.dead) return;
      this.viewerNote.hidden = true;
      this.bf.disabled = !r.bfactorRange;
      this.bfRange = r.bfactorRange;
      if (!r.bfactorRange) this.bf.title = 'This file has no varying B-factors.';
      this.refreshViewer();
    } catch (e) {
      if (this.dead) return;
      this.viewerNote.hidden = false;
      this.viewerNote.textContent = (e && e.message ? e.message : 'The 3D view could not start.') + ' The sequence panel and everything else still work.';
      this.viewerNote.classList.add('error');
    }
  }

  // ------------------------------------------------------------ connection ---

  setConn(s) {
    const text = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', gone: 'Room not found' }[s];
    this.conn.textContent = text;
    this.conn.className = 'conn ' + s;
    if (s === 'gone') {
      this.msg.textContent = 'This room no longer exists. It may have expired. Nothing you add now will be saved.';
      this.msg.className = 'status error';
    }
  }

  flash(text, kind = 'error') {
    this.msg.textContent = text;
    this.msg.className = 'status ' + kind;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { if (this.msg.textContent === text) this.msg.textContent = ''; }, 9000);
  }

  async copyLink() {
    this.link.value = location.href;
    try {
      await navigator.clipboard.writeText(location.href);
      this.copyBtn.textContent = 'Copied';
    } catch {
      this.link.focus();
      this.link.select();
      this.copyBtn.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { this.copyBtn.textContent = 'Copy link'; }, 2500);
  }

  // -------------------------------------------------------------- identity ---

  renamed() {
    const v = this.nameIn.value.trim().slice(0, 32);
    if (!v) { this.nameIn.value = this.name; return; }
    this.name = v;
    remember('protop.name', v);
    this.syncer.setPresence(this.presencePayload());
  }
  recolor(c) {
    this.color = c;
    remember('protop.color', c);
    for (const b of this.swatches.children) b.setAttribute('aria-checked', String(b.dataset.color === c));
    this.seqRoot.style.setProperty('--me', c);
    this.syncer.setPresence(this.presencePayload());
    this.refreshViewer();
  }

  // ------------------------------------------------------------- selection ---

  range() {
    if (!this.sel) return null;
    const lo = Math.min(this.sel.a, this.sel.b), hi = Math.max(this.sel.a, this.sel.b);
    const a = this.residues.at(this.sel.chain, lo), b = this.residues.at(this.sel.chain, hi);
    if (!a || !b) return null;
    return { chain: this.sel.chain, lo, hi, start: Math.min(a.num, b.num), end: Math.max(a.num, b.num), first: a, last: b };
  }

  presencePayload() {
    const r = this.range();
    return { name: this.name, color: this.color, chain: r ? r.chain : null, start: r ? r.start : null, end: r ? r.end : null };
  }

  pick(chain, i, extend) {
    if (extend && this.sel && this.sel.chain === chain) this.sel.b = i;
    else if (!extend && this.sel && this.sel.chain === chain && this.sel.a === i && this.sel.b === i) this.sel = null;
    else this.sel = { chain, a: i, b: i };
    this.selectionChanged();
  }

  pickFromViewer(p) {
    const i = this.residues.indexOf(p.chain, p.num, p.icode);
    if (i < 0) return;
    this.pick(p.chain, i, p.shift);
    this.seq.scrollTo(p.chain, i);
    this.seq.focusCell(p.chain, i, { focus: false });
  }

  setSel(sel, { zoom = false, scroll = false } = {}) {
    this.sel = sel;
    this.selectionChanged();
    const r = this.range();
    if (r && scroll) { this.seq.scrollTo(r.chain, r.lo); this.seq.focusCell(r.chain, r.lo, { focus: false }); }
    if (r && zoom && this.viewer) this.viewer.focus(rangeSele(this.residues.chain(r.chain), r.lo, r.hi));
  }

  selectionChanged() {
    const r = this.range();
    this.seq.setSelection(r);
    this.renderSel();
    this.refreshViewer();
    this.syncer.setPresence(this.presencePayload());
  }

  renderSel() {
    const r = this.range();
    clear(this.selbar);
    if (!r) {
      this.selbar.append(h('span', { class: 'muted', text: 'Nothing selected. Click a residue in the sequence or in the 3D view; shift-click to extend.' }));
    } else {
      const n = r.hi - r.lo + 1;
      this.selbar.append(
        h('span', {}, h('strong', { text: `Chain ${r.chain}, ` }), n === 1 ? `${r.first.aa}${resLabel(r.first)}` : `${resLabel(r.first)}–${resLabel(r.last)} (${n} residues)`),
        ' ', h('button', { type: 'button', text: 'Clear', onclick: () => this.setSel(null) }));
    }
    const has = !!r;
    this.annBtn.disabled = !has;
    const single = has && r.lo === r.hi;
    this.fillMutChoices(single ? r.first : null);
    this.mutBtn.disabled = !single;
    this.mutHint.textContent = !has ? 'Select a single residue first.' : single ? `Proposing a change to ${r.first.aa}${resLabel(r.first)} in chain ${r.chain}.` : 'A mutation changes one residue: select just one.';
  }

  fillMutChoices(residue) {
    const keep = this.mutTo.value;
    clear(this.mutTo);
    for (const [k, name] of Object.entries(AMINO)) {
      if (residue && residue.aa === k) continue;
      this.mutTo.append(h('option', { value: k, text: `${k} – ${name}` }));
    }
    if (keep && [...this.mutTo.options].some((o) => o.value === keep)) this.mutTo.value = keep;
    this.mutTo.disabled = !residue;
  }

  // ------------------------------------------------------------------- ops ---

  submit(partial, onFail) {
    const op = { ...partial, client: this.client, author: this.name };
    const p = this.log.addPending({ ...op, ts: new Date().toISOString() });
    this.opsChanged();
    this.queue = this.queue.then(async () => {
      try {
        const r = await post(`${roomPath(this.id)}/ops`, op, { timeout: 15000 });
        this.log.resolve(p, r.op);
        this.syncer.poke();
      } catch (e) {
        this.log.drop(p);
        this.flash(msgOf(e));
        if (onFail) onFail();
      }
      if (!this.dead) this.opsChanged();
    });
  }

  addAnnotation() {
    const r = this.range(), text = this.annText.value.trim();
    if (!r || !text) { this.annText.focus(); return; }
    this.annText.value = '';
    this.submit({ type: 'annotation', chain: r.chain, start: r.start, end: r.end, text }, () => { if (!this.annText.value) this.annText.value = text; });
  }

  addMutation() {
    const r = this.range();
    if (!r || r.lo !== r.hi) return;
    const op = { type: 'mutation', chain: r.chain, num: r.first.num, to: this.mutTo.value };
    if (r.first.icode) op.icode = r.first.icode;
    const note = this.mutNote.value.trim();
    if (note) op.note = note;
    this.mutNote.value = '';
    this.submit(op, () => { if (!this.mutNote.value) this.mutNote.value = note; });
  }

  // ----------------------------------------------------------- rendering ---

  opsChanged() {
    const { annotations, mutations } = this.log.folded();
    const sig = JSON.stringify([annotations, mutations, this.editing, this.confirming]);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.renderAnnotations(annotations);
      this.renderMutations(mutations);
    }
    this.refreshMarks();
    this.refreshViewer();
  }

  presenceChanged(list) {
    const others = list.filter((p) => p.client !== this.client);
    const sig = JSON.stringify(others);
    if (sig === this.presenceSig) return;
    this.presenceSig = sig;
    this.others = others;
    this.renderPeople();
    this.refreshMarks();
    this.refreshViewer();
  }

  othersSpan(p) {
    if (!p.chain || p.start == null || p.end == null) return null;
    const s = this.residues.span(p.chain, p.start, p.end);
    return s ? { chain: p.chain, lo: s[0], hi: s[1] } : null;
  }

  refreshMarks() {
    const marks = new Map();
    const at = (chain, i) => {
      let m = marks.get(chain);
      if (!m) marks.set(chain, (m = new Map()));
      let e = m.get(i);
      if (!e) m.set(i, (e = { others: [], ann: 0 }));
      return e;
    };
    for (const p of this.others) {
      const s = this.othersSpan(p);
      if (s) for (let i = s.lo; i <= s.hi; i++) at(s.chain, i).others.push({ color: p.color, name: p.name });
    }
    const { annotations, mutations } = this.log.folded();
    for (const a of annotations) {
      const s = this.residues.span(a.chain, a.start, a.end);
      if (s) for (let i = s[0]; i <= s[1]; i++) at(a.chain, i).ann++;
    }
    for (const [k, v] of mutationsByResidue(mutations)) {
      const [chain, num, icode] = k.split('|');
      const i = this.residues.indexOf(chain, +num, icode);
      if (i < 0) continue;
      const e = at(chain, i);
      if (v.accepted) e.accepted = v.accepted.to;
      if (v.proposed) e.proposed = v.proposed.to;
    }
    this.seq.setMarks(marks);
  }

  refreshViewer() {
    if (!this.viewer) return;
    const layers = [];
    const sele = (chain, lo, hi) => rangeSele(this.residues.chain(chain), lo, hi);
    const { annotations, mutations } = this.log.folded();
    const ann = [];
    for (const a of annotations) {
      const s = this.residues.span(a.chain, a.start, a.end);
      if (s) ann.push(sele(a.chain, s[0], s[1]));
    }
    layers.push({ key: 'ann', sele: ann.join(' or '), color: '#ffd43b', style: 'band', scale: 1.45 });
    for (const status of ['accepted', 'proposed']) {
      const parts = [];
      for (const [k, v] of mutationsByResidue(mutations)) {
        if (!v[status]) continue;
        const [chain, num, icode] = k.split('|');
        const i = this.residues.indexOf(chain, +num, icode);
        if (i >= 0) parts.push(sele(chain, i, i));
      }
      layers.push({ key: 'mut-' + status, sele: parts.join(' or '), color: status === 'accepted' ? '#37b24d' : '#ff922b', style: 'sticks' });
    }
    for (const p of this.others) {
      const s = this.othersSpan(p);
      if (s) layers.push({ key: 'u:' + p.client, sele: sele(s.chain, s.lo, s.hi), color: p.color, style: 'band', scale: 1.7 + 0.04 * (p.client.charCodeAt(0) % 4) });
    }
    const r = this.range();
    if (r) layers.push({ key: 'me', sele: sele(r.chain, r.lo, r.hi), color: this.color, style: 'band', scale: 2.0 });
    this.viewer.setLayers(layers);
  }

  toggleBf() {
    if (!this.viewer) return;
    this.viewer.setBfactor(this.bf.checked);
    this.bfLegend.hidden = !this.bf.checked || !this.bfRange;
    if (this.bfRange) {
      this.bfLegend.querySelector('.bf-lo').textContent = this.bfRange[0].toFixed(0);
      this.bfLegend.querySelector('.bf-hi').textContent = this.bfRange[1].toFixed(0);
    }
  }

  renderPeople() {
    clear(this.peopleList);
    if (!this.others.length) {
      this.peopleList.append(h('li', { class: 'muted small', text: 'Just you so far. Share the link to bring someone in.' }));
      return;
    }
    for (const p of this.others) {
      const s = this.othersSpan(p);
      const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
      dot.style.background = /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#888';
      const where = s ? `chain ${s.chain}, ${resLabel(this.residues.at(s.chain, s.lo))}${s.hi > s.lo ? '–' + resLabel(this.residues.at(s.chain, s.hi)) : ''}` : 'nothing selected';
      this.peopleList.append(h('li', { class: 'person' }, dot, h('span', { class: 'who' }, h('strong', { text: p.name }), h('span', { class: 'muted small', text: ' · ' + where })),
        s ? h('button', { type: 'button', class: 'linkish small', text: 'look', 'aria-label': `Look at ${p.name}'s selection`, onclick: () => { this.seq.scrollTo(s.chain, s.lo); if (this.viewer) this.viewer.focus(rangeSele(this.residues.chain(s.chain), s.lo, s.hi)); } }) : null));
    }
  }

  focusRange(chain, start, end) {
    const s = this.residues.span(chain, start, end);
    if (!s) return;
    this.setSel({ chain, a: s[0], b: s[1] }, { zoom: true, scroll: true });
  }

  meta(item) {
    const t = h('time', { class: 'when', text: relTime(item.ts), title: item.ts ? new Date(item.ts).toLocaleString() : '' });
    t.dataset.ts = item.ts || '';
    return h('p', { class: 'by muted small' }, item.author || 'someone', ' · ', t, item.edited ? ' · edited' : '', item.pending ? ' · sending…' : '');
  }

  renderAnnotations(list) {
    const focusedEdit = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('edit-text');
    const sorted = sortedAnnotations(list, this.residues);
    this.annCount.textContent = `(${sorted.length})`;
    clear(this.annList);
    if (!sorted.length) this.annList.append(h('li', { class: 'muted small', text: 'No annotations yet.' }));
    let editArea = null;
    for (const a of sorted) {
      const where = `${a.chain}:${a.start}${a.end !== a.start ? '–' + a.end : ''}`;
      const chip = h('button', { type: 'button', class: 'chip', text: where, title: 'Select and show these residues', onclick: () => this.focusRange(a.chain, a.start, a.end) });
      let body;
      const actions = h('div', { class: 'actions' });
      if (this.editing === a.key) {
        editArea = h('textarea', { class: 'edit-text', rows: '3', maxlength: '500', 'aria-label': 'Edit the annotation text', oninput: (e) => { this.editDraft = e.target.value; } });
        editArea.value = this.editDraft;
        body = editArea;
        actions.append(
          h('button', { type: 'button', text: 'Save', onclick: () => this.saveEdit(a) }),
          h('button', { type: 'button', text: 'Cancel', onclick: () => { this.editing = null; this.opsChanged(); } }));
      } else {
        body = h('p', { class: 'text', text: a.text });
        if (this.confirming === a.key) {
          actions.append(
            h('span', { class: 'small', text: 'Delete this annotation for everyone?' }),
            h('button', { type: 'button', text: 'Delete it', onclick: () => { this.confirming = null; this.submit({ type: 'annotation_delete', target: a.seq }); } }),
            h('button', { type: 'button', text: 'Keep', onclick: () => { this.confirming = null; this.opsChanged(); } }));
        } else {
          actions.append(
            h('button', { type: 'button', text: 'Edit', disabled: a.pending ? 'disabled' : null, onclick: () => { this.editing = a.key; this.editDraft = a.text; this.confirming = null; this.focusEdit = true; this.opsChanged(); } }),
            h('button', { type: 'button', text: 'Delete', disabled: a.pending ? 'disabled' : null, onclick: () => { this.confirming = a.key; this.editing = null; this.opsChanged(); } }));
        }
      }
      this.annList.append(h('li', { class: 'item' + (a.pending ? ' pending' : '') }, h('div', { class: 'item-head' }, chip), body, this.meta(a), actions));
    }
    if (editArea && (focusedEdit || this.focusEdit)) { editArea.focus(); this.focusEdit = false; }
  }

  saveEdit(a) {
    const text = this.editDraft.trim();
    if (!text) { this.flash('An annotation cannot be empty. Delete it instead.'); return; }
    this.editing = null;
    if (text !== a.text) this.submit({ type: 'annotation_edit', target: a.seq, text });
    else this.opsChanged();
  }

  renderMutations(list) {
    const sorted = [...list].sort((a, b) => (a.seq ?? 1e12) - (b.seq ?? 1e12));
    this.mutCount.textContent = `(${sorted.length})`;
    clear(this.mutList);
    if (!sorted.length) this.mutList.append(h('li', { class: 'muted small', text: 'No proposals yet.' }));
    for (const m of sorted) {
      const ri = this.residues.indexOf(m.chain, m.num, m.icode);
      const from = m.from || (ri >= 0 ? this.residues.at(m.chain, ri).aa : '?');
      const label = `${from}${m.num}${m.icode || ''}${m.to}`;
      const chip = h('button', { type: 'button', class: 'chip', text: `${m.chain}:${label}`, title: 'Select and show this residue', onclick: () => this.focusRange(m.chain, m.num, m.num) });
      const statusBtns = ['proposed', 'accepted', 'rejected'].map((st) => h('button', {
        type: 'button', class: 'st st-' + st, text: st, 'aria-pressed': String(m.status === st),
        disabled: m.pending ? 'disabled' : null,
        onclick: () => { if (m.status !== st) this.submit({ type: 'mutation_status', target: m.seq, status: st }); },
      }));
      const actions = h('div', { class: 'actions' }, h('span', { role: 'group', 'aria-label': `Status of ${label}`, class: 'seg' }, statusBtns));
      if (this.confirming === m.key) {
        actions.append(h('span', { class: 'small', text: 'Delete this proposal?' }),
          h('button', { type: 'button', text: 'Delete it', onclick: () => { this.confirming = null; this.submit({ type: 'mutation_delete', target: m.seq }); } }),
          h('button', { type: 'button', text: 'Keep', onclick: () => { this.confirming = null; this.opsChanged(); } }));
      } else {
        actions.append(h('button', { type: 'button', text: 'Delete', disabled: m.pending ? 'disabled' : null, onclick: () => { this.confirming = m.key; this.opsChanged(); } }));
      }
      this.mutList.append(h('li', { class: 'item' + (m.pending ? ' pending' : '') },
        h('div', { class: 'item-head' }, chip, h('span', { class: 'badge st-' + m.status, text: m.status })),
        m.note ? h('p', { class: 'text', text: m.note }) : null,
        this.meta(m), actions));
    }
  }

  refreshTimes() {
    for (const t of this.wrap.querySelectorAll('time.when')) if (t.dataset.ts) t.textContent = relTime(t.dataset.ts);
  }
}
