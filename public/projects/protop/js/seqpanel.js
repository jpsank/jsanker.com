// The sequence panel: one block per chain, residues as buttons in rows of ten with the residue number at the start
// of each row. Click selects, shift-click extends; arrow keys move (shift+arrow extends), Home/End jump along the
// row, PageUp/PageDown move five rows, Escape clears. Other people's selections are drawn as coloured bars under
// the letters, annotations as a corner mark, mutations as a dashed (proposed) or replaced (accepted) letter.

import { h, clear } from './dom.js';
import { resLabel } from './room.js';

const ROW = 10;

export class SeqPanel {
  /**
   * @param {HTMLElement} root
   * @param {import('./room.js').Residues} residues
   * @param {{onPick: (chain: string, i: number, extend: boolean) => void, onClear: () => void}} cb
   */
  constructor(root, residues, cb) {
    this.root = root;
    this.residues = residues;
    this.cb = cb;
    this.cells = new Map(); // chain -> button[]
    this.focusIdx = new Map(); // chain -> index holding tabindex=0
    this.sel = null;
    this.selCells = [];
    this.applied = new Map(); // button -> signature of its marks
    this.build();
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button.rc');
      if (b && root.contains(b)) this.cb.onPick(b.dataset.chain, +b.dataset.i, e.shiftKey);
    });
    root.addEventListener('keydown', (e) => this.onKey(e));
  }

  build() {
    clear(this.root);
    for (const chain of this.residues.chains) {
      const rs = chain.residues;
      const cells = [];
      const body = h('div', { class: 'seq', role: 'group', 'aria-label': `Chain ${chain.name}, ${rs.length} residues` });
      for (let i = 0; i < rs.length; i += ROW) {
        const row = h('div', { class: 'srow' }, h('span', { class: 'snum', 'aria-hidden': 'true', text: resLabel(rs[i]) }));
        const wrap = h('span', { class: 'cells' });
        for (let j = i; j < Math.min(i + ROW, rs.length); j++) {
          const b = h('button', { type: 'button', class: 'rc', tabindex: j === 0 ? '0' : '-1', 'data-chain': chain.name, 'data-i': j, 'aria-pressed': 'false', text: rs[j].aa });
          b.setAttribute('aria-label', this.label(chain.name, j));
          cells.push(b);
          wrap.append(b);
        }
        row.append(wrap);
        body.append(row);
      }
      this.cells.set(chain.name, cells);
      this.focusIdx.set(chain.name, 0);
      this.root.append(h('section', { class: 'chain' }, h('h3', {}, 'Chain ' + chain.name, h('span', { class: 'muted small', text: ` · ${rs.length} residues` })), body));
    }
  }

  label(chain, i, extra = '') {
    const r = this.residues.at(chain, i);
    return `Chain ${chain}, residue ${r.aa}${resLabel(r)}${extra}`;
  }

  onKey(e) {
    const b = e.target.closest && e.target.closest('button.rc');
    if (!b) return;
    const chain = b.dataset.chain, i = +b.dataset.i, n = this.cells.get(chain).length;
    let to = null;
    switch (e.key) {
      case 'ArrowRight': to = i + 1; break;
      case 'ArrowLeft': to = i - 1; break;
      case 'ArrowDown': to = i + ROW; break;
      case 'ArrowUp': to = i - ROW; break;
      case 'PageDown': to = i + 5 * ROW; break;
      case 'PageUp': to = i - 5 * ROW; break;
      case 'Home': to = e.ctrlKey ? 0 : i - (i % ROW); break;
      case 'End': to = e.ctrlKey ? n - 1 : Math.min(n - 1, i - (i % ROW) + ROW - 1); break;
      case 'Escape': this.cb.onClear(); e.preventDefault(); return;
      default: return;
    }
    e.preventDefault();
    to = Math.max(0, Math.min(n - 1, to));
    if (to === i) return;
    if (e.shiftKey) {
      if (!this.sel || this.sel.chain !== chain) this.cb.onPick(chain, i, false);
      this.cb.onPick(chain, to, true);
    }
    this.focusCell(chain, to);
  }

  focusCell(chain, i, { focus = true } = {}) {
    const cells = this.cells.get(chain);
    if (!cells || !cells[i]) return;
    const prev = this.focusIdx.get(chain);
    if (cells[prev]) cells[prev].tabIndex = -1;
    cells[i].tabIndex = 0;
    this.focusIdx.set(chain, i);
    if (focus) cells[i].focus();
  }

  /** sel: {chain, lo, hi} or null */
  setSelection(sel) {
    for (const c of this.selCells) { c.classList.remove('sel'); c.setAttribute('aria-pressed', 'false'); }
    this.selCells = [];
    this.sel = sel;
    if (!sel) return;
    const cells = this.cells.get(sel.chain);
    if (!cells) return;
    for (let i = sel.lo; i <= sel.hi; i++) {
      cells[i].classList.add('sel');
      cells[i].setAttribute('aria-pressed', 'true');
      this.selCells.push(cells[i]);
    }
  }

  /**
   * marks: Map<chain, Map<index, {others: {color, name}[], ann: number, accepted?: string, proposed?: string}>>
   * Only cells whose marks changed are touched.
   */
  setMarks(marks) {
    const touched = new Set();
    for (const [chain, byIdx] of marks) {
      const cells = this.cells.get(chain);
      if (!cells) continue;
      for (const [i, m] of byIdx) {
        const b = cells[i];
        touched.add(b);
        this.paint(chain, i, b, m);
      }
    }
    for (const b of [...this.applied.keys()]) {
      if (!touched.has(b)) { this.paint(b.dataset.chain, +b.dataset.i, b, null); this.applied.delete(b); }
    }
  }

  paint(chain, i, b, m) {
    const sig = m ? [m.others.map((o) => o.color).join(','), m.ann, m.accepted || '', m.proposed || ''].join('|') : '';
    if ((this.applied.get(b) || '') === sig) return;
    if (m) this.applied.set(b, sig);
    const r = this.residues.at(chain, i);
    const shown = m && m.accepted ? m.accepted : r.aa;
    if (b.textContent !== shown) b.textContent = shown;
    b.classList.toggle('mut-acc', !!(m && m.accepted));
    b.classList.toggle('mut-prop', !!(m && !m.accepted && m.proposed));
    b.classList.toggle('has-ann', !!(m && m.ann));
    // other people's selections: stacked bars along the bottom edge (shadows are set through the CSSOM, which the CSP allows)
    b.style.boxShadow = m && m.others.length ? m.others.slice(0, 3).map((o, k) => `inset 0 -${3 * (k + 1)}px 0 ${o.color}`).join(', ') : '';
    const bits = [];
    if (m && m.accepted) bits.push(`, mutated to ${m.accepted} (accepted)`);
    else if (m && m.proposed) bits.push(`, mutation to ${m.proposed} proposed`);
    if (m && m.ann) bits.push(m.ann === 1 ? ', has an annotation' : `, has ${m.ann} annotations`);
    if (m && m.others.length) bits.push(', selected by ' + m.others.map((o) => o.name).join(' and '));
    b.setAttribute('aria-label', this.label(chain, i, bits.join('')));
  }

  /** Bring a residue into view inside the panel without moving the whole page. */
  scrollTo(chain, i) {
    const b = this.cells.get(chain)?.[i];
    if (!b) return;
    const box = this.root.closest('.scrollbox') || this.root;
    const rb = b.getBoundingClientRect(), bb = box.getBoundingClientRect();
    if (rb.top < bb.top + 8 || rb.bottom > bb.bottom - 8) box.scrollTop += rb.top - bb.top - bb.height / 3;
  }
}
