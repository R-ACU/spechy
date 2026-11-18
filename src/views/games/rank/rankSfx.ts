// Sound effects of the rank-up overlay, synthesised with Web Audio (no files, no music):
// a riser while the old emblem shakes, glass shatter plus a low impact when it breaks, a bell
// chord with a soft pad for the new rank, and a small chime per reward.

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let enabled = true;

export function setRankSfxEnabled(on: boolean) {
  enabled = on;
}

function ok(): boolean {
  if (!enabled) return false;
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return false;
    ctx = new C();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    out = ctx.createGain();
    out.gain.value = 0.45;
    out.connect(comp);
    comp.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return true;
}

function env(g: GainNode, t: number, a: number, d: number, v: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

interface ToneOpts { f?: number; to?: number | null; type?: OscillatorType; at?: number; a?: number; d?: number; v?: number }
function tone({ f = 440, to = null, type = "sine", at = 0, a = 0.004, d = 0.2, v = 0.3 }: ToneOpts) {
  if (!ok() || !ctx || !out) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + a + d);
  env(g, t, a, d, v);
  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + a + d + 0.05);
}

interface NoiseOpts { at?: number; a?: number; d?: number; v?: number; type?: BiquadFilterType; f?: number; to?: number | null; q?: number }
function noise({ at = 0, a = 0.003, d = 0.1, v = 0.3, type = "bandpass", f = 1000, to = null, q = 1 }: NoiseOpts) {
  if (!ok() || !ctx || !out) return;
  const t = ctx.currentTime + at, len = Math.ceil((a + d + 0.05) * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate), ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource();
  s.buffer = buf;
  const fl = ctx.createBiquadFilter();
  fl.type = type;
  fl.frequency.setValueAtTime(f, t);
  fl.Q.value = q;
  if (to) fl.frequency.exponentialRampToValueAtTime(to, t + a + d);
  const g = ctx.createGain();
  env(g, t, a, d, v);
  s.connect(fl);
  fl.connect(g);
  g.connect(out);
  s.start(t);
  s.stop(t + a + d + 0.05);
}

function bell(f: number, at = 0, v = 0.22, d = 1.2) {
  if (!ok() || !ctx || !out) return;
  const t = ctx.currentTime + at;
  const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
  car.frequency.value = f;
  mod.frequency.value = f * 3.5;
  mg.gain.setValueAtTime(f * 2.2, t);
  mg.gain.exponentialRampToValueAtTime(1, t + d);
  mod.connect(mg);
  mg.connect(car.frequency);
  car.connect(g);
  g.connect(out);
  env(g, t, 0.003, d, v);
  car.start(t);
  mod.start(t);
  car.stop(t + d + 0.1);
  mod.stop(t + d + 0.1);
}

function pad(freqs: number[], at = 0, d = 2.4, v = 0.07) {
  if (!ok() || !ctx || !out) return;
  const t = ctx.currentTime + at;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1600;
  lp.connect(out);
  for (const f of freqs) {
    for (const dt of [-7, 7]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.detune.value = dt;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g);
      g.connect(lp);
      o.start(t);
      o.stop(t + d + 0.1);
    }
  }
}

const n = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export const rankSfx = {
  riser(d = 1) {
    noise({ type: "bandpass", f: 250, to: 4200, q: 1.4, a: d * 0.9, d: d * 0.15, v: 0.22 });
    tone({ f: 110, to: 440, type: "sawtooth", a: d * 0.9, d: 0.1, v: 0.05 });
  },
  shatter() {
    noise({ type: "highpass", f: 1800, d: 0.5, v: 0.38 });
    for (let i = 0; i < 7; i++) bell(3200 + Math.random() * 3600, Math.random() * 0.18, 0.07, 0.35);
  },
  impact() {
    tone({ f: 96, to: 36, d: 0.8, v: 0.9 });
    noise({ type: "lowpass", f: 320, d: 0.35, v: 0.45 });
  },
  promo(big: boolean) {
    const chord = big ? [72, 76, 79, 84, 88] : [76, 79, 84];
    chord.forEach((m, i) => bell(n(m), 0.05 + i * 0.07, 0.18, 1.6));
    pad(big ? [n(48), n(55), n(64), n(67)] : [n(55), n(64)], 0, big ? 3 : 1.8, big ? 0.07 : 0.05);
  },
  reward() {
    tone({ f: 660, to: 990, type: "triangle", d: 0.18, v: 0.18 });
    bell(1320, 0.03, 0.08, 0.4);
  },
};
