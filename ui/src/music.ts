// Menu music: an original loop played by Web Audio, so there are no files and no licences.
// D major at 88 bpm, D - Bm - G - A two bars each: a pad, an arpeggio through a dotted-eighth
// echo, a bass from bar 5, drums from bar 9; the arpeggio's pattern changes every 8 bars and
// the 32-bar form drops the drums at its end. A 16th-note scheduler runs a little ahead of the
// audio clock (the usual Web Audio pattern; timers alone drift).

const KEY = "wattsup.musicVolume";
const DEFAULT_VOLUME = 40;
const BPM = 88;
const STEP_S = 60 / BPM / 4;
const LOOKAHEAD_S = 0.15;
const FADE_S = 1.5;

/** Pad voicing (MIDI) and bass root per chord. */
const CHORDS: { pad: number[]; root: number }[] = [
  { pad: [50, 54, 57, 61], root: 38 }, // Dmaj7
  { pad: [50, 54, 57, 59], root: 35 }, // Bm7
  { pad: [50, 54, 55, 59], root: 43 }, // Gmaj7
  { pad: [50, 52, 55, 57], root: 45 }, // A7sus4
];
const BASS = [0, 6, 10, 14];

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export function musicVolume(): number {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? DEFAULT_VOLUME : Math.max(0, Math.min(100, Number(v) || 0));
  } catch {
    return DEFAULT_VOLUME;
  }
}

export class MenuMusic {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private echo!: GainNode;
  private reverb!: GainNode;
  private padFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private timer = 0;
  private step = 0;
  private next = 0;
  private playing = false;
  private volume = musicVolume();
  private arp: number[] = [];
  private seed = 7;

  /** Plays or fades out; called with every screen change. */
  setPlaying(on: boolean) {
    if (on === this.playing) return;
    this.playing = on;
    if (on) this.start();
    else this.fadeOut();
  }

