// Workspace state without any DOM: the op log, folding it into annotations and mutations (exactly as API.md says),
// optimistic local ops, and residue/selection helpers. Chain names and residue numbers are the author ones.

export const AMINO = {
  A: 'Alanine', C: 'Cysteine', D: 'Aspartate', E: 'Glutamate', F: 'Phenylalanine', G: 'Glycine', H: 'Histidine',
  I: 'Isoleucine', K: 'Lysine', L: 'Leucine', M: 'Methionine', N: 'Asparagine', P: 'Proline', Q: 'Glutamine',
  R: 'Arginine', S: 'Serine', T: 'Threonine', V: 'Valine', W: 'Tryptophan', Y: 'Tyrosine',
};

/** Colours people can pick from (readable on the white and the dark page). */
export const PALETTE = ['#e03131', '#e8590c', '#2f9e44', '#0c8599', '#1c7ed6', '#7048e8', '#c2255c', '#8d6e3f'];

export const resKey = (num, icode = '') => num + '|' + (icode || '');
export const resLabel = (r) => r.num + (r.icode || '');

// ---------------------------------------------------------------- residues ---

/** Lookups over the room's chains, so numbers from the API turn into positions in the chain (and back). */
export class Residues {
  constructor(chains) {
    this.chains = chains;
    this.byName = new Map();
    for (const c of chains) {
      const first = new Map(), last = new Map(), exact = new Map();
      c.residues.forEach((r, i) => {
        if (!first.has(r.num)) first.set(r.num, i);
        last.set(r.num, i);
        exact.set(resKey(r.num, r.icode), i);
      });
      this.byName.set(c.name, { chain: c, first, last, exact });
    }
  }
  chain(name) { return this.byName.get(name)?.chain || null; }
  at(name, i) { return this.byName.get(name)?.chain.residues[i] || null; }
  indexOf(name, num, icode = '') { return this.byName.get(name)?.exact.get(resKey(num, icode)) ?? this.byName.get(name)?.first.get(num) ?? -1; }
  /** residue-number range -> [i0, i1] positions in the chain, or null if it is not there */
  span(name, start, end) {
    const c = this.byName.get(name);
    if (!c) return null;
    const i0 = c.first.get(start);
    if (i0 === undefined) return null;
    let i1 = c.first.get(end);
    if (i1 === undefined || i1 < i0) i1 = c.last.get(end);
    if (i1 === undefined || i1 < i0) i1 = i0;
    return [i0, i1];
  }
}

/**
 * NGL selection string for positions i0..i1 of a chain. Runs of consecutive residue numbers become ranges;
 * residues with insertion codes are written one by one. Negative numbers work in NGL as plain "-5" and "-5--2" (checked).
 */
export function rangeSele(chain, i0, i1) {
  const rs = chain.residues, parts = [];
  let runStart = null, prev = null;
  const flush = () => {
    if (runStart === null) return;
    parts.push(runStart === prev ? String(prev) : runStart + '-' + prev);
    runStart = prev = null;
  };
  for (let i = i0; i <= i1; i++) {
    const r = rs[i];
    if (r.icode) {
      flush();
      parts.push(r.num + (r.icode ? '^' + r.icode : ''));
      continue;
    }
    if (prev !== null && r.num === prev + 1) prev = r.num;
    else { flush(); runStart = prev = r.num; }
  }
  flush();
  // a blank PDB chain id is named "_" by the API; NGL has no way to name it, so the residue numbers alone have to do
  const at = chain.name === '_' ? '' : ':' + chain.name;
  return parts.length ? '(' + parts.map((p) => p + at).join(' or ') + ')' : '';
}

// ----------------------------------------------------------------- the log ---

const sig = (o) => [o.type, o.chain, o.start, o.end, o.num, o.icode || '', o.to, o.target, o.text, o.status, o.note || ''].join('\u0001');

/** The shared log: ops confirmed by the server, plus our own ops that have been sent but not confirmed yet. */
export class OpLog {
  constructor(client) {
    this.client = client;
    this.ops = new Map(); // seq -> op
    this.seq = 0;
    this.pending = []; // {pid, op}
    this.nextPid = 1;
    this._folded = null;
  }

  /** Apply ops from the server (already in order). Returns true if anything new arrived. */
  addServerOps(list) {
    let changed = false;
    for (const op of list) {
      if (this.ops.has(op.seq)) continue;
      this.ops.set(op.seq, op);
      if (op.seq > this.seq) this.seq = op.seq;
      changed = true;
      if (op.client === this.client) {
        // Our own op came back through the log before its POST answered: it is no longer "pending".
        const i = this.pending.findIndex((p) => sig(p.op) === sig(op));
        if (i >= 0) this.pending.splice(i, 1);
      }
    }
    if (changed) this._folded = null;
    return changed;
  }

