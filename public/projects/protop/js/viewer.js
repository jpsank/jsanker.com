// A thin wrapper around NGL (vendored in /vendor/ngl, loaded on demand as a classic script that defines `NGL`).
// Chain names and residue numbers are the author ones (auth_asym_id / auth_seq_id): that is what NGL's selection
// language (`:A and 42`) uses for both PDB and mmCIF files, and what the ProTop API speaks.

const NGL_SRC = '/vendor/ngl/ngl.js?v=2.5.0';
let nglPromise = null;

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

export function loadNGL() {
  if (window.NGL) return Promise.resolve(window.NGL);
  if (!nglPromise) {
    nglPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = NGL_SRC;
      s.onload = () => (window.NGL ? resolve(window.NGL) : reject(new Error('NGL did not initialise')));
      s.onerror = () => { nglPromise = null; reject(new Error('Could not load the 3D viewer')); };
      document.head.append(s);
    });
  }
  return nglPromise;
}

const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const baseColor = () => (dark() ? '#aab3bf' : '#8a94a3');
function pageBackground() {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
  return m ? '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('') : (dark() ? '#1e1e1e' : '#ffffff');
}

export class Viewer {
  /** Throws if WebGL or NGL is unavailable: callers show a plain message instead. */
  static async create(container, { onPick } = {}) {
    if (!webglAvailable()) throw new Error('This browser has no WebGL, which the 3D viewer needs.');
    const NGL = await loadNGL();
    return new Viewer(NGL, container, onPick);
  }

  constructor(NGL, container, onPick) {
    this.NGL = NGL;
    this.container = container;
    this.stage = new NGL.Stage(container, { backgroundColor: pageBackground(), tooltip: true });
    this.comp = null;
    this.baseRep = null;
    this.layers = new Map(); // key -> {style, sele, color, reps: []}
    this.bfactor = false;
    this.bfactorRange = null;
    if (onPick) {
      this.stage.signals.clicked.add((pp) => {
        const a = pp && pp.atom;
        if (a && !a.hetero) onPick({ chain: a.chainname, num: a.resno, icode: a.inscode || '', shift: !!pp.shiftKey });
      });
    }
    this.ro = new ResizeObserver(() => this.stage.handleResize());
    this.ro.observe(container);
    this.mq = matchMedia('(prefers-color-scheme: dark)');
    this.onScheme = () => {
      this.stage.setParameters({ backgroundColor: pageBackground() });
      this.applyBase();
    };
    this.mq.addEventListener('change', this.onScheme);
  }

  /** text: the coordinates; ext: 'pdb' or 'cif' */
  async load(text, ext = 'pdb') {
    const comp = await this.stage.loadFile(new Blob([text], { type: 'text/plain' }), { ext, defaultRepresentation: false });
    if (!comp) throw new Error('That file could not be read as a structure.');
    this.comp = comp;
    const atoms = comp.structure.atomCount;
    const quality = atoms > 60000 ? 'low' : 'auto';
    this.baseRep = comp.addRepresentation('cartoon', { sele: 'polymer', quality, ...this.baseParams() });
    comp.addRepresentation('ball+stick', { sele: 'hetero and not water', multipleBond: 'symmetric', radiusScale: 0.8, quality });
    const store = comp.structure.atomStore;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < store.count; i++) { const v = store.bfactor[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    this.bfactorRange = Number.isFinite(lo) && hi > lo ? [lo, hi] : null;
    this.stage.autoView();
    return { atoms, bfactorRange: this.bfactorRange };
  }

  baseParams() {
    return this.bfactor
      ? { colorScheme: 'bfactor', colorScale: 'RdYlBu', colorReverse: true }
      : { colorScheme: 'uniform', colorValue: baseColor() };
  }
  applyBase() { if (this.baseRep) this.baseRep.setParameters(this.baseParams()); }
  setBfactor(on) { this.bfactor = !!on; this.applyBase(); }

  /** list: [{key, sele, color, style: 'band' | 'sticks'}]; sele is an NGL selection string or '' for nothing. */
  setLayers(list) {
    if (!this.comp) return;
    const seen = new Set();
    for (const L of list) {
      if (!L.sele) continue;
      seen.add(L.key);
      const cur = this.layers.get(L.key);
      if (!cur) {
        const reps = L.style === 'sticks'
          ? [this.comp.addRepresentation('ball+stick', { sele: L.sele, colorScheme: 'uniform', colorValue: L.color, radiusScale: 1.1, aspectRatio: 1.4 })]
          : [
              this.comp.addRepresentation('cartoon', { sele: L.sele, colorScheme: 'uniform', colorValue: L.color, radiusScale: L.scale || 1.7, aspectRatio: 1.2 }),
              this.comp.addRepresentation('licorice', { sele: L.sele + ' and sidechainAttached', colorScheme: 'uniform', colorValue: L.color, radiusScale: 0.9 }),
            ];
        this.layers.set(L.key, { style: L.style, sele: L.sele, color: L.color, reps });
        continue;
      }
      if (cur.sele !== L.sele) {
        cur.reps[0].setSelection(L.sele);
        if (cur.reps[1]) cur.reps[1].setSelection(L.sele + ' and sidechainAttached');
        cur.sele = L.sele;
      }
      if (cur.color !== L.color) {
        for (const r of cur.reps) r.setParameters({ colorScheme: 'uniform', colorValue: L.color });
        cur.color = L.color;
      }
    }
    for (const [key, cur] of this.layers) {
      if (seen.has(key)) continue;
      for (const r of cur.reps) this.comp.removeRepresentation(r);
      this.layers.delete(key);
    }
  }

  focus(sele) { if (this.comp) this.comp.autoView(sele || '', 800); }
  resetView() { if (this.comp) this.comp.autoView(800); }

  dispose() {
    this.mq.removeEventListener('change', this.onScheme);
    this.ro.disconnect();
    this.stage.dispose();
    this.container.replaceChildren();
  }
}
