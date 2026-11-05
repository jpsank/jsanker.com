/* Generated cover art for the fictional tracks (the original showed real album covers).
   Each cover is drawn on a canvas from the track's hue/seed and returned as a data: URL. */
(function () {
  'use strict';

  function lcg(seed) {
    var s = seed >>> 0 || 1;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function hsl(h, s, l, a) { return 'hsla(' + ((h % 360 + 360) % 360) + ',' + s + '%,' + l + '%,' + (a === undefined ? 1 : a) + ')'; }

  function wrap(ctx, text, maxW) {
    var words = text.split(' '), lines = [], line = '';
    words.forEach(function (w) {
      var t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else { line = t; }
    });
    if (line) { lines.push(line); }
    return lines;
  }

  var art = {
    house: function (c, S, h, r) {
      for (var i = 0; i < 9; i++) {
        c.fillStyle = hsl(h + i * 9, 70, 22 + i * 4, 0.9);
        c.fillRect(0, S * 0.05 + i * S * 0.07, S, S * 0.045);
      }
      c.fillStyle = hsl(h + 180, 80, 60); c.beginPath(); c.arc(S * 0.5, S * 0.38, S * 0.17, 0, 7); c.fill();
    },
    synthwave: function (c, S, h, r) {
      var sun = c.createLinearGradient(0, S * 0.15, 0, S * 0.55);
      sun.addColorStop(0, hsl(h + 60, 90, 62)); sun.addColorStop(1, hsl(h - 30, 90, 55));
      c.fillStyle = sun; c.beginPath(); c.arc(S * 0.5, S * 0.4, S * 0.22, 0, 7); c.fill();
      c.fillStyle = hsl(h, 55, 10);
      for (var i = 0; i < 5; i++) { c.fillRect(S * 0.2, S * (0.4 + i * 0.03), S * 0.6, S * 0.006 * (i + 1)); }
      c.fillRect(0, S * 0.58, S, S * 0.42);
      c.strokeStyle = hsl(h + 40, 90, 60, 0.8); c.lineWidth = 2;
      for (var x = -6; x <= 6; x++) { c.beginPath(); c.moveTo(S * 0.5 + x * S * 0.03, S * 0.58); c.lineTo(S * 0.5 + x * S * 0.2, S); c.stroke(); }
      for (var y = 0; y < 5; y++) { var yy = S * (0.6 + 0.4 * Math.pow(y / 5, 2)); c.beginPath(); c.moveTo(0, yy); c.lineTo(S, yy); c.stroke(); }
    },
    chiptune: function (c, S, h, r) {
      var n = 12, p = S / n;
      for (var y = 0; y < n; y++) { for (var x = 0; x < n; x++) {
        if (r() < 0.35) { c.fillStyle = hsl(h + Math.floor(r() * 4) * 40, 80, 55 + r() * 15); c.fillRect(x * p, y * p, p - 2, p - 2); }
      } }
    },
    lofi: function (c, S, h, r) {
      c.fillStyle = hsl(h + 20, 40, 14); c.fillRect(S * 0.18, S * 0.12, S * 0.64, S * 0.5);
      var g = c.createLinearGradient(0, S * 0.14, 0, S * 0.6);
      g.addColorStop(0, hsl(h, 60, 45)); g.addColorStop(1, hsl(h + 40, 70, 70));
      c.fillStyle = g; c.fillRect(S * 0.21, S * 0.15, S * 0.58, S * 0.44);
      c.fillStyle = hsl(h + 60, 80, 85); c.beginPath(); c.arc(S * 0.62, S * 0.32, S * 0.06, 0, 7); c.fill();
      c.fillStyle = hsl(h + 20, 40, 14); c.fillRect(S * 0.49, S * 0.15, S * 0.02, S * 0.44); c.fillRect(S * 0.21, S * 0.36, S * 0.58, S * 0.02);
    },
    ambient: function (c, S, h, r) {
      for (var i = 8; i > 0; i--) {
        c.strokeStyle = hsl(h + i * 8, 60, 45 + i * 3, 0.55); c.lineWidth = S * 0.012;
        c.beginPath(); c.arc(S * (0.42 + r() * 0.16), S * (0.3 + r() * 0.1), S * i * 0.05, 0, 7); c.stroke();
      }
    }
  };

  function make(t, S) {
    S = S || 480;
    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var c = cv.getContext('2d');
    var r = lcg(t.seed), h = t.hue;

    var bg = c.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, hsl(h, 62, 40)); bg.addColorStop(1, hsl(h + 55, 66, 14));
    c.fillStyle = bg; c.fillRect(0, 0, S, S);
    (art[t.style] || art.ambient)(c, S, h, r);

    // title block, like the type on a real cover
    var shade = c.createLinearGradient(0, S * 0.62, 0, S);
    shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,0.78)');
    c.fillStyle = shade; c.fillRect(0, S * 0.62, S, S * 0.38);
    c.fillStyle = '#fff'; c.textBaseline = 'alphabetic';
    var size = S * 0.095;
    c.font = '800 ' + size + 'px Helvetica, Arial, sans-serif';
    var lines = wrap(c, t.title.toUpperCase(), S * 0.84);
    var y = S * 0.9 - (lines.length - 1) * size * 1.05 - size * 0.55;
    lines.forEach(function (l, i) { c.fillText(l, S * 0.08, y + i * size * 1.05); });
    c.font = '600 ' + (S * 0.042) + 'px Helvetica, Arial, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fillText(t.artist.toUpperCase(), S * 0.08, S * 0.94);
    return cv.toDataURL('image/jpeg', 0.88);
  }

  window.UMusicCover = make;
})();