  addPending(op) {
    const p = { pid: this.nextPid++, op };
    this.pending.push(p);
    this._folded = null;
    return p;
  }
  /** The POST was answered: the real op replaces the pending one. */
  resolve(p, serverOp) {
    const i = this.pending.indexOf(p);
    if (i >= 0) this.pending.splice(i, 1);
    this.addServerOps([serverOp]);
    this._folded = null;
  }
  drop(p) {
    const i = this.pending.indexOf(p);
    if (i >= 0) this.pending.splice(i, 1);
    this._folded = null;
  }

  /** {annotations, mutations}: the newest edit/status/delete with target == seq wins. Pending ops count as newest. */
  folded() {
    if (this._folded) return this._folded;
    const ann = new Map(), mut = new Map();
    const apply = (o, key, pending) => {
      switch (o.type) {
        case 'annotation': ann.set(key, { key, seq: pending ? null : o.seq, chain: o.chain, start: o.start, end: o.end, text: o.text, author: o.author, client: o.client, ts: o.ts, pending }); break;
        case 'annotation_edit': { const a = ann.get(o.target); if (a) { a.text = o.text; a.edited = true; } break; }
        case 'annotation_delete': ann.delete(o.target); break;
        case 'mutation': mut.set(key, { key, seq: pending ? null : o.seq, chain: o.chain, num: o.num, icode: o.icode || '', from: o.from, to: o.to, note: o.note || '', author: o.author, client: o.client, ts: o.ts, status: 'proposed', pending }); break;
        case 'mutation_status': { const m = mut.get(o.target); if (m) m.status = o.status; break; }
        case 'mutation_delete': mut.delete(o.target); break;
        default: break; // an op type from a newer server: ignore
      }
    };
    [...this.ops.values()].sort((a, b) => a.seq - b.seq).forEach((o) => apply(o, o.seq, false));
    this.pending.forEach((p) => apply(p.op, 'p' + p.pid, true));
    return (this._folded = { annotations: [...ann.values()], mutations: [...mut.values()] });
  }
}

/** The mutation to show for a residue: the newest accepted one if there is one, else the newest proposed. */
export function mutationsByResidue(mutations) {
  const out = new Map(); // chain|num|icode -> {accepted, proposed}
  for (const m of mutations) {
    const k = m.chain + '|' + resKey(m.num, m.icode);
    const e = out.get(k) || {};
    if (m.status === 'accepted') e.accepted = m;
    else if (m.status === 'proposed') e.proposed = m;
    out.set(k, e);
  }
  return out;
}

export const sortedAnnotations = (list, residues) => [...list].sort((a, b) => {
  const ca = residues.chains.findIndex((c) => c.name === a.chain), cb = residues.chains.findIndex((c) => c.name === b.chain);
  return ca - cb || a.start - b.start || (a.seq ?? 1e12) - (b.seq ?? 1e12);
});

// --------------------------------------------------------------- identity ---

const rand = (n) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
};
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const randomId = (n) => [...rand(n)].map((b) => ALPHA[b % ALPHA.length]).join('');

function store(kind) {
  try { return kind === 'session' ? sessionStorage : localStorage; } catch { return null; }
}
export function remembered(key, make, kind = 'local') {
  const s = store(kind);
  let v = null;
  try { v = s && s.getItem(key); } catch { /* storage blocked */ }
  if (!v) {
    v = make();
    try { s && s.setItem(key, v); } catch { /* storage blocked: fine, just not remembered */ }
  }
  return v;
}
export function remember(key, value, kind = 'local') {
  try { store(kind)?.setItem(key, value); } catch { /* ignore */ }
}

export function recentRooms() {
  try {
    const l = JSON.parse(localStorage.getItem('protop.rooms') || '[]');
    return Array.isArray(l) ? l.filter((r) => r && /^[A-Za-z0-9_-]{22}$/.test(r.id)) : [];
  } catch { return []; }
}
export function rememberRoom(id, title) {
  const l = recentRooms().filter((r) => r.id !== id);
  l.unshift({ id, title: String(title || '').slice(0, 80), at: Date.now() });
  remember('protop.rooms', JSON.stringify(l.slice(0, 6)));
}
export function forgetRooms() {
  try { localStorage.removeItem('protop.rooms'); } catch { /* ignore */ }
}
