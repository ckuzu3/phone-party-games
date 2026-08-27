/*
 * Everything you hear is synthesised on the spot - no audio files to ship.
 * Impacts are a short noise burst through a band-pass plus a pitched "body"
 * tone; the crowd is filtered noise swelling and fading.
 */

class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.enabled = true;
  }

  /** Must be called from a user gesture the first time. */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      this._buildNoise();
    }
    if (this.ctx.state === "suspended") { this.ctx.resume(); }
  }

  setVolume(v) {
    if (this.master) { this.master.gain.value = v; }
  }

  _buildNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { data[i] = Math.random() * 2 - 1; }
    this.noiseBuf = buf;
  }

  _now() { return this.ctx.currentTime; }

  /** Pitched blip. */
  tone(freq, dur, opts) {
    if (!this._ready()) { return; }
    opts = opts || {};
    const t = this._now();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = opts.type || "sine";
    osc.frequency.setValueAtTime(freq, t);
    if (opts.slideTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t + dur);
    }
    const vol = opts.gain === undefined ? 0.3 : opts.gain;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Filtered noise burst - the basis of every impact. */
  noise(dur, freq, opts) {
    if (!this._ready()) { return; }
    opts = opts || {};
    const t = this._now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = opts.filter || "bandpass";
    filter.frequency.setValueAtTime(freq, t);
    if (opts.slideTo) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.slideTo), t + dur);
    }
    filter.Q.value = opts.q === undefined ? 1.2 : opts.q;
    const gain = this.ctx.createGain();
    const vol = opts.gain === undefined ? 0.3 : opts.gain;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + (opts.attack || 0.004));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  _ready() { return this.enabled && this.ctx && this.ctx.state === "running"; }

  // ---------------------------------------------------------- game sounds

  racket(power) {
    const p = 0.35 + power * 0.65;
    this.noise(0.09, 1900 + power * 1500, { gain: 0.32 * p, q: 0.8 });
    this.tone(320 + power * 260, 0.1, { type: "triangle", gain: 0.2 * p, slideTo: 150 });
  }

  bounce(strength) {
    const s = Math.min(1, strength);
    this.noise(0.07, 900, { gain: 0.16 * s, q: 1.6 });
    this.tone(190, 0.07, { type: "sine", gain: 0.1 * s, slideTo: 110 });
  }

  net() {
    this.noise(0.16, 420, { gain: 0.22, q: 0.6, filter: "lowpass" });
  }

  roll(power) {
    this.noise(0.9, 150, { gain: 0.13 * (0.5 + power * 0.5), q: 0.5,
                           filter: "lowpass", attack: 0.15, slideTo: 90 });
  }

  pinHit(strength) {
    const s = Math.min(1, strength);
    this.noise(0.13, 2600, { gain: 0.2 * s, q: 0.7 });
    this.tone(520 + Math.random() * 240, 0.16, { type: "triangle", gain: 0.14 * s, slideTo: 220 });
  }

  crash(strength) {
    this.noise(0.55, 1800, { gain: 0.3 * strength, q: 0.35, slideTo: 400, attack: 0.01 });
    this.tone(140, 0.4, { type: "sawtooth", gain: 0.12 * strength, slideTo: 60 });
  }

  punch(power) {
    this.noise(0.11, 380 + power * 300, { gain: 0.34 * (0.4 + power * 0.6),
                                          q: 0.8, filter: "lowpass" });
    this.tone(110, 0.13, { type: "sine", gain: 0.24 * power, slideTo: 55 });
  }

  block() {
    this.noise(0.09, 2900, { gain: 0.2, q: 2.4 });
  }

  whoosh() {
    this.noise(0.19, 700, { gain: 0.14, q: 0.5, slideTo: 2400, attack: 0.05 });
  }

  bell() {
    for (const f of [880, 1320, 1760]) {
      this.tone(f, 0.9, { type: "sine", gain: 0.12 });
    }
  }

  point(good) {
    if (good) {
      this.tone(660, 0.1, { type: "square", gain: 0.16 });
      setTimeout(() => this.tone(990, 0.16, { type: "square", gain: 0.16 }), 90);
    } else {
      this.tone(330, 0.14, { type: "square", gain: 0.14 });
      setTimeout(() => this.tone(220, 0.2, { type: "square", gain: 0.13 }), 110);
    }
  }

  select() { this.tone(880, 0.06, { type: "square", gain: 0.12 }); }
  move() { this.tone(560, 0.04, { type: "square", gain: 0.08 }); }

  // ---------------------------------------------------------- engine
  //
  // Unlike every other sound here the engine is continuous, so it is built
  // once and then just retuned each frame: two detuned saws through a
  // low-pass, with pitch following revs and cutoff following throttle.

  engineStart() {
    if (!this._ready() || this.engine) { return; }
    const t = this._now();
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.05, t + 0.3);

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(700, t);
    filter.Q.value = 3.5;

    const oscs = [];
    for (const detune of [0, 7]) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(70, t);
      osc.detune.setValueAtTime(detune, t);
      osc.connect(filter);
      osc.start(t);
      oscs.push(osc);
    }
    filter.connect(gain).connect(this.master);
    this.engine = { oscs, filter, gain };
  }

  /** revs and throttle both 0..1. */
  engineSet(revs, load) {
    if (!this.engine || !this._ready()) { return; }
    const t = this._now();
    const freq = 52 + revs * 210;
    for (const osc of this.engine.oscs) {
      osc.frequency.setTargetAtTime(freq, t, 0.05);
    }
    this.engine.filter.frequency.setTargetAtTime(420 + revs * 1700, t, 0.08);
    this.engine.gain.gain.setTargetAtTime(0.035 + load * 0.075, t, 0.08);
  }

  engineStop() {
    if (!this.engine) { return; }
    const t = this._now();
    const { oscs, gain } = this.engine;
    gain.gain.setTargetAtTime(0.0001, t, 0.08);
    for (const osc of oscs) { osc.stop(t + 0.5); }
    this.engine = null;
  }

  /** Tyre scrub - short bursts, retriggered while the car is sliding. */
  screech(amount) {
    this.noise(0.16, 1500 + amount * 1200, {
      gain: 0.05 + amount * 0.13, q: 1.4, attack: 0.03,
    });
  }

  crashInto(strength) {
    this.noise(0.28, 320, { gain: 0.26 * strength, q: 0.5, filter: "lowpass" });
    this.tone(90, 0.3, { type: "square", gain: 0.16 * strength, slideTo: 45 });
  }

  countdown(last) {
    this.tone(last ? 880 : 440, last ? 0.5 : 0.22, { type: "square", gain: 0.2 });
  }

  // ---------------------------------------------------------- shooting

  shot() {
    this.noise(0.22, 900, { gain: 0.34, q: 0.4, filter: "lowpass", slideTo: 180 });
    this.noise(0.08, 4200, { gain: 0.2, q: 0.8 });
    this.tone(70, 0.2, { type: "square", gain: 0.16, slideTo: 40 });
  }

  emptyClick() {
    this.noise(0.05, 2600, { gain: 0.16, q: 3 });
  }

  reload() {
    this.noise(0.07, 1700, { gain: 0.13, q: 2.5 });
    setTimeout(() => this.noise(0.07, 1200, { gain: 0.13, q: 2.5 }), 110);
  }

  quack() {
    const base = 300 + Math.random() * 120;
    this.tone(base, 0.11, { type: "sawtooth", gain: 0.1, slideTo: base * 0.65 });
    setTimeout(() => {
      this.tone(base * 0.9, 0.09, { type: "sawtooth", gain: 0.08, slideTo: base * 0.6 });
    }, 130);
  }

  feathers() {
    this.noise(0.3, 2200, { gain: 0.12, q: 0.6, slideTo: 700, attack: 0.01 });
  }

  splash() {
    this.noise(0.35, 1400, { gain: 0.16, q: 0.5, slideTo: 300, attack: 0.01 });
  }

  cheer(intensity) {
    if (!this._ready()) { return; }
    const t = this._now();
    const dur = 1.1 + intensity * 1.2;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(700, t);
    filter.frequency.linearRampToValueAtTime(1500, t + dur * 0.35);
    filter.frequency.linearRampToValueAtTime(600, t + dur);
    filter.Q.value = 0.7;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.16 * (0.4 + intensity * 0.6), t + 0.25);
    gain.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
}

export const sfx = new Sfx();
