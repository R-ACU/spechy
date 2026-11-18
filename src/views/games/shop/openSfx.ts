// Sounds of the title box opening, synthesised with Web Audio (no files, no music), built on
// the helpers of economy/sfx.ts so they share its output, mute and volume. Port of the casino
// set from the social-shop mockup: rattle, glow climb (bells when it reaches gold), the pop,
// reel ticks that rise in pitch, a slowing heartbeat and the reveal by rarity.
import type { TitleRarity } from "../../../lib/ipc";
import { sfxKit } from "../economy/sfx";

const { tone, noise, bell, midi: n, graph } = sfxKit;
let lastTick = 0;

function pad(freqs: number[], at = 0, d = 2.4, v = 0.07) {
  const g0 = graph();
  if (!g0) return;
  const { ctx, out } = g0, t = ctx.currentTime + at;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1600;
  lp.connect(out);
  freqs.forEach((f) => [-7, 7].forEach((dt) => {
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
  }));
}

function brass(f: number, at = 0, d = 0.4, v = 0.06) {
  const g0 = graph();
  if (!g0) return;
  const { ctx, out } = g0, t = ctx.currentTime + at;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 2;
  lp.frequency.setValueAtTime(500, t);
  lp.frequency.exponentialRampToValueAtTime(2800, t + 0.06);
  lp.frequency.exponentialRampToValueAtTime(1100, t + d);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03 + d);
  lp.connect(g);
  g.connect(out);
  [-6, 6].forEach((dt) => {
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    o.detune.value = dt;
    o.connect(lp);
    o.start(t);
    o.stop(t + d + 0.1);
  });
}

export const openSfx = {
  /** The parcel rattles harder and harder. */
  rattle(dur = 1.1) {
    let t = 0, gap = 0.12;
    while (t < dur) {
      const p = t / dur;
      noise({ at: t, type: "bandpass", f: 700 + Math.random() * 600, q: 3, d: 0.04, v: 0.12 + p * 0.35 });
      t += gap;
      gap = Math.max(0.035, gap * 0.9);
    }
    tone({ f: 48, to: 70, type: "sine", d: dur, a: dur * 0.6, v: 0.25 });
  },
  /** The glow climbs one rarity step (0 common .. 3 legendary). */
  climb(i: number) {
    const f = n(67 + i * 4);
    tone({ f, type: "triangle", d: 0.14, v: 0.12 });
    tone({ f: f * 2, d: 0.09, v: 0.04 });
  },
  /** The glow touches gold. */
  tease() {
    for (let i = 0; i < 6; i++) bell(2600 + i * 380, 0.02 + i * 0.035, 0.045, 0.45);
  },
  /** The parcel bursts open. */
  pop() {
    tone({ f: 170, to: 42, d: 0.32, v: 0.7 });
    noise({ type: "lowpass", f: 1400, d: 0.18, v: 0.35 });
    noise({ type: "bandpass", f: 400, to: 3800, q: 0.8, d: 0.45, v: 0.18 });
  },
  whoosh(d = 0.35, v = 0.12) {
    noise({ type: "bandpass", f: 300, to: 2600, q: 0.9, a: d * 0.4, d: d * 0.6, v });
  },
  /** One reel card passes the marker; p raises the pitch as the reel slows. */
  tick(p = 1) {
    const g = graph();
    if (!g) return;
    if (g.ctx.currentTime - lastTick < 0.028) return;
    lastTick = g.ctx.currentTime;
    noise({ type: "bandpass", f: 2600 * p, q: 6, d: 0.014, v: 0.22 });
    tone({ f: 1250 * p, d: 0.025, v: 0.05 });
  },
  heartbeat() {
    tone({ f: 70, to: 42, d: 0.14, v: 0.55 });
    tone({ f: 62, to: 38, at: 0.16, d: 0.18, v: 0.4 });
  },
  /** Bells (and a pad from epic up) in proportion to the rarity. */
  reveal(r: TitleRarity) {
    const notes = { common: [76], rare: [76, 83], epic: [72, 76, 79, 84], legendary: [72, 76, 79, 84, 88, 91] }[r];
    notes.forEach((m, i) => bell(n(m), i * 0.085, r === "common" ? 0.14 : 0.2, r === "legendary" ? 1.8 : 1.1));
    if (r === "epic" || r === "legendary") {
      pad([n(60), n(64), n(67)].concat(r === "legendary" ? [n(72)] : []), 0.05, r === "legendary" ? 3.2 : 2, r === "legendary" ? 0.08 : 0.05);
    }
    if (r === "legendary") for (let i = 0; i < 10; i++) bell(3000 + Math.random() * 3000, 0.5 + i * 0.09, 0.05, 0.5);
  },
  /** Short brass fanfare for epic and legendary. */
  fanfare(r: TitleRarity) {
    if (r === "epic") {
      [67, 72, 76].forEach((m, i) => brass(n(m), i * 0.12, 0.2, 0.05));
      brass(n(79), 0.36, 0.7, 0.06);
      return;
    }
    [60, 64, 67, 72].forEach((m, i) => brass(n(m), i * 0.1, 0.16, 0.05));
    [72, 76, 79, 84].forEach((m) => brass(n(m), 0.44, 1.2, 0.045));
  },
  /** A purchase went through. */
  bought() {
    tone({ f: 660, to: 990, type: "triangle", d: 0.18, v: 0.18 });
    bell(1320, 0.03, 0.08, 0.4);
  },
};
