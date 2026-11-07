// Tiny DOM helpers shared by the ProTop pages. Text only ever goes in through textContent / text nodes,
// never innerHTML, because most of it comes from the API or from other visitors.

/** h('div', {class: 'x', text: 'hi', onclick: fn, 'aria-label': 'y'}, child, 'text child', ...) */
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

export const $ = (id) => document.getElementById(id);

export function clear(el) {
  el.replaceChildren();
  return el;
}

export const fmt = (n) => Number(n).toLocaleString('en-US');

/** "3_1" or "31" -> "3.1" (crossings, then which knot of that size); "3_1#3_1" is a composite of two: "3.1#3.1". Else as is. */
export function knotLabel(v) {
  const one = (p) => {
    const m = /^(\d{1,2})_(\d{1,2})$/.exec(p) || /^(\d)(\d)$/.exec(p);
    return m ? m[1] + '.' + m[2] : p;
  };
  return String(v ?? '').trim().split('#').map(one).join('#');
}

/** The old backend returned pandas shapes: a value may be a scalar, a list, or {index: value}. Make it text. */
export function flat(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return [...new Set(v.map(flat).filter(Boolean))].join(', ');
  if (typeof v === 'object') return flat(Object.values(v));
  return String(v);
}

export function relTime(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + ' s ago';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}

/** A status line that screen readers announce politely. */
export function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
