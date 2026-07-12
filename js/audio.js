/* audio.js — 100% synthesized sound via Web Audio (no asset files, works offline).
 * Calm Vegas-lounge ambient pad on a loop + tactile SFX. Music and SFX toggle
 * independently. Must be init()'d from a user gesture (browser autoplay policy). */
window.RK = window.RK || {};

(function (RK) {
  'use strict';

  const A = { ctx: null, master: null, musicGain: null, sfxGain: null,
    musicOn: true, sfxOn: true, musicTimer: null, started: false };

  A.init = function () {
    if (A.ctx) { if (A.ctx.state === 'suspended') A.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    A.ctx = new Ctx();
    A.master = A.ctx.createGain(); A.master.gain.value = 0.9; A.master.connect(A.ctx.destination);
    A.musicGain = A.ctx.createGain(); A.musicGain.gain.value = A.musicOn ? 0.18 : 0; A.musicGain.connect(A.master);
    A.sfxGain = A.ctx.createGain(); A.sfxGain.gain.value = A.sfxOn ? 0.9 : 0; A.sfxGain.connect(A.master);
    startMusic();
  };

  function now() { return A.ctx.currentTime; }

  // ---- Ambient pad ----------------------------------------------------------
  // A slow ii–V–I-ish lounge loop in warm sine/triangle voices through a gentle
  // lowpass + feedback delay for air.
  const CHORDS = [
    [220.00, 261.63, 329.63],   // Am
    [246.94, 293.66, 349.23],   // Dm
    [196.00, 246.94, 293.66],   // G
    [261.63, 329.63, 392.00],   // C
  ];

  function startMusic() {
    if (!A.ctx || A.started) return;
    A.started = true;
    const lp = A.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
    const delay = A.ctx.createDelay(); delay.delayTime.value = 0.38;
    const fb = A.ctx.createGain(); fb.gain.value = 0.28;
    delay.connect(fb); fb.connect(delay);
    lp.connect(A.musicGain); lp.connect(delay); delay.connect(A.musicGain);

    let i = 0;
    const dur = 4.0;
    const schedule = () => {
      const t = now();
      const chord = CHORDS[i % CHORDS.length];
      chord.forEach((f, vi) => {
        const o = A.ctx.createOscillator();
        o.type = vi === 0 ? 'triangle' : 'sine';
        o.frequency.value = f;
        const g = A.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.22, t + 0.8);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(lp);
        o.start(t); o.stop(t + dur + 0.05);
      });
      i++;
    };
    schedule();
    A.musicTimer = setInterval(schedule, dur * 1000);
  }

  // ---- SFX ------------------------------------------------------------------
  function env(g, t, a, d, peak) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function noiseBuffer(len) {
    const buf = A.ctx.createBuffer(1, len, A.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  const SFX = {
    place() { // wooden "thock"
      const t = now();
      const o = A.ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.09);
      const g = A.ctx.createGain(); env(g, t, 0.004, 0.09, 0.6);
      o.connect(g); g.connect(A.sfxGain); o.start(t); o.stop(t + 0.12);
      const n = A.ctx.createBufferSource(); n.buffer = noiseBuffer(1200);
      const nf = A.ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 1800;
      const ng = A.ctx.createGain(); env(ng, t, 0.002, 0.03, 0.25);
      n.connect(nf); nf.connect(ng); ng.connect(A.sfxGain); n.start(t); n.stop(t + 0.05);
    },
    button() {
      const t = now();
      const o = A.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 520;
      const g = A.ctx.createGain(); env(g, t, 0.003, 0.06, 0.3);
      o.connect(g); g.connect(A.sfxGain); o.start(t); o.stop(t + 0.09);
    },
    draw() {
      const t = now();
      const o = A.ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(300, t);
      o.frequency.exponentialRampToValueAtTime(600, t + 0.08);
      const g = A.ctx.createGain(); env(g, t, 0.003, 0.08, 0.35);
      o.connect(g); g.connect(A.sfxGain); o.start(t); o.stop(t + 0.12);
    },
    invalid() {
      const t = now();
      const o = A.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(80, t + 0.2);
      const g = A.ctx.createGain(); env(g, t, 0.004, 0.22, 0.3);
      const lp = A.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
      o.connect(lp); lp.connect(g); g.connect(A.sfxGain); o.start(t); o.stop(t + 0.26);
    },
    shuffle() {
      const t = now();
      const n = A.ctx.createBufferSource(); n.buffer = noiseBuffer(A.ctx.sampleRate * 0.5);
      const bp = A.ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.setValueAtTime(600, t); bp.frequency.linearRampToValueAtTime(3000, t + 0.45);
      const g = A.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.3, t + 0.06); g.gain.linearRampToValueAtTime(0.0001, t + 0.5);
      n.connect(bp); bp.connect(g); g.connect(A.sfxGain); n.start(t); n.stop(t + 0.52);
    },
    victory() {
      const seq = [523.25, 659.25, 783.99, 1046.50];
      seq.forEach((f, i) => {
        const t = now() + i * 0.12;
        const o = A.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
        const g = A.ctx.createGain(); env(g, t, 0.01, 0.3, 0.4);
        o.connect(g); g.connect(A.sfxGain); o.start(t); o.stop(t + 0.35);
      });
    },
  };

  A.play = function (name) { if (A.ctx && A.sfxOn && SFX[name]) { try { SFX[name](); } catch (e) {} } };
  A.setMusic = function (on) { A.musicOn = on; if (A.musicGain) A.musicGain.gain.value = on ? 0.18 : 0; };
  A.setSfx = function (on) { A.sfxOn = on; if (A.sfxGain) A.sfxGain.gain.value = on ? 0.9 : 0; };

  RK.audio = A;
})(window.RK);
