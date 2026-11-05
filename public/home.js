// Fidget spinner on the home page (ported from the old React FidgetWidget).
// Drag across it to spin; it coasts to a stop. Pointer events cover mouse, touch and pen.
(function () {
  'use strict';
  var canvas = document.getElementById('fidget');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var css = 100;                                   // CSS pixels
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = css * dpr;
  canvas.height = css * dpr;
  ctx.scale(dpr, dpr);

  var x = css / 2, y = css / 2, size = css / 2;
  var rot = 0, accel = 0, active = false;
  var GAIN = 1.15;       // a slight boost over the original (1.0): trackpad drags are slow and small
  var CARRY = 0.1;       // share of the current spin kept when a new move arrives, so small moves add up a little
  var MAX_SPIN = 1;      // radians per frame, so it can't strobe
  var FRICTION = 0.99;   // spin lost per frame, as in the original
  var COLORS = ['cyan', 'lime', 'yellow'];

  function stroke() {
    return getComputedStyle(canvas).color || 'black';
  }

  function draw() {
    ctx.clearRect(0, 0, css, css);
    ctx.strokeStyle = stroke();
    for (var i = 0; i < 3; i++) {
      var angle = i * 2 * Math.PI / 3;
      var nx = x - Math.cos(rot + angle) * (size * 4.8 / 6);
      var ny = y + Math.sin(rot + angle) * (size * 4.8 / 6);
      ctx.lineWidth = size * 2.4 / 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      ctx.lineWidth = 1;
      ctx.fillStyle = COLORS[i];
      ctx.beginPath();
      ctx.ellipse(nx, ny, size / 6, size / 6, 0, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.fillStyle = 'red';
    ctx.beginPath();
    ctx.ellipse(x, y, size / 5, size / 5, 0, 0, 2 * Math.PI);
    ctx.fill();
  }

  function pos(e) {
    var r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * css / r.width, (e.clientY - r.top) * css / r.height];
  }

  var down = false, last = null;

  // Angle (radians) swept around the hub when a point moves from a to b.
  function angleBetween(a, b) {
    var d = Math.atan2(-(b[1] - y), b[0] - x) - Math.atan2(-(a[1] - y), a[0] - x);
    if (d > Math.PI) d -= 2 * Math.PI;                  // don't jump when crossing the +/-pi seam
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  // Add a push. Keeping a little of the current spin makes many small movements build up
  // (a slow trackpad drag) instead of each one overwriting the last.
  function push(d) {
    accel = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, accel * CARRY + d * GAIN));
    active = true;
  }

  canvas.addEventListener('pointerdown', function (e) {
    down = true;
    last = pos(e);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not fatal */ }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!down) return;
    var p = pos(e);
    push(angleBetween(last, p));
    last = p;
  });
  function release() { down = false; }

  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  function frame() {
    requestAnimationFrame(frame);
    if (!active) return;
    rot += accel;
    accel *= FRICTION;
    if (Math.abs(accel) < 0.0001) { accel = 0; active = false; }
    draw();
  }

  draw();
  requestAnimationFrame(frame);
})();
