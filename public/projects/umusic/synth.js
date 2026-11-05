/* uMusic synth: turns a track's "score" into audio with the Web Audio API.
   No samples, no network. Everything is deterministic (seeded PRNG).

   build(track)  -> { events, duration }   pure; a list of timed notes and drum hits
   Engine        -> schedules those events a little ahead of the audio clock */
(function () {
  'use strict';

  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    pentatonic: [0, 2, 4, 7, 9]
  };

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function build(track) {
    var r = rng(track.seed);
    var ri = function (n) { return Math.floor(r() * n); };
    var scale = SCALES[track.scale];
    var n = scale.length;
    var beat = 60 / track.bpm;
    var ev = [];

    function midi(d) {
      var o = Math.floor(d / n);
      return track.root + scale[((d % n) + n) % n] + 12 * o;
    }
    // hold and decay are in beats / seconds; hold 0 = a plucked note
    function note(b, holdBeats, m, o) {
      var e = { kind: 'osc', t: b * beat, hold: holdBeats * beat, f: mtof(m),
                wave: 'sine', g: 0.1, a: 0.01, r: 0.15, lp: 0 };
      for (var k in o) { e[k] = o[k]; }
      ev.push(e);
    }
    function drum(b, kind, g) { ev.push({ kind: kind, t: b * beat, g: g }); }
    function chord(d, count) {
      var out = [];
      for (var i = 0; i < count; i++) { out.push(d + i * 2); }
      return out;
    }
    function walk(state) {
      state.d += [-2, -1, -1, 0, 1, 1, 2][ri(7)];
      state.d = Math.max(-2, Math.min(n + 3, state.d));
      return state.d;
    }
    var prog = function (bar) { return track.prog[bar % track.prog.length]; };

    var styles = {
      ambient: function () {
        for (var bar = 0; bar < track.bars; bar++) {
          var d = prog(bar), b0 = bar * 4;
          chord(d, 3).forEach(function (cd, i) {
            note(b0, 3.2, midi(cd) - (i === 0 ? 12 : 0),
                 { wave: i === 1 ? 'triangle' : 'sine', g: 0.07, a: 1.3, r: 1.8, lp: 1500 });
          });
          for (var s = 0; s < 8; s++) {
            if (r() < 0.38) {
              var bell = d + [0, 2, 4, n, n + 2][ri(5)];
              note(b0 + s * 0.5, 0, midi(bell) + 12, { g: 0.07, a: 0.01, r: 2.4 });
            }
          }
        }
      },

      chiptune: function () {
        var mel = { d: 2 };
        for (var bar = 0; bar < track.bars; bar++) {
          var d = prog(bar), b0 = bar * 4, ch = chord(d, 3);
          for (var s = 0; s < 16; s++) {
            note(b0 + s * 0.25, 0, midi(ch[s % 3]) + 12,
                 { wave: 'square', g: 0.035, a: 0.004, r: 0.09 });
          }
          for (var h = 0; h < 8; h++) {
            note(b0 + h * 0.5, 0, midi(d) - 24 + (h % 2 ? 12 : 0),
                 { wave: 'triangle', g: 0.2, a: 0.004, r: 0.2 });
          }
          if (bar >= 2) {
            for (var m = 0; m < 8; m++) {
              if (r() < 0.78) {
                note(b0 + m * 0.5, 0.25, midi(walk(mel) + d) + 12,
                     { wave: 'square', g: 0.05, a: 0.005, r: 0.12 });
              }
            }
          }
          for (var b = 0; b < 4; b++) {
            drum(b0 + b + 0.5, 'hat', 0.3);
            if (b % 2 === 1) { drum(b0 + b, 'snare', 0.28); } else { drum(b0 + b, 'kick', 0.7); }
          }
        }
      },

      house: function () {
        var mel = { d: 4 };
        for (var bar = 0; bar < track.bars; bar++) {
          var d = prog(bar), b0 = bar * 4, ch = chord(d, 3);
          for (var b = 0; b < 4; b++) {
            drum(b0 + b, 'kick', 0.95);
            drum(b0 + b + 0.5, 'hat', 0.45);
            if (b % 2 === 1 && bar >= 1) { drum(b0 + b, 'snare', 0.4); }
            note(b0 + b + 0.5, 0.15, midi(d) - 12,
                 { wave: 'sawtooth', g: 0.2, a: 0.005, r: 0.12, lp: 520 });
          }
          if (bar >= 2) {
            [0.5, 1.5, 2.5, 3.25].forEach(function (p) {
              ch.forEach(function (cd) {
                note(b0 + p, 0.1, midi(cd) + 12,
                     { wave: 'sawtooth', g: 0.028, a: 0.004, r: 0.22, lp: 2300 });
              });
            });
          }
          if (bar >= 8) {
            for (var m = 0; m < 4; m++) {
              if (r() < 0.65) {
                note(b0 + m, 0.2, midi(walk(mel) + d) + 12,
                     { wave: 'triangle', g: 0.09, a: 0.006, r: 0.25 });
              }
            }
          }
        }
      },

      lofi: function () {
        var mel = { d: 3 };
        for (var bar = 0; bar < track.bars; bar++) {
          var d = prog(bar), b0 = bar * 4, ch = chord(d, 4);
          [0, 2.5].forEach(function (p) {
            ch.forEach(function (cd, i) {
              note(b0 + p + i * 0.04, 1.2, midi(cd),
                   { wave: 'triangle', g: 0.06, a: 0.02, r: 0.9, lp: 1300 });
            });
          });
          note(b0, 1.5, midi(d) - 12, { g: 0.2, a: 0.02, r: 0.4 });
          drum(b0, 'kick', 0.7);
          drum(b0 + 2.5, 'kick', 0.6);
          drum(b0 + 1, 'snare', 0.3);
          drum(b0 + 3, 'snare', 0.3);
          for (var h = 0; h < 8; h++) { drum(b0 + h * 0.5, 'hat', h % 2 ? 0.18 : 0.28); }
          for (var m = 0; m < 8; m++) {
            if (r() < 0.32) {
              note(b0 + m * 0.5, 0.1, midi(walk(mel) + d) + 12,
                   { g: 0.08, a: 0.01, r: 0.7 });
            }
          }
        }
      },

      synthwave: function () {
        var order = [0, 1, 2, 1];
        for (var bar = 0; bar < track.bars; bar++) {
          var d = prog(bar), b0 = bar * 4, ch = chord(d, 3);
          chord(d, 3).forEach(function (cd) {
            note(b0, 3.6, midi(cd), { wave: 'sawtooth', g: 0.025, a: 0.5, r: 0.7, lp: 900 });
          });
          for (var s = 0; s < 8; s++) {
            note(b0 + s * 0.5, 0.1, midi(d) - 12,
                 { wave: 'sawtooth', g: 0.17, a: 0.005, r: 0.12, lp: 600 });
            if (bar >= 1) {
              note(b0 + s * 0.5, 0, midi(ch[order[s % 4]]) + 12,
                   { wave: 'sawtooth', g: 0.04, a: 0.005, r: 0.35, lp: 2800 });
            }
          }
          drum(b0, 'kick', 0.9);
          drum(b0 + 2, 'kick', 0.8);
          drum(b0 + 2.75, 'kick', 0.5);
          drum(b0 + 1, 'snare', 0.42);
          drum(b0 + 3, 'snare', 0.42);
          for (var h = 0; h < 8; h++) { drum(b0 + h * 0.5 + 0.25, 'hat', 0.2); }
        }
      }
    };

    styles[track.style]();
    ev.sort(function (a, b) { return a.t - b.t; });
    return { events: ev, duration: track.bars * 4 * beat };
  }

  function Engine() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.volume = 0.7;
    this.track = null;
    this.song = null;
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.idx = 0;
    this.bus = null;
    this.sources = [];
    this.timer = null;
    this.onEnded = null;
  }

  Engine.supported = !!(window.AudioContext || window.webkitAudioContext);

  Engine.prototype.ensure = function () {
    if (this.ctx) { return this.ctx; }
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    var comp = ctx.createDynamicsCompressor();
    var master = ctx.createGain();
    master.connect(comp);
    comp.connect(ctx.destination);
    var buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    var data = buf.getChannelData(0), nr = rng(7);
    for (var i = 0; i < data.length; i++) { data[i] = nr() * 2 - 1; }
    this.ctx = ctx;
    this.master = master;
    this.noise = buf;
    this.setVolume(this.volume);
    return ctx;
  };

  // slider position 0..1 -> gain; squared so the slider feels even, and capped low
  Engine.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.master) { this.master.gain.value = v * v * 0.55; }
  };

  Engine.prototype.load = function (track) {
    this.stopSound(true);
    this.track = track;
    this.song = build(track);
    this.offset = 0;
    this.playing = false;
  };

  Engine.prototype.duration = function () { return this.song ? this.song.duration : 0; };

  Engine.prototype.position = function () {
    if (!this.playing) { return this.offset; }
    var p = this.offset + Math.max(0, this.ctx.currentTime - this.startedAt);
    return Math.min(p, this.song.duration);
  };

  // Must be called from a user gesture the first time (creates / resumes the context).
  Engine.prototype.play = function () {
    if (!this.song || this.playing) { return Promise.resolve(); }
    var self = this;
    var ctx = this.ensure();
    var go = function () { if (!self.playing) { self.startAt(self.offset); } };
    if (ctx.state === 'suspended') { return ctx.resume().then(go); }
    go();
    return Promise.resolve();
  };

  Engine.prototype.pause = function () {
    if (!this.playing) { return; }
    this.offset = this.position();
    this.stopSound(true);
  };

  Engine.prototype.seek = function (s) {
    s = Math.max(0, Math.min(this.duration() - 0.05, s));
    if (this.playing) { this.startAt(s); } else { this.offset = s; }
  };

  Engine.prototype.startAt = function (off) {
    var self = this;
    this.stopSound(true);
    this.bus = this.ctx.createGain();
    this.bus.connect(this.master);
    this.sources = [];
    this.offset = off;
    this.startedAt = this.ctx.currentTime + 0.05;
    this.idx = 0;
    this.playing = true;
    this.pump();
    this.timer = setInterval(function () { self.pump(); }, 100);
  };

  Engine.prototype.pump = function () {
    var ctx = this.ctx, song = this.song;
    var now = this.offset + (ctx.currentTime - this.startedAt);
    var horizon = now + 1.5;
    while (this.idx < song.events.length && song.events[this.idx].t < horizon) {
      this.schedule(song.events[this.idx++]);
    }
    if (now >= song.duration) {
      // natural end: let the last notes ring out, then hand over
      var bus = this.bus;
      clearInterval(this.timer);
      this.timer = null;
      this.playing = false;
      this.offset = 0;
      this.bus = null;
      this.sources = [];
      setTimeout(function () { try { bus.disconnect(); } catch (e) { /* already gone */ } }, 5000);
      if (this.onEnded) { this.onEnded(); }
    }
  };

  Engine.prototype.schedule = function (e) {
    var ctx = this.ctx;
    var when = this.startedAt + (e.t - this.offset);
    var late = e.t < this.offset;  // started before a seek point
    var tNow = ctx.currentTime;
    if (e.kind === 'osc') {
      var end = e.t + Math.max(e.a, e.hold) + e.r;
      if (late && end <= this.offset) { return; }
      this.voice(e, late ? this.startedAt : Math.max(when, tNow), late ? e.t + Math.max(e.a, e.hold) - this.offset : null);
    } else {
      if (late) { return; }
      this.hit(e, Math.max(when, tNow));
    }
  };

  Engine.prototype.track_source = function (src) {
    var self = this;
    this.sources.push(src);
    src.onended = function () {
      var i = self.sources.indexOf(src);
      if (i >= 0) { self.sources.splice(i, 1); }
    };
  };

  // one oscillator note: attack -> hold -> exponential release
  Engine.prototype.voice = function (e, at, remainingHold) {
    var ctx = this.ctx;
    var osc = ctx.createOscillator();
    var env = ctx.createGain();
    var a = remainingHold === null ? e.a : Math.min(e.a, 0.03);
    var hold = remainingHold === null ? Math.max(e.a, e.hold) : Math.max(a, remainingHold);
    osc.type = e.wave;
    osc.frequency.value = e.f;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(e.g, at + a);
    env.gain.setValueAtTime(e.g, at + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, at + hold + e.r);
    var out = osc;
    if (e.lp) {
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = e.lp;
      osc.connect(f);
      out = f;
    }
    out.connect(env);
    env.connect(this.bus);
    osc.start(at);
    osc.stop(at + hold + e.r + 0.05);
    this.track_source(osc);
  };

  Engine.prototype.hit = function (e, at) {
    var ctx = this.ctx, bus = this.bus;
    if (e.kind === 'kick') {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(130, at);
      o.frequency.exponentialRampToValueAtTime(42, at + 0.12);
      g.gain.setValueAtTime(e.g * 0.8, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      o.connect(g); g.connect(bus);
      o.start(at); o.stop(at + 0.35);
      this.track_source(o);
      return;
    }
    var src = ctx.createBufferSource();
    var filt = ctx.createBiquadFilter();
    var gn = ctx.createGain();
    src.buffer = this.noise;
    if (e.kind === 'hat') {
      filt.type = 'highpass'; filt.frequency.value = 7500;
      gn.gain.setValueAtTime(e.g * 0.35, at);
      gn.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    } else { // snare / clap
      filt.type = 'bandpass'; filt.frequency.value = 1900; filt.Q.value = 0.7;
      gn.gain.setValueAtTime(e.g * 0.7, at);
      gn.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    }
    src.connect(filt); filt.connect(gn); gn.connect(bus);
    src.start(at); src.stop(at + 0.2);
    this.track_source(src);
  };

  // Stop everything now (short fade so there is no click).
  Engine.prototype.stopSound = function (fast) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.playing = false;
    var bus = this.bus, srcs = this.sources;
    this.bus = null;
    this.sources = [];
    if (!bus || !this.ctx) { return; }
    var t = this.ctx.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(bus.gain.value, t);
    bus.gain.linearRampToValueAtTime(0, t + (fast ? 0.04 : 0.3));
    srcs.forEach(function (s) { try { s.stop(t + 0.06); } catch (e) { /* not started */ } });
    setTimeout(function () { try { bus.disconnect(); } catch (e) { /* already gone */ } }, 400);
  };

  window.UMusicSynth = { build: build, Engine: Engine };
})();
