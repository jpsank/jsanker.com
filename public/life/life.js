/* /life/ — Conway's Game of Life on a toroidal grid, seeded from /api/pattern.php.
   Plain script, no dependencies. parseRLE() is exported for Node tests. */
(function () {
  'use strict';

  var COLS = 160;
  var ROWS = 100;
  var MAX_LIVE_CELLS = 500000;   // parser safety valve
  var MAX_COORD = 100000;        // ignore anything further out than this
  var FALLBACK_RLE = '#N R-pentomino\nx = 3, y = 3, rule = B3/S23\nb2o$2ob$bo!';

  // ------------------------------------------------------------- RLE ---

  /**
   * Parse a Golly/LifeWiki RLE file.
   * Returns { name, rule, width, height, cells } where cells is a flat array
   * [x0, y0, x1, y1, ...] of live cells relative to the pattern's top-left, and
   * width/height are the bounding box of those cells. Never throws on bad input;
   * an unusable file simply yields no cells.
   */
  function parseRLE(text) {
    var name = '';
    var rule = '';
    var sawHeader = false;
    var cells = [];
    var maxX = -1;
    var maxY = -1;
    var x = 0;
    var y = 0;
    var count = 0;      // pending run length (0 = none given)
    var done = false;

    var lines = String(text).split(/\r\n|\r|\n/);
    for (var li = 0; li < lines.length && !done; li++) {
      var line = lines[li].trim();
      if (line === '') continue;

      if (line.charAt(0) === '#') {
        var m = /^#N\s+(.*)$/.exec(line);
        if (m && !name) name = m[1].trim();
        continue;
      }
      if (!sawHeader && /^x\s*=/i.test(line)) {
        sawHeader = true;
        var r = /rule\s*=\s*([^\s,]+)/i.exec(line);
        if (r) rule = r[1];
        continue;
      }

      for (var i = 0; i < line.length; i++) {
        var ch = line.charCodeAt(i);
        if (ch >= 48 && ch <= 57) {                       // 0-9
          count = Math.min(count * 10 + (ch - 48), 1000000);
          continue;
        }
        var n = count > 0 ? count : 1;
        count = 0;
        if (ch === 33) { done = true; break; }            // !
        if (ch === 36) { y += n; x = 0; continue; }      // $ (n line breaks)
        if (ch === 98 || ch === 46) { x += n; continue; } // b or . = dead
        if (ch === 111 || (ch >= 65 && ch <= 90)) {       // o or A-Z = alive
          if (x < MAX_COORD && y < MAX_COORD) {
            var end = Math.min(x + n, MAX_COORD);
            for (var k = x; k < end; k++) cells.push(k, y);
            if (end - 1 > maxX) maxX = end - 1;
            if (y > maxY) maxY = y;
          }
          x += n;
          if (cells.length > MAX_LIVE_CELLS * 2) { done = true; break; }
          continue;
        }
        // anything else (whitespace, lowercase state prefixes, ...) is ignored
      }
    }

    return { name: name, rule: rule, width: maxX + 1, height: maxY + 1, cells: cells };
  }

  /** "B3/S23" or legacy "23/3" -> { birth: Uint8Array(9), survive: Uint8Array(9) }, else null. */
  function parseRule(rule) {
    var m = /^B([0-8]*)\/S([0-8]*)$/i.exec(rule);
    var b;
    var s;
    if (m) { b = m[1]; s = m[2]; }
    else if ((m = /^S([0-8]*)\/B([0-8]*)$/i.exec(rule))) { s = m[1]; b = m[2]; }
    else {
      m = /^([0-8]*)\/([0-8]*)$/.exec(rule);   // legacy survive/birth
      if (!m) return null;
      s = m[1]; b = m[2];
    }
    var birth = new Uint8Array(9);
    var survive = new Uint8Array(9);
    for (var i = 0; i < b.length; i++) birth[+b[i]] = 1;
    for (var j = 0; j < s.length; j++) survive[+s[j]] = 1;
    return { birth: birth, survive: survive };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseRLE: parseRLE, parseRule: parseRule };
  }
  if (typeof document === 'undefined') return;

  // ------------------------------------------------------------ world ---

  var LIFE = parseRule('B3/S23');
  var birth = LIFE.birth;
  var survive = LIFE.survive;
  var cur = new Uint8Array(COLS * ROWS);
  var nxt = new Uint8Array(COLS * ROWS);
  var generation = 0;
  var population = 0;

  function countPopulation() {
    var p = 0;
    for (var i = 0; i < cur.length; i++) p += cur[i];
    population = p;
  }

  function step() {
    var p = 0;
    for (var y = 0; y < ROWS; y++) {
      var up = (y === 0 ? ROWS - 1 : y - 1) * COLS;
      var mid = y * COLS;
      var dn = (y === ROWS - 1 ? 0 : y + 1) * COLS;
      for (var x = 0; x < COLS; x++) {
        var l = x === 0 ? COLS - 1 : x - 1;
        var r = x === COLS - 1 ? 0 : x + 1;
        var n = cur[up + l] + cur[up + x] + cur[up + r] +
                cur[mid + l] + cur[mid + r] +
                cur[dn + l] + cur[dn + x] + cur[dn + r];
        var alive = cur[mid + x] ? survive[n] : birth[n];
        nxt[mid + x] = alive;
        p += alive;
      }
    }
    var t = cur; cur = nxt; nxt = t;
    population = p;
    generation++;
  }

  // ----------------------------------------------------------- canvas ---

  var canvas = document.getElementById('life-canvas');
  var statusEl = document.getElementById('life-status');
  var playBtn = document.getElementById('life-play');
  var stepBtn = document.getElementById('life-step');
  var randomBtn = document.getElementById('life-random');
  var clearBtn = document.getElementById('life-clear');
  var speedEl = document.getElementById('life-speed');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');

  var cellPx = 4;
  var colors = { alive: '#111', dead: '#f4f4f4' };

  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    colors.alive = cs.getPropertyValue('--fg').trim() || colors.alive;
    colors.dead = cs.getPropertyValue('--accent-bg').trim() || colors.dead;
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var s = Math.max(1, Math.floor((canvas.clientWidth * dpr) / COLS));
    if (s === cellPx && canvas.width === COLS * s) return;
    cellPx = s;
    canvas.width = COLS * s;
    canvas.height = ROWS * s;
    draw();
  }

  function draw() {
    var s = cellPx;
    var gap = s >= 4 ? 1 : 0;
    ctx.fillStyle = colors.dead;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = colors.alive;
    for (var y = 0; y < ROWS; y++) {
      var row = y * COLS;
      for (var x = 0; x < COLS; x++) {
        if (cur[row + x]) ctx.fillRect(x * s, y * s, s - gap, s - gap);
      }
    }
    renderStatus();
  }

  // ----------------------------------------------------------- status ---

  var patternName = '';
  var patternNote = '';

  function renderStatus() {
    var parts = [];
    if (patternName) parts.push(patternName);
    parts.push('generation ' + generation);
    parts.push(population + (population === 1 ? ' cell' : ' cells'));
    var text = parts.join(' · ');
    if (patternNote) text += ' · ' + patternNote;
    if (statusEl.textContent !== text) statusEl.textContent = text;
  }

  // ----------------------------------------------------------- loading ---

  function clearGrid() {
    cur.fill(0);
    nxt.fill(0);
    generation = 0;
    population = 0;
  }

  /** Put a parsed pattern in the middle of an empty grid. Returns false if it had no cells. */
  function place(p, fallbackName) {
    if (!p.cells.length) return false;
    clearGrid();
    var ox = Math.max(0, Math.floor((COLS - p.width) / 2));
    var oy = Math.max(0, Math.floor((ROWS - p.height) / 2));
    var cropped = false;
    for (var i = 0; i < p.cells.length; i += 2) {
      var gx = p.cells[i] + ox;
      var gy = p.cells[i + 1] + oy;
      if (gx >= COLS || gy >= ROWS) { cropped = true; continue; }
      cur[gy * COLS + gx] = 1;
    }
    countPopulation();

    var rule = parseRule(p.rule);
    var notes = [];
    if (p.rule && !rule) notes.push('rule ' + p.rule + ' not supported, using B3/S23');
    if (rule) { birth = rule.birth; survive = rule.survive; }
    else { birth = LIFE.birth; survive = LIFE.survive; }
    if (rule && (String(rule.birth) !== String(LIFE.birth) || String(rule.survive) !== String(LIFE.survive))) notes.push('rule ' + p.rule);
    if (cropped) notes.push('pattern is ' + p.width + '×' + p.height + ', showing the top-left ' + COLS + '×' + ROWS);

    patternName = p.name || fallbackName || 'untitled pattern';
    patternNote = notes.join(' · ');
    return true;
  }

  var loadToken = 0;

  function loadRandom(attempt) {
    attempt = typeof attempt === 'number' ? attempt : 0;
    var token = ++loadToken;
    statusEl.textContent = 'Loading a pattern…';
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : 0;

    fetch('/api/pattern.php', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var file = (res.headers.get('X-Pattern-Name') || '').replace(/\.rle$/i, '');
        return res.text().then(function (t) { return { text: t, file: file }; });
      })
      .then(function (d) {
        if (token !== loadToken) return;
        if (!place(parseRLE(d.text), d.file)) {
          if (attempt < 3) { loadRandom(attempt + 1); return; }   // e.g. the library's blank "empty" pattern
          throw new Error('empty pattern');
        }
      })
      .catch(function () {
        if (token !== loadToken) return;
        place(parseRLE(FALLBACK_RLE), '');
        patternNote = 'could not load a pattern, showing an R-pentomino';
      })
      .then(function () {
        clearTimeout(timer);
        if (token !== loadToken) return;
        draw();
      });
  }

  // ---------------------------------------------------------- running ---

  var paused = false;
  var rafId = 0;
  var lastTime = 0;
  var acc = 0;

  function speed() { return Math.max(1, Number(speedEl.value) || 15); }

  function frame(now) {
    rafId = 0;
    if (paused || document.hidden) return;
    var dt = lastTime ? Math.min(now - lastTime, 250) : 0;
    lastTime = now;
    acc += dt;
    var interval = 1000 / speed();
    var steps = 0;
    while (acc >= interval && steps < 8) { step(); acc -= interval; steps++; }
    if (steps) draw();
    rafId = requestAnimationFrame(frame);
  }

  function ensureRunning() {
    if (rafId || paused || document.hidden) return;
    lastTime = 0;
    acc = 0;
    rafId = requestAnimationFrame(frame);
  }

  function setPaused(v) {
    paused = v;
    playBtn.textContent = paused ? 'play' : 'pause';
    if (paused) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    } else {
      ensureRunning();
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    } else {
      ensureRunning();
    }
  });

  playBtn.addEventListener('click', function () { setPaused(!paused); });
  stepBtn.addEventListener('click', function () { setPaused(true); step(); draw(); });
  randomBtn.addEventListener('click', function () { loadRandom(0); });
  clearBtn.addEventListener('click', function () {
    loadToken++;               // cancel any pattern still loading
    clearGrid();
    patternName = 'empty grid';
    patternNote = 'click or drag to draw';
    draw();
  });

  // ---------------------------------------------------------- drawing ---

  var painting = false;
  var paintValue = 1;
  var lastCell = null;

  function cellAt(ev) {
    var rect = canvas.getBoundingClientRect();
    var w = canvas.clientWidth || 1;
    var h = canvas.clientHeight || 1;
    var x = Math.floor(((ev.clientX - rect.left - canvas.clientLeft) / w) * COLS);
    var y = Math.floor(((ev.clientY - rect.top - canvas.clientTop) / h) * ROWS);
    return { x: Math.min(COLS - 1, Math.max(0, x)), y: Math.min(ROWS - 1, Math.max(0, y)) };
  }

  function setCell(x, y, v) {
    var i = y * COLS + x;
    if (cur[i] === v) return;
    cur[i] = v;
    population += v ? 1 : -1;
  }

  /** Set every cell on the line from a to b (Bresenham). */
  function paintLine(a, b, v) {
    var dx = Math.abs(b.x - a.x);
    var dy = -Math.abs(b.y - a.y);
    var sx = a.x < b.x ? 1 : -1;
    var sy = a.y < b.y ? 1 : -1;
    var err = dx + dy;
    var x = a.x;
    var y = a.y;
    for (;;) {
      setCell(x, y, v);
      if (x === b.x && y === b.y) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    var c = cellAt(ev);
    painting = true;
    paintValue = cur[c.y * COLS + c.x] ? 0 : 1;   // first cell decides draw vs erase
    lastCell = c;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not fatal */ }
    paintLine(c, c, paintValue);
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (!painting) return;
    var c = cellAt(ev);
    if (lastCell && c.x === lastCell.x && c.y === lastCell.y) return;
    paintLine(lastCell || c, c, paintValue);
    lastCell = c;
    draw();
  });

  function stopPainting() { painting = false; lastCell = null; }
  canvas.addEventListener('pointerup', stopPainting);
  canvas.addEventListener('pointercancel', stopPainting);

  // ------------------------------------------------------------- init ---

  var scheme = window.matchMedia('(prefers-color-scheme: dark)');
  var onScheme = function () { readColors(); draw(); };
  if (scheme.addEventListener) scheme.addEventListener('change', onScheme);
  else if (scheme.addListener) scheme.addListener(onScheme);

  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setPaused(true);
  }

  readColors();
  resize();
  draw();
  loadRandom(0);
  ensureRunning();
})();