  setVolume(v: number) {
    this.volume = v;
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      // storage may be unavailable
    }
    if (!this.playing) return;
    if (v > 0 && !this.timer) this.start();
    else if (this.ctx) this.master.gain.setTargetAtTime(this.gain(), this.ctx.currentTime, 0.1);
  }

  /** Browsers may hold audio until the first click or key: resume then. */
  unlock() {
    if (this.ctx?.state === "suspended" && this.playing) this.ctx.resume().catch(() => {});
  }

  private gain() {
    return Math.pow(this.volume / 100, 2) * 0.9;
  }

  private start() {
    if (this.volume <= 0) return;
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(this.gain(), now + FADE_S);
    if (!this.timer) {
      this.step = 0;
      this.next = now + 0.1;
      this.timer = window.setInterval(() => this.schedule(), 25);
    }
  }

  private fadeOut() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + FADE_S);
    window.setTimeout(() => {
      if (this.playing) return;
      window.clearInterval(this.timer);
      this.timer = 0;
      ctx.suspend().catch(() => {});
    }, FADE_S * 1000 + 200);
  }

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    this.bus = ctx.createGain();
    this.bus.connect(this.master);

    // Reverb: a decaying noise impulse.
    const len = Math.floor(ctx.sampleRate * 2.6);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    this.reverb = ctx.createGain();
    this.reverb.gain.value = 0.35;
    this.reverb.connect(conv).connect(this.master);

    // Echo: dotted eighth, darkened on every repeat.
    const delay = ctx.createDelay(2);
    delay.delayTime.value = STEP_S * 3;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const dark = ctx.createBiquadFilter();
    dark.type = "lowpass";
    dark.frequency.value = 2200;
    this.echo = ctx.createGain();
    this.echo.gain.value = 0.3;
    this.echo.connect(delay);
    delay.connect(dark).connect(fb).connect(delay);
    dark.connect(this.bus);
    dark.connect(this.reverb);

    // The pad's filter opens and closes slowly.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = "lowpass";
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const depth = ctx.createGain();
    depth.gain.value = 450;
    lfo.connect(depth).connect(this.padFilter.frequency);
    lfo.start();
    this.padFilter.connect(this.bus);
    this.padFilter.connect(this.reverb);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const n = this.noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
  }

  private rand() {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  /** A 16-step arpeggio: indices into the chord's tones over two octaves, -1 a rest. */
  private newArp() {
    const shapes = [
      [0, 1, 2, 3, 4, 3, 2, 1],
      [0, 2, 4, 6, 4, 2, 5, 3],
      [4, 3, 2, 1, 0, 1, 2, 3],
      [0, 4, 1, 5, 2, 6, 3, 7],
    ];
    const shape = shapes[Math.floor(this.rand() * shapes.length)];
    this.arp = [];
    for (let i = 0; i < 16; i++) this.arp.push(i % 2 === 1 && this.rand() < 0.3 ? -1 : shape[i % 8]);
  }

  private schedule() {
    const ctx = this.ctx!;
    while (this.next < ctx.currentTime + LOOKAHEAD_S) {
      this.play(this.step, this.next);
      this.step++;
      this.next += STEP_S;
    }
  }

  private play(step: number, t: number) {
    const s = step % 16;
    const bar = Math.floor(step / 16) % 32;
    const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length];
    if (bar % 8 === 0 && s === 0) this.newArp();
    if (bar % 2 === 0 && s === 0) for (const m of chord.pad) this.pad(hz(m), t, STEP_S * 32);
    const i = this.arp[s];
    if (i >= 0) {
      const tones = [...chord.pad, ...chord.pad.map((m) => m + 12)];
      this.pluck(hz(tones[i % tones.length] + 12), t, bar < 4 ? 0.06 : 0.08);
    }
    if (bar >= 4 && BASS.includes(s)) this.bass(hz(chord.root + (s === 14 ? 12 : 0)), t);
    const drums = bar >= 8 && bar < 30;
    if (drums && (s === 0 || s === 8 || (s === 10 && bar % 4 === 3))) this.kick(t);
    if (drums && (s === 4 || s === 12)) this.snare(t);
    if (bar >= 12 && bar < 30 && s % 4 === 2) this.hat(t, 0.05);
    if (bar >= 16 && bar < 30 && s % 2 === 1) this.hat(t, 0.018);
  }

  private env(t: number, peak: number, attack: number, decay: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, stop: number, out: AudioNode, detune = 0) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    o.connect(out);
    o.start(t);
    o.stop(stop);
    return o;
  }

  private pad(f: number, t: number, dur: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.028, t + 1.4);
    g.gain.setValueAtTime(0.028, t + dur - 0.6);
    g.gain.linearRampToValueAtTime(0, t + dur + 1.2);
    g.connect(this.padFilter);
    for (const d of [-8, 8]) this.osc("sawtooth", f, t, t + dur + 1.3, g, d);
  }

  private pluck(f: number, t: number, peak: number) {
    const g = this.env(t, peak, 0.004, 0.4);
    const lp = this.ctx!.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    g.connect(lp);
    lp.connect(this.bus);
    lp.connect(this.echo);
    lp.connect(this.reverb);
    this.osc("triangle", f, t, t + 0.5, g);
    const h = this.env(t, peak * 0.25, 0.002, 0.15);
    h.connect(lp);
    this.osc("sine", f * 2, t, t + 0.2, h);
  }

  private bass(f: number, t: number) {
    const g = this.env(t, 0.22, 0.01, STEP_S * 3);
    const lp = this.ctx!.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    g.connect(lp).connect(this.bus);
    this.osc("sine", f, t, t + STEP_S * 4, g);
    this.osc("triangle", f, t, t + STEP_S * 4, g);
  }

  private kick(t: number) {
    const g = this.env(t, 0.45, 0.002, 0.32);
    g.connect(this.bus);
    const o = this.osc("sine", 130, t, t + 0.4, g);
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
  }

  private noiseHit(t: number, type: BiquadFilterType, f: number, peak: number, decay: number, wet: boolean) {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx!.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = f;
    const g = this.env(t, peak, 0.001, decay);
    src.connect(filter).connect(g).connect(this.bus);
    if (wet) g.connect(this.reverb);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.05);
  }

  private snare(t: number) {
    this.noiseHit(t, "bandpass", 1900, 0.13, 0.16, true);
    const g = this.env(t, 0.07, 0.001, 0.08);
    g.connect(this.bus);
    this.osc("triangle", 185, t, t + 0.1, g);
  }

  private hat(t: number, peak: number) {
    this.noiseHit(t, "highpass", 7500, peak, 0.04, false);
  }
}
