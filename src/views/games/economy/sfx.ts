// Reward sounds of the Games economy, all synthesised with Web Audio (no files, no music):
// a clink per arriving coin, a tick per results row, a bell for a new best, a soft end tone.
// The caller decides whether sound is on (game mute plus the app's sound setting) and the volume.

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let lastTick = 0;
let enabled = true;
let volume = 0.8;

/** Follow the open game's mute and volume. */
export function configureSfx(on: boolean, vol: number) {
  enabled = on && vol > 0;
  volume = Math.max(0, Math.min(1, vol));
  if (out) out.gain.value = 0.55 * volume;
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
    out.gain.value = 0.55 * volume;
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

const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export const sfx = {
  /** One coin landing in the chip. */
  coin(i = 0) {
    const f = 2050 + Math.random() * 260 + (i % 4) * 40;
    tone({ f, type: "triangle", d: 0.16, v: 0.16 });
    tone({ f: f * 1.5, type: "sine", d: 0.1, v: 0.08 });
    noise({ type: "highpass", f: 5200, d: 0.02, v: 0.08 });
  },
  /** A results row appearing. */
  tick() {
    if (!ok() || !ctx) return;
    if (ctx.currentTime - lastTick < 0.028) return;
    lastTick = ctx.currentTime;
    noise({ type: "bandpass", f: 2600, q: 6, d: 0.014, v: 0.22 });
    tone({ f: 1250, d: 0.025, v: 0.05 });
  },
  /** Coins taking off. */
  whoosh(d = 0.45, v = 0.06) {
    noise({ type: "bandpass", f: 300, to: 2600, q: 0.9, a: d * 0.4, d: d * 0.6, v });
  },
  /** The round is over. */
  end() {
    tone({ f: 330, to: 220, type: "triangle", d: 0.35, v: 0.12 });
  },
  /** New personal best. */
  best() {
    bell(midi(84), 0.15, 0.16, 1.2);
  },
  /** A rank promotion row. */
  promo() {
    [76, 79, 84].forEach((m, i) => bell(midi(m), 0.05 + i * 0.07, 0.16, 1.4));
  },
};

/** Building blocks for other sound sets (the box opening in shop/openSfx.ts). Same output,
 *  same mute and volume. `graph` is null while sound is off. */
export const sfxKit = {
  tone,
  noise,
  bell,
  midi,
  graph: (): { ctx: AudioContext; out: GainNode } | null => (ok() && ctx && out ? { ctx, out } : null),
};
