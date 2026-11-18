/*
  README: Comet Keeper

  Concept: a little lantern keeper floats in the night sky. Comets streak in along four
  lanes (up, right, down, left) and try to hit it. Swing the shield to the side a comet
  comes from. Tap that side again right as the comet arrives for a PERFECT parry that
  throws it back into the sky. Three hearts; every comet that gets through costs one.
  Comets get faster and denser, a run lasts a minute or two.

  Controls: arrow keys or WASD swing the shield, and every press is also a bash (a bash
  within a moment of contact is a PERFECT). Space or Enter bashes the current side, starts
  and retries. Mouse: point to aim, click to bash. Touch: tap the side to guard. P pauses
  (the game also pauses when the window loses focus), M mutes. Escape belongs to the hub.

  Scoring: block 10, PERFECT 25; fast blue comet 15 or 30; gold comet 50 or 100. Points are
  multiplied by the streak multiplier (x1, plus one for every 10 blocks in a row, up to x5);
  a comet that gets through resets it. Pink hearts heal one heart when caught. Bashing
  wildly does not pay: a bash that meets no comet locks PERFECT out for a short moment.

  Tech: software pixel renderer into an ImageData framebuffer (like Pixel Tower), sound
  effects synthesized with Web Audio (no music), best score in localStorage under
  `storageKey`, volume and mute under `${storageKey}.volume` and `.muted`. No full screen
  flashes; prefers-reduced-motion turns off shake, bobbing and twinkling.

    const game = create(canvas, { keyTarget: panel, onGameOver });
    game.setVolume(0.5); game.getState(); game.destroy();

  The canvas fills its parent element, so give the parent a size.
*/

export const COMET_BEST_KEY = "spechy.games.comet.best";

type Kind = "normal" | "fast" | "gold" | "heart";
type Phase = "title" | "play" | "paused" | "dying" | "over";

export interface CometKeeperOptions {
  /** localStorage key of the best score; volume and mute go to `${storageKey}.volume` and `.muted`. */
  storageKey?: string;
  /** Internal pixels across the shorter side of the canvas. */
  shortSide?: number;
  /** Element that receives keydown listeners. Default: window. */
  keyTarget?: EventTarget;
  reducedMotion?: boolean;
  /** Sound volume 0..1; default: the remembered value or 0.8. */
  volume?: number;
  /** Let a bot guard the keeper (for tests). */
  bot?: boolean;
  onGameOver?: (result: { score: number; best: number; newBest: boolean }) => void;
}

export interface CometKeeperState {
  state: Phase;
  score: number;
  best: number;
  lives: number;
  combo: number;
  mult: number;
  muted: boolean;
  /** Seconds since the current run started. */
  time: number;
}

export interface CometKeeperGame {
  /** Same as Space: start, bash, resume or retry. */
  press(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  setBot(bot: boolean): void;
  getState(): CometKeeperState;
  /** Stops the frame loop, removes every listener and closes the AudioContext. */
  destroy(): void;
}

// ---------- tuning ----------
const SHORT_SIDE = 200;   // internal pixels across the shorter side
const RS = 24;            // shield radius
const CORE_R = 9;         // keeper radius
const ARC = 0.72;         // half width of the shield arc in radians (about 41 degrees)
const PERFECT_WIN = 0.12; // a bash this long before contact makes a PERFECT
const LATE_WIN = 0.07;    // a bash this long after a plain block still upgrades it
const WHIFF_LOCK = 0.18;  // a bash that meets nothing locks PERFECT out this long
const LIVES = 3;

const POINTS: Record<Kind, [number, number]> = { normal: [10, 25], fast: [15, 30], gold: [50, 100], heart: [10, 25] };
const LANE_ANG = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
const UX = [0, 1, 0, -1];
const UY = [-1, 0, 1, 0];

// ---------- helpers ----------
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => { const c = 1.7; t -= 1; return 1 + (c + 1) * t * t * t + c * t * t; };
const wrapAngle = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

function hash(n: number) {
  n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  n ^= n >>> 13; n = Math.imul(n, 0xc2b2ae35); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

type RGB = [number, number, number];
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
// colours are packed as 0xAABBGGRR for the Uint32 view of ImageData
const packRgb = (c: RGB) => (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
const pack = (s: string) => packRgb(hex(s));
const unpackRgb = (c: number): RGB => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255];
const mix = (a: number, b: number, t: number) => {
  const x = unpackRgb(a), y = unpackRgb(b);
  return packRgb([Math.round(x[0] + (y[0] - x[0]) * t), Math.round(x[1] + (y[1] - x[1]) * t), Math.round(x[2] + (y[2] - x[2]) * t)]);
};

// ---------- palette (game art, not UI colours) ----------
const SKY = pack("#1d1b3c");
const STAR_DIM = pack("#5d5890");
const STAR = pack("#e9e6ff");
const RAIL = pack("#2d2a55");
const TRACK = pack("#3a3670");
const INK = pack("#141228");
const PANEL = pack("#141228");
const WHITE = pack("#ffffff");
const PALE = pack("#c9c4ee");
const DIM = pack("#8a84b8");
const GOLD = pack("#ffd84a");
const RED = pack("#ff4f64");
const CORE = { body: pack("#ffd27a"), shade: pack("#f0a050"), light: pack("#fff3c4"), line: pack("#3a2148"), eye: pack("#3a2148"), cheek: pack("#ff9a8a") };
const SHIELD = { main: pack("#6fdcff"), edge: pack("#d4f8ff"), inner: pack("#2f8fc4"), bash: pack("#ffffff") };
const PLANET = { body: pack("#3b3878"), band: pack("#4a4690"), shade: pack("#2b2960"), ring: pack("#7a6cc0"), ringDark: pack("#4f4590") };
const HEART_FULL = pack("#ff6b8a"), HEART_LIGHT = pack("#ffc2d0"), HEART_EMPTY = pack("#3a3766");

interface Style { head: number; core: number; trail: [number, number, number]; len: number; wide: number }
const STYLES: Record<Kind, Style> = {
  normal: { head: pack("#ff9a5a"), core: pack("#fff0d0"), trail: [pack("#ff6b5a"), pack("#c8456e"), pack("#7a3470")], len: 11, wide: 4 },
  fast: { head: pack("#9fe6ff"), core: pack("#ffffff"), trail: [pack("#6fc8ff"), pack("#4a7fe0"), pack("#3a4aa0")], len: 20, wide: 7 },
  gold: { head: pack("#ffe14a"), core: pack("#fffbe0"), trail: [pack("#ffb43a"), pack("#d9802a"), pack("#8a4a2a")], len: 13, wide: 5 },
  heart: { head: HEART_FULL, core: HEART_LIGHT, trail: [pack("#e0507a"), pack("#a8406e"), pack("#6a3062")], len: 6, wide: 0 },
};

const HEART = [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."];

// ---------- 5x7 pixel font ----------
const GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "10001", "01010", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  x: ["00000", "00000", "10001", "01010", "00100", "01010", "10001"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
};
const FONT: Record<string, number[]> = {};
for (const ch in GLYPHS) {
  const px: number[] = [];
  GLYPHS[ch].forEach((row, y) => { for (let x = 0; x < 5; x++) if (row[x] === "1") px.push(x, y); });
  FONT[ch] = px;
}
const advance = (ch: string, fp: number) => (ch === " " ? 4 * fp : 6 * fp);
const textWidth = (str: string, fp: number) => { let w = 0; for (const ch of str) w += advance(ch, fp); return Math.max(0, w - fp); };

// ---------- sound (Web Audio synthesis) ----------
// Every effect carries most of its energy between about 300 Hz and 4 kHz so it stays
// audible on laptop speakers; the low parts are only body underneath.
export type SfxName = "block" | "perfect" | "hit" | "heal" | "gold" | "mult" | "swing" | "start" | "shatter" | "over" | "tick" | "land" | "best" | "fizz" | "click";
export interface Sfx {
  setVolume(v: number): void;
  play(name: SfxName, arg?: number): void;
}

export function createSfx(ac: BaseAudioContext, out?: AudioNode): Sfx {
  const master = ac.createGain();
  master.gain.value = 0.8;
  const shaper = ac.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(1.5 * x) / Math.tanh(1.5); }
  shaper.curve = curve;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 4;
  comp.attack.value = 0.002; comp.release.value = 0.15;
  const post = ac.createGain();
  post.gain.value = 1.5;
  master.connect(shaper); shaper.connect(comp); comp.connect(post); post.connect(out || ac.destination);

  const noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  function env(g: GainNode, t: number, a: number, vol: number, d: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function osc(type: OscillatorType, f0: number, f1: number, sweep: number, t: number, a: number, d: number, vol: number) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (sweep > 0 && f1 > 0 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    env(g, t, a, vol, d);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + a + d + 0.05);
  }
  function nz(type: BiquadFilterType, f0: number, f1: number, q: number, t: number, a: number, d: number, vol: number) {
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf;
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 > 0 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    env(g, t, a, vol, d);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.4); s.stop(t + a + d + 0.05);
  }
  const now = () => ac.currentTime + 0.005;
  // pentatonic steps for the PERFECT chime, it climbs with the streak
  const STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

  const bank: Record<SfxName, (arg: number) => void> = {
    block() {
      const t = now(), r = 1 + (Math.random() - 0.5) * 0.1;
      osc("triangle", 1500 * r, 760, 0.05, t, 0.001, 0.09, 0.55);   // tink
      osc("square", 680 * r, 340, 0.04, t, 0.001, 0.05, 0.16);     // knock
      osc("sine", 360 * r, 220, 0.06, t, 0.002, 0.08, 0.3);         // body
      nz("bandpass", 2800 * r, 0, 1.6, t, 0.001, 0.035, 0.75);       // click
    },
    perfect(combo) {
      const t = now();
      const f = 784 * Math.pow(2, STEPS[clamp(Math.floor(combo / 3), 0, STEPS.length - 1)] / 12);
      osc("triangle", 1300, 620, 0.05, t, 0.001, 0.08, 0.55);       // clang
      osc("sine", 420, 230, 0.08, t, 0.002, 0.12, 0.35);
      nz("bandpass", 3400, 0, 1.2, t, 0.001, 0.04, 0.8);
      osc("square", f, f, 0, t, 0.002, 0.07, 0.12);                 // chime
      osc("square", f * 1.5, f * 1.5, 0, t + 0.05, 0.002, 0.2, 0.09);
      osc("triangle", f * 2, f * 2, 0, t + 0.05, 0.002, 0.32, 0.16);
      nz("bandpass", 3800, 1800, 2, t + 0.02, 0.02, 0.18, 0.12);    // shimmer
    },
    hit() {
      const t = now();
      osc("square", 560, 150, 0.22, t, 0.002, 0.28, 0.28);
      osc("sawtooth", 330, 95, 0.3, t, 0.003, 0.34, 0.16);
      nz("bandpass", 1300, 320, 0.9, t, 0.002, 0.3, 0.95);
      osc("triangle", 1000, 420, 0.05, t, 0.001, 0.06, 0.45);       // crack
      nz("bandpass", 3200, 0, 1.2, t, 0.001, 0.03, 0.5);
    },
    heal() {
      const t = now();
      [660, 880, 1320, 1760].forEach((f, i) => {
        osc("triangle", f, f, 0, t + i * 0.055, 0.002, 0.14, 0.2);
        osc("square", f, f, 0, t + i * 0.055, 0.002, 0.05, 0.05);
      });
    },
    gold() {
      const t = now() + 0.04;
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => osc("triangle", f, f, 0, t + i * 0.04, 0.002, 0.12, 0.13));
    },
    mult() {
      const t = now() + 0.03;
      osc("square", 620, 1500, 0.12, t, 0.003, 0.14, 0.08);
      osc("triangle", 1500, 1500, 0, t + 0.12, 0.002, 0.22, 0.16);
    },
    swing() {
      const t = now();
      nz("bandpass", 1300, 2600, 1.4, t, 0.008, 0.05, 0.4);
    },
    start() {
      const t = now();
      osc("square", 523, 523, 0, t, 0.002, 0.06, 0.09);
      osc("square", 784, 784, 0, t + 0.07, 0.002, 0.12, 0.09);
      osc("triangle", 1568, 1568, 0, t + 0.07, 0.002, 0.16, 0.08);
    },
    shatter() {
      const t = now();
      nz("bandpass", 1100, 240, 0.8, t, 0.003, 0.6, 0.95);
      osc("square", 440, 90, 0.5, t, 0.003, 0.55, 0.18);
      osc("triangle", 900, 220, 0.4, t, 0.002, 0.45, 0.35);
      nz("bandpass", 2600, 900, 1.4, t + 0.05, 0.01, 0.4, 0.35);
    },
    over() {
      const t = now();
      osc("square", 659, 659, 0, t, 0.003, 0.11, 0.08);
      osc("square", 523, 523, 0, t + 0.12, 0.003, 0.11, 0.08);
      osc("square", 392, 370, 0.25, t + 0.24, 0.003, 0.3, 0.08);
    },
    tick(k) {
      const t = now(), f = 900 + clamp(k, 0, 1) * 900;
      osc("square", f, f, 0, t, 0.001, 0.025, 0.12);
      osc("triangle", f * 2, f * 2, 0, t, 0.001, 0.02, 0.12);
    },
    land() {
      const t = now();
      osc("triangle", 1046.5, 1046.5, 0, t, 0.002, 0.2, 0.18);
      osc("triangle", 1568, 1568, 0, t + 0.06, 0.002, 0.3, 0.14);
      osc("square", 523, 523, 0, t, 0.002, 0.05, 0.06);
    },
    best() {
      const t = now();
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
        osc("square", f, f, 0, t + i * 0.07, 0.002, i === 3 ? 0.4 : 0.1, 0.07);
        osc("triangle", f, f, 0, t + i * 0.07, 0.002, i === 3 ? 0.5 : 0.12, 0.12);
      });
      nz("bandpass", 3600, 2000, 1.5, t + 0.21, 0.03, 0.4, 0.1);
    },
    fizz() {
      const t = now();
      nz("bandpass", 2400, 900, 1.2, t, 0.004, 0.12, 0.3);
      osc("triangle", 1200, 1200, 0, t, 0.002, 0.08, 0.06);
    },
    click() {
      const t = now();
      osc("square", 1800, 1800, 0, t, 0.001, 0.03, 0.15);
    },
  };

  return {
    setVolume(v) { master.gain.setTargetAtTime(v, ac.currentTime, 0.02); },
    play(name, arg = 0) { bank[name](arg); },
  };
}

// ---------- game ----------
interface Comet { lane: number; kind: Kind; hitT: number; v: number; st: "in" | "out"; d: number; out: number; botMiss: boolean; botBash: boolean }
interface Part { x: number; y: number; vx: number; vy: number; t: number; life: number; c: number; s: number; g: number }
interface Ring { x: number; y: number; t: number; life: number; r: number; c: number }
interface Popup { text: string; x: number; y: number; t: number; life: number; fp: number; c: number; sub?: string }
interface Fall { x: number; y: number; vx: number; vy: number; t: number }
interface Block { lane: number; t: number; kind: Kind; mult: number; perfect: boolean; pop: Popup; x: number; y: number }

export function create(canvas: HTMLCanvasElement, opts: CometKeeperOptions = {}): CometKeeperGame {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D is not available");
  const g2d = ctx;
  const host = canvas.parentElement || document.body;
  const reduced = opts.reducedMotion != null ? !!opts.reducedMotion
    : typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const storageKey = opts.storageKey || COMET_BEST_KEY;
  const shortSide = opts.shortSide || SHORT_SIDE;
  const keyTarget: EventTarget = opts.keyTarget || window;

  const load = (k: string) => { try { return parseInt(localStorage.getItem(k) ?? "", 10) || 0; } catch { return 0; } };
  const save = (k: string, v: number) => { try { localStorage.setItem(k, String(v)); } catch { /* storage blocked */ } };

  // framebuffer
  let iw = 0, ih = 0, img: ImageData | null = null, buf = new Uint32Array(0);
  let cx = 0, cy = 0, ox = 0, oy = 0;
  let stars: { x: number; y: number; ph: number; big: boolean }[] = [];

  // state
  let state: Phase = "title", stateT = 0, realT = 0, gt = 0, runStart = 0;
  let score = 0, shown = 0, best = load(storageKey), lives = LIVES, combo = 0, mult = 1;
  let newBest = false, bestAnnounced = false;
  let muted = load(storageKey + ".muted") === 1;
  let volume = (() => {
    if (opts.volume != null) return clamp(+opts.volume || 0, 0, 1);
    try { const v = parseFloat(localStorage.getItem(storageKey + ".volume") ?? ""); return isNaN(v) ? 0.8 : clamp(v, 0, 1); } catch { return 0.8; }
  })();
  let bot = !!opts.bot;
  let comets: Comet[] = [], parts: Part[] = [], rings: Ring[] = [], pops: Popup[] = [], falls: Fall[] = [];
  let shDir = 3, shA = LANE_ANG[3], bashAge = 9;
  let pending: { lane: number; t: number } | null = null, bashLock = 0, lastBlock: Block | null = null;
  const bashT = [-9, -9, -9, -9];
  let nextArr = 0, lastArr = -9, lastLane = -1, prevLane = -1, attractNext = 0;
  let shake = 0, shx = 0, shy = 0, hitstop = 0;
  let coreIn = 1, coreHurt = 0, coreHappy = 0, coreTint = 0, blinkIn = rand(2, 4), blink = 0;
  let hudPop = 9, hudFlash = WHITE, multPop = 9;
  let overShown = 0, overDone = false, overPop = 9, lastTick = 0;
  let pausedFrom: Phase = "play";

  // ---------- audio ----------
  let ac: AudioContext | null = null, sfx: Sfx | null = null;
  function ensureAudio() {
    if (!ac) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      sfx = createSfx(ac);
      sfx.setVolume(volume);
    }
    if (ac.state === "suspended") ac.resume().catch(() => {});
  }
  function play(name: SfxName, arg?: number) {
    if (muted || !sfx || volume <= 0 || state === "title") return;
    try { sfx.play(name, arg); } catch { /* audio is optional */ }
  }

  // ---------- framebuffer primitives ----------
  function rect(x: number, y: number, w: number, h: number, c: number) {
    let x0 = x | 0, y0 = y | 0, x1 = x0 + w, y1 = y0 + h;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > iw) x1 = iw; if (y1 > ih) y1 = ih;
    if (x1 <= x0 || y1 <= y0) return;
    for (let yy = y0; yy < y1; yy++) buf.fill(c, yy * iw + x0, yy * iw + x1);
  }
  function pset(x: number, y: number, c: number) { x |= 0; y |= 0; if (x >= 0 && x < iw && y >= 0 && y < ih) buf[y * iw + x] = c; }
  /** Pulls a band of rows toward the panel colour (a dark glass strip behind text). */
  function shadeRows(y0: number, y1: number, k: number) {
    y0 = Math.max(0, y0 | 0); y1 = Math.min(ih, y1 | 0);
    const p = unpackRgb(PANEL);
    for (let y = y0; y < y1; y++) {
      for (let i = y * iw, e = i + iw; i < e; i++) {
        const c = buf[i];
        const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
        buf[i] = (0xff000000 | ((b + (p[2] - b) * k) << 16) | ((g + (p[1] - g) * k) << 8) | (r + (p[0] - r) * k)) >>> 0;
      }
    }
  }
  function circleOutline(x: number, y: number, r: number, c: number) {
    // midpoint circle, crisp at any radius
    let dx = Math.round(r), dy = 0, err = 1 - dx;
    x |= 0; y |= 0;
    while (dx >= dy) {
      pset(x + dx, y + dy, c); pset(x - dx, y + dy, c); pset(x + dx, y - dy, c); pset(x - dx, y - dy, c);
      pset(x + dy, y + dx, c); pset(x - dy, y + dx, c); pset(x + dy, y - dx, c); pset(x - dy, y - dx, c);
      dy++;
      if (err < 0) err += 2 * dy + 1; else { dx--; err += 2 * (dy - dx) + 1; }
    }
  }
  function heart(x: number, y: number, s: number, fill: number, outline: boolean) {
    if (outline) {
      for (let r = 0; r < HEART.length; r++) for (let k = 0; k < 7; k++) {
        if (HEART[r][k] !== "X") continue;
        rect(x + k * s - 1, y + r * s - 1, s + 2, s + 2, INK);
      }
    }
    for (let r = 0; r < HEART.length; r++) for (let k = 0; k < 7; k++) {
      if (HEART[r][k] !== "X") continue;
      rect(x + k * s, y + r * s, s, s, fill === HEART_FULL && r === 1 && k === 1 ? HEART_LIGHT : fill);
    }
  }

  // ---------- text ----------
  // pass 0 draws the outline plus a 1px drop shadow, pass 1 the fill
  function glyph(ch: string, x: number, y: number, fx: number, fy: number, c: number, pass: number) {
    const px = FONT[ch];
    if (!px) return;
    if (pass === 0) for (let i = 0; i < px.length; i += 2) rect(x + px[i] * fx - 1, y + px[i + 1] * fy - 1, fx + 2, fy + 3, c);
    else for (let i = 0; i < px.length; i += 2) rect(x + px[i] * fx, y + px[i + 1] * fy, fx, fy, c);
  }
  function text(str: string, x: number, y: number, fp: number, fill: number) {
    for (let pass = 0; pass < 2; pass++) {
      let tx = x;
      for (const ch of str) { glyph(ch, tx, y, fp, fp, pass === 0 ? INK : fill, pass); tx += advance(ch, fp); }
    }
  }
  const textC = (str: string, x: number, y: number, fp: number, fill: number) =>
    text(str, Math.round(x - textWidth(str, fp) / 2), Math.round(y), fp, fill);

  // ---------- layout ----------
  function resize() {
    const cw = host.clientWidth || window.innerWidth, chh = host.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const dw = Math.max(1, Math.round(cw * dpr)), dh = Math.max(1, Math.round(chh * dpr));
    const scale = Math.max(2, Math.round(Math.min(dw, dh) / shortSide));
    const nw = Math.ceil(dw / scale), nh = Math.ceil(dh / scale);
    if (nw !== iw || nh !== ih) {
      iw = nw; ih = nh;
      canvas.width = iw; canvas.height = ih;
      img = g2d.createImageData(iw, ih);
      buf = new Uint32Array(img.data.buffer);
      const n = Math.round((iw * ih) / 160);
      stars = [];
      for (let i = 0; i < n; i++) stars.push({ x: Math.floor(hash(i * 3 + 1) * iw), y: Math.floor(hash(i * 3 + 2) * ih), ph: hash(i * 3 + 3) * 6.283, big: hash(i * 7 + 5) > 0.93 });
    }
    // center the internal image on the host even when the last pixel column overhangs
    canvas.style.width = (iw * scale) / dpr + "px";
    canvas.style.height = (ih * scale) / dpr + "px";
    canvas.style.marginLeft = Math.round((cw - (iw * scale) / dpr) / 2) + "px";
    canvas.style.marginTop = Math.round((chh - (ih * scale) / dpr) / 2) + "px";
    cx = iw >> 1;
    cy = ih >> 1;
  }
  const hudFp = () => (ih >= 260 && iw >= 260 ? 3 : 2);
  const laneLen = (lane: number) => (lane % 2 === 0 ? cy : cx);

  // ---------- run ----------
  function resetRun() {
    comets = []; parts = []; rings = []; pops = []; falls = [];
    score = 0; shown = 0; lives = LIVES; combo = 0; mult = 1;
    newBest = false; bestAnnounced = false;
    pending = null; bashLock = 0; lastBlock = null;
    for (let i = 0; i < 4; i++) bashT[i] = -9;
    hitstop = 0; coreHurt = 0; coreTint = 0; coreHappy = 0;
    runStart = gt; nextArr = gt + 1.9; lastArr = -9; lastLane = -1; prevLane = -1;
    hudPop = 9; multPop = 9;
  }
  function startGame() {
    resetRun();
    state = "play"; stateT = 0;
    play("start");
  }
  function retry() {
    resetRun();
    coreIn = 0;
    state = "play"; stateT = 0;
    play("start");
  }

  // ---------- spawning ----------
  const elapsed = (t: number) => t - runStart;
  const baseSpeed = (el: number) => Math.min(150, 62 + el * 0.95);

  function addComet(lane: number, hitT: number, kind: Kind) {
    const el = elapsed(hitT);
    let v = baseSpeed(el) * (kind === "fast" ? 1.55 : kind === "heart" ? 0.85 : 1);
    // a later comet on the same lane never overtakes an earlier one on screen
    for (const c of comets) if (c.lane === lane && c.st === "in" && c.hitT < hitT && c.v > v) v = c.v;
    comets.push({ lane, kind, hitT, v, st: "in", d: RS + v * (hitT - gt), out: 0, botMiss: bot && state === "play" && Math.random() < 0.07, botBash: Math.random() < 0.45 });
    prevLane = lastLane; lastLane = lane; lastArr = hitT;
  }
  function pickLane() {
    let lane = Math.floor(Math.random() * 4);
    if (lane === lastLane && lane === prevLane) lane = (lane + 1 + Math.floor(Math.random() * 3)) % 4;
    return lane;
  }
  function pickKind(el: number): Kind {
    const r = Math.random();
    if (lives < LIVES && el > 15 && r < 0.05 && !comets.some((c) => c.kind === "heart")) return "heart";
    if (r < 0.12) return "gold";
    if (el > 18 && r < 0.12 + Math.min(0.25, (el - 18) / 160)) return "fast";
    return "normal";
  }
  function planRun() {
    while (nextArr - gt < 3.5) {
      const el = elapsed(nextArr);
      const gap = Math.max(0.34, 0.95 - el * 0.0065);
      const r = Math.random();
      // the very first comet comes where the shield already points: an easy first block
      let lane = lastLane < 0 ? shDir : pickLane();
      const at = (l: number, t: number) => Math.max(t, lastArr + (l === lastLane ? 0.17 : 0.27));
      if (el > 45 && r < 0.12) {
        // sweep: three lanes in a row, turning one way
        const turn = Math.random() < 0.5 ? 1 : 3;
        let t = nextArr;
        for (let i = 0; i < 3; i++) { t = at(lane, t); addComet(lane, t, "normal"); lane = (lane + turn) % 4; t += Math.max(0.27, gap * 0.75); }
        nextArr = lastArr + gap * 1.2;
      } else if (el > 22 && r < 0.3) {
        // double tap on one lane
        const t = at(lane, nextArr);
        addComet(lane, t, "normal");
        addComet(lane, t + 0.2, pickKind(el));
        nextArr = lastArr + gap * 1.1;
      } else {
        addComet(lane, at(lane, nextArr), pickKind(el));
        nextArr = lastArr + gap * rand(0.85, 1.15);
      }
    }
  }
  function planAttract() {
    // the title screen guards a few slow comets from the sides, away from the text
    if (attractNext < gt) attractNext = gt + 1;
    while (attractNext - gt < 2.5) {
      const lane = Math.random() < 0.5 ? 1 : 3;
      const kind: Kind = Math.random() < 0.2 ? "gold" : Math.random() < 0.25 ? "fast" : "normal";
      comets.push({ lane, kind, hitT: attractNext, v: kind === "fast" ? 110 : 70, st: "in", d: 999, out: 0, botMiss: false, botBash: Math.random() < 0.4 });
      attractNext += rand(0.7, 1.2);
    }
  }

  // ---------- actions ----------
  function turn(lane: number, bash: boolean) {
    if (lane !== shDir) {
      shDir = lane;
      if (!bash) play("swing");
      if (reduced) shA = LANE_ANG[lane];
    }
    if (!bash) return;
    bashAge = 0;
    if (lastBlock && lastBlock.lane === lane && !lastBlock.perfect && gt - lastBlock.t <= LATE_WIN) { upgrade(lastBlock); return; }
    play("swing");
    if (gt >= bashLock) { bashT[lane] = gt; pending = { lane, t: gt }; }
  }

  function contactPoint(lane: number) { return { x: cx + UX[lane] * RS, y: cy + UY[lane] * RS }; }

  function block(c: Comet, perfect: boolean) {
    const p = contactPoint(c.lane);
    const live = state === "play";
    if (perfect) pending = null;
    if (live) {
      combo++;
      const m = Math.min(5, 1 + Math.floor(combo / 10));
      if (m > mult) { mult = m; multPop = 0; play("mult"); }
      const pts = POINTS[c.kind][perfect ? 1 : 0] * mult;
      score += pts;
      hudPop = 0; hudFlash = perfect || c.kind === "gold" ? GOLD : WHITE;
      const pop: Popup = { text: "+" + pts, x: c.lane % 2 ? p.x + UX[c.lane] * 18 : p.x + 30, y: c.lane % 2 ? p.y - 20 : p.y + UY[c.lane] * 4 - 4, t: 0, life: 0.75, fp: 1, c: perfect ? GOLD : WHITE, sub: perfect ? "PERFECT" : undefined };
      pops.push(pop);
      lastBlock = { lane: c.lane, t: gt, kind: c.kind, mult, perfect, pop, x: p.x, y: p.y };
      if (c.kind === "heart" && lives < LIVES) {
        lives++;
        pops.push({ text: "+1", x: iw - 30, y: 26, t: 0, life: 0.8, fp: 1, c: HEART_LIGHT });
        play("heal");
      }
      if (c.kind === "gold") play("gold");
      if (!bestAnnounced && best > 0 && score > best) {
        bestAnnounced = true;
        pops.push({ text: "NEW BEST", x: iw / 2, y: Math.round(ih * 0.1), t: 0, life: 1.4, fp: 1, c: GOLD });
        play("best");
      }
    }
    const st = STYLES[c.kind];
    if (perfect) {
      c.st = "out"; c.out = 0;
      perfectFx(p.x, p.y, c.lane, st);
      if (live) play("perfect", combo);
    } else {
      comets.splice(comets.indexOf(c), 1);
      shatter(p.x, p.y, c.lane, st, 8);
      rings.push({ x: p.x, y: p.y, t: 0, life: 0.22, r: 7, c: PALE });
      kick(0.8);
      if (live) play("block");
    }
  }
  function perfectFx(x: number, y: number, lane: number, st: Style) {
    rings.push({ x, y, t: 0, life: 0.3, r: 11, c: GOLD }, { x, y, t: -0.06, life: 0.3, r: 8, c: WHITE });
    const n = reduced ? 6 : 12;
    for (let i = 0; i < n; i++) {
      const a = LANE_ANG[lane] + rand(-1.1, 1.1), sp = rand(50, 120);
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.3, 0.55), c: i % 3 === 0 ? WHITE : i % 3 === 1 ? GOLD : st.head, s: Math.random() < 0.4 ? 2 : 1, g: 60 });
    }
    hitstop = Math.max(hitstop, 0.045);
    kick(1.6);
    coreHappy = 0.35;
  }
  function upgrade(b: Block) {
    b.perfect = true;
    pending = null;
    const bonus = (POINTS[b.kind][1] - POINTS[b.kind][0]) * b.mult;
    score += bonus;
    hudPop = 0; hudFlash = GOLD;
    b.pop.text = "+" + (POINTS[b.kind][1] * b.mult);
    b.pop.c = GOLD; b.pop.sub = "PERFECT"; b.pop.t = Math.min(b.pop.t, 0.05);
    perfectFx(b.x, b.y, b.lane, STYLES[b.kind]);
    play("perfect", combo);
  }
  function shatter(x: number, y: number, lane: number, st: Style, n: number) {
    const cols = [st.head, st.core, st.trail[0], st.trail[1]];
    if (reduced) n = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      const a = LANE_ANG[lane] + rand(-1.3, 1.3), sp = rand(30, 90);
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.25, 0.5), c: cols[i % 4], s: Math.random() < 0.5 ? 2 : 1, g: 160 });
    }
  }
  function coreHit(c: Comet) {
    comets.splice(comets.indexOf(c), 1);
    const x = cx + UX[c.lane] * (CORE_R + 1), y = cy + UY[c.lane] * (CORE_R + 1);
    if (c.kind === "heart") {
      // a missed heart just fizzles, it never hurts
      shatter(x, y, c.lane, STYLES.heart, 6);
      play("fizz");
      return;
    }
    lives--;
    combo = 0; mult = 1; pending = null; lastBlock = null;
    coreHurt = 0.5; coreTint = 1;
    hitstop = Math.max(hitstop, 0.12);
    kick(4);
    const st = STYLES[c.kind];
    for (let i = 0; i < (reduced ? 8 : 16); i++) {
      const a = LANE_ANG[c.lane] + rand(-1.4, 1.4), sp = rand(40, 110);
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.3, 0.6), c: i % 3 === 0 ? RED : i % 3 === 1 ? st.head : CORE.shade, s: Math.random() < 0.5 ? 2 : 1, g: 120 });
    }
    rings.push({ x: cx, y: cy, t: 0, life: 0.3, r: CORE_R + 8, c: RED });
    const hs = hudFp() - 1, slot = heartX(lives, hs);
    falls.push({ x: slot, y: 6, vx: rand(-20, 20), vy: -60, t: 0 });
    play("hit");
    if (lives <= 0) die();
  }
  function die() {
    state = "dying"; stateT = 0;
    kick(5);
    hitstop = Math.max(hitstop, 0.16);
    for (const c of comets) {
      const p = cometPos(c);
      shatter(p.x, p.y, c.lane, STYLES[c.kind], 4);
    }
    comets = [];
    const cols = [CORE.body, CORE.shade, CORE.light, RED];
    for (let i = 0; i < (reduced ? 14 : 34); i++) {
      const a = rand(0, Math.PI * 2), sp = rand(20, 110);
      parts.push({ x: cx + Math.cos(a) * 3, y: cy + Math.sin(a) * 3, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.5, 1.0), c: cols[i % 4], s: Math.random() < 0.5 ? 2 : 1, g: 90 });
    }
    rings.push({ x: cx, y: cy, t: 0, life: 0.5, r: 30, c: CORE.light });
    coreIn = 0;
    play("shatter");
  }
  function enterOver() {
    state = "over"; stateT = 0;
    newBest = score > best;
    if (newBest) { best = score; save(storageKey, best); }
    overShown = 0; overDone = false; overPop = 9;
    play("over");
    opts.onGameOver?.({ score, best, newBest });
  }
  function kick(a: number) { if (!reduced) shake = Math.max(shake, a); }
  const cometPos = (c: Comet) => ({ x: cx + UX[c.lane] * c.d, y: cy + UY[c.lane] * c.d });
  const heartX = (i: number, s: number) => iw - 6 - (LIVES - i) * (7 * s + 3) + 1;

  // ---------- update ----------
  function update(dt: number) {
    realT += dt;
    stateT += dt;
    hudPop += dt; multPop += dt; overPop += dt; bashAge += dt;
    if (shake > 0.4) {
      shake *= Math.exp(-dt * 18);
      shx = Math.round(rand(-shake, shake)); shy = Math.round(rand(-shake, shake));
    } else { shake = 0; shx = 0; shy = 0; }
    if (state === "paused") return;
    for (const p of pops) p.t += dt;
    pops = pops.filter((p) => p.t < p.life);
    if (hitstop > 0) { hitstop -= dt; return; }
    gt += dt;
    step(dt);
  }

  function step(dt: number) {
    // shield swings the short way round, quickly
    const target = LANE_ANG[shDir];
    if (reduced) shA = target;
    else shA = wrapAngle(shA + wrapAngle(target - shA) * (1 - Math.exp(-dt * 38)));

    if (state === "play" || state === "title") coreIn = Math.min(1, coreIn + dt / 0.35);
    coreHurt = Math.max(0, coreHurt - dt);
    coreHappy = Math.max(0, coreHappy - dt);
    coreTint = Math.max(0, coreTint - dt / 0.3);
    if (blink > 0) blink -= dt;
    else if ((blinkIn -= dt) <= 0) { blink = 0.12; blinkIn = rand(2.2, 4.5); }

    if (state === "play") planRun();
    else if (state === "title") planAttract();
    if (state === "title" || (bot && state === "play")) botThink();

    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i];
      if (c.st === "out") {
        c.out += dt;
        c.d += 240 * dt;
        if (c.d > laneLen(c.lane) + 40) comets.splice(i, 1);
        continue;
      }
      c.d = RS + c.v * (c.hitT - gt);
      if (c.d > RS + 0.5) continue;
      if (shDir === c.lane) {
        const perfect = state === "title" ? c.botBash : gt - bashT[c.lane] <= PERFECT_WIN + 1e-6;
        block(c, perfect);
      } else if (c.d <= CORE_R + 2) {
        if (state === "title") { comets.splice(i, 1); continue; }
        coreHit(c);
        if (state !== "play") break;
      }
    }
    if (pending && gt - pending.t > PERFECT_WIN) { bashLock = gt + WHIFF_LOCK; pending = null; }

    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.t += dt;
      if (p.t >= p.life) { parts.splice(i, 1); continue; }
      const drag = Math.exp(-dt * 3);
      p.vx *= drag; p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (const r of rings) r.t += dt;
    rings = rings.filter((r) => r.t < r.life);
    for (let i = falls.length - 1; i >= 0; i--) {
      const f = falls[i];
      f.t += dt; f.vy += 300 * dt; f.x += f.vx * dt; f.y += f.vy * dt;
      if (f.y > ih + 20) falls.splice(i, 1);
    }

    // HUD count-up: quick at first, then settles on the real score
    if (shown < score) shown = Math.min(score, shown + Math.max(1, Math.ceil((score - shown) * Math.min(1, dt * 12))));

    if (state === "dying" && stateT > 1.1) enterOver();
    else if (state === "over") updateOver();
  }

  function botThink() {
    let next: Comet | null = null;
    for (const c of comets) if (c.st === "in" && (!next || c.hitT < next.hitT)) next = c;
    if (!next || next.botMiss) return;
    const left = next.hitT - gt;
    if (state === "title") { if (left < 0.3 && shDir !== next.lane) turn(next.lane, false); return; }
    if (left < 0.22 && shDir !== next.lane) turn(next.lane, false);
    if (next.botBash && left < 0.06 && left > 0) { next.botBash = false; turn(next.lane, true); }
  }

  function updateOver() {
    const dur = clamp(0.5 + score / 700, 0.6, 1.7);
    const k = clamp((stateT - 0.35) / dur, 0, 1);
    const val = Math.round(score * easeOutCubic(k));
    if (val !== overShown) {
      overShown = val;
      if (realT - lastTick > 0.04) { lastTick = realT; play("tick", k); }
    }
    if (k >= 1 && !overDone) finishCount();
    if (bot && stateT > 3) retry();
  }
  function finishCount() {
    overShown = score; overDone = true; overPop = 0;
    play(newBest ? "best" : "land");
    if (newBest) {
      const y = cy - 6;
      for (let i = 0; i < (reduced ? 10 : 22); i++) {
        const a = rand(0, Math.PI * 2), sp = rand(40, 120);
        parts.push({ x: cx + rand(-20, 20), y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, t: 0, life: rand(0.5, 0.9), c: i % 2 ? GOLD : WHITE, s: Math.random() < 0.4 ? 2 : 1, g: 200 });
      }
    }
  }

  // ---------- render ----------
  function render() {
    if (!img) return;
    ox = cx + shx; oy = cy + shy;
    buf.fill(SKY);
    drawStars();
    drawPlanet();
    drawRails();
    drawWarnings();
    for (const c of comets) if (c.st === "in") drawComet(c);
    if (state !== "dying" && state !== "over") { drawShield(); drawCore(); }
    for (const c of comets) if (c.st === "out") drawComet(c);
    drawBand();
    for (const r of rings) {
      if (r.t < 0) continue;
      const k = r.t / r.life;
      circleOutline(r.x + shx, r.y + shy, 2 + easeOutCubic(k) * r.r, k > 0.65 ? mix(r.c, SKY, 0.5) : r.c);
    }
    for (const p of parts) {
      const s = p.t > p.life * 0.6 ? 1 : p.s;
      rect(Math.round(p.x + shx), Math.round(p.y + shy), s, s, p.t > p.life * 0.8 ? mix(p.c, SKY, 0.45) : p.c);
    }
    for (const p of pops) drawPopup(p);
    if (state !== "title") drawHud();
    drawOverlay();
    g2d.putImageData(img, 0, 0);
  }

  function drawStars() {
    for (const s of stars) {
      const tw = reduced ? 0 : Math.sin(realT * 1.3 + s.ph);
      const c = s.big || tw > 0.75 ? STAR : STAR_DIM;
      pset(s.x, s.y, c);
      if (s.big) { pset(s.x - 1, s.y, STAR_DIM); pset(s.x + 1, s.y, STAR_DIM); pset(s.x, s.y - 1, STAR_DIM); pset(s.x, s.y + 1, STAR_DIM); }
    }
  }

  function drawPlanet() {
    const px = iw - 34, py = ih - 30, r = 13;
    const ring = (front: boolean) => {
      for (let k = -24; k <= 24; k++) {
        const e = Math.sqrt(Math.max(0, 1 - (k / 24) ** 2)) * 5;
        const y = Math.round(py + 2 + (front ? e : -e) - k * 0.18);
        if (!front && Math.abs(k) < r && Math.abs(y - py) < r) continue;
        pset(px + k, y, front ? PLANET.ring : PLANET.ringDark);
      }
    };
    ring(false);
    for (let dy = -r; dy < r; dy++) {
      for (let dx = -r; dx < r; dx++) {
        const fx = dx + 0.5, fy = dy + 0.5, d = Math.hypot(fx, fy);
        if (d > r) continue;
        let c = (Math.floor((fy + 20 + fx * 0.15) / 4) % 2) ? PLANET.band : PLANET.body;
        if (fx * 0.6 + fy * 0.8 > r * 0.45) c = PLANET.shade;
        pset(px + dx, py + dy, c);
      }
    }
    ring(true);
  }

  function drawRails() {
    // dotted lanes and the shield track: where comets come from and where the shield can go
    for (let lane = 0; lane < 4; lane++) {
      const len = laneLen(lane);
      for (let d = RS + 6; d < len; d += 4) pset(ox + UX[lane] * d - (UX[lane] < 0 ? 1 : 0), oy + UY[lane] * d - (UY[lane] < 0 ? 1 : 0), RAIL);
    }
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      pset(Math.floor(ox + Math.cos(a) * RS), Math.floor(oy + Math.sin(a) * RS), TRACK);
    }
  }

  function drawWarnings() {
    // a small arrow at the screen edge just before a comet enters its lane
    for (const c of comets) {
      if (c.st !== "in") continue;
      const len = laneLen(c.lane);
      const tv = (c.d - len) / c.v;
      if (tv <= 0 || tv > 0.5) continue;
      const sz = 2 + (reduced ? 0 : Math.sin(realT * 12) > 0 ? 1 : 0);
      const col = STYLES[c.kind].head;
      for (let e = 0; e <= sz; e++) {
        const half = sz - e, along = len - 3 - e;
        for (let w = -half; w <= half; w++) {
          const x = c.lane % 2 === 0 ? ox + w : ox + UX[c.lane] * along - (UX[c.lane] < 0 ? 1 : 0);
          const y = c.lane % 2 === 0 ? oy + UY[c.lane] * along - (UY[c.lane] < 0 ? 1 : 0) : oy + w;
          pset(x, y, col);
        }
      }
    }
  }

  function drawComet(c: Comet) {
    const st = STYLES[c.kind];
    const sx = UX[c.lane], sy = UY[c.lane];
    // incoming comets trail outward, thrown back ones trail toward the keeper
    const dir = c.st === "in" ? 1 : -1;
    const hx = Math.floor(ox + sx * c.d), hy = Math.floor(oy + sy * c.d);
    if (hx < -30 || hx > iw + 30 || hy < -30 || hy > ih + 30) return;
    const fade = c.st === "out" ? clamp(c.out / 0.5, 0, 1) : 0;
    const col = (v: number) => (fade > 0 ? mix(v, SKY, fade * 0.7) : v);
    const px = -sy, py = sx; // perpendicular
    if (c.kind === "heart") {
      const bob = reduced ? 0 : Math.round(Math.sin(realT * 8 + c.hitT) * 1);
      for (let i = 5; i < 5 + st.len * 2; i += 3) pset(hx + sx * i * dir + px * bob, hy + sy * i * dir + py * bob, col(st.trail[Math.min(2, Math.floor((i - 5) / 4))]));
      heart(hx - 3 + px * bob, hy - 3 + py * bob, 1, col(HEART_FULL), true);
      return;
    }
    const L = st.len;
    for (let i = 2; i < L + 6; i++) {
      const k = i / L;
      if (i >= L && (i - L) % 2) continue;
      const c3 = k < 0.35 ? st.trail[0] : k < 0.7 ? st.trail[1] : st.trail[2];
      const w = i < st.wide ? 1 : 0;
      const x = hx + sx * i * dir, y = hy + sy * i * dir;
      pset(x, y, col(c3));
      if (w) { pset(x + px, y + py, col(c3)); pset(x - px, y - py, col(c3)); }
    }
    // head: a small plus with a bright core
    rect(hx - 1, hy - 1, 3, 3, col(st.head));
    pset(hx - 2, hy, col(st.head)); pset(hx + 2, hy, col(st.head)); pset(hx, hy - 2, col(st.head)); pset(hx, hy + 2, col(st.head));
    pset(hx, hy, col(st.core));
    if (c.kind === "gold" && !reduced) {
      // gentle sparkle orbiting the gold comet
      const a = realT * 6 + c.hitT * 3;
      pset(hx + Math.round(Math.cos(a) * 4), hy + Math.round(Math.sin(a) * 4), st.core);
    }
  }

  function drawShield() {
    const pop = bashAge < 0.1 ? Math.round(2 * (1 - bashAge / 0.1)) : 0;
    const bright = bashAge < 0.07;
    const R = RS + pop, lim = R + 3;
    for (let dy = -lim; dy <= lim; dy++) {
      for (let dx = -lim; dx <= lim; dx++) {
        const fx = dx + 0.5, fy = dy + 0.5;
        const d = Math.hypot(fx, fy);
        if (d < R - 1.6 || d > R + 1.6) continue;
        const diff = Math.abs(wrapAngle(Math.atan2(fy, fx) - shA));
        if (diff > ARC) continue;
        let c = d > R + 0.55 ? SHIELD.edge : d < R - 0.55 ? SHIELD.inner : SHIELD.main;
        if (diff > ARC - 0.09) c = SHIELD.inner;
        if (bright && c !== SHIELD.inner) c = SHIELD.bash;
        pset(ox + dx, oy + dy, c);
      }
    }
  }

  function drawCore() {
    const s = coreIn >= 1 ? 1 : reduced ? coreIn : easeOutBack(coreIn);
    const R = Math.max(1, Math.round(CORE_R * s));
    const body = coreTint > 0 ? mix(CORE.body, RED, coreTint * 0.7) : CORE.body;
    const shade = coreTint > 0 ? mix(CORE.shade, RED, coreTint * 0.7) : CORE.shade;
    // soft glow ring
    circleOutline(ox, oy, R + 3, mix(SKY, CORE.body, 0.18));
    for (let dy = -R - 1; dy <= R; dy++) {
      for (let dx = -R - 1; dx <= R; dx++) {
        const fx = dx + 0.5, fy = dy + 0.5, d = Math.hypot(fx, fy);
        if (d > R + 1) continue;
        let c = d > R ? CORE.line : body;
        if (d <= R && (fx * 0.6 + fy * 0.8) / R > 0.42) c = shade;
        pset(ox + dx, oy + dy, c);
      }
    }
    if (R < 6) return;
    rect(ox - 5, oy - 6, 2, 2, CORE.light); // highlight
    pset(ox - 6, oy - 4, CORE.light);
    // face looks toward the shield
    const lx = UX[shDir], ly = UY[shDir];
    const ex = ox + lx, ey = oy - 2 + ly;
    if (coreHurt > 0) {
      for (const sx of [-4, 2]) { rect(ex + sx, ey + 1, 3, 1, CORE.eye); pset(ex + sx + (sx < 0 ? 0 : 2), ey, CORE.eye); }
      rect(ex - 1, ey + 5, 3, 2, CORE.eye);
    } else if (coreHappy > 0) {
      for (const sx of [-4, 2]) { pset(ex + sx, ey + 1, CORE.eye); pset(ex + sx + 1, ey, CORE.eye); pset(ex + sx + 2, ey + 1, CORE.eye); }
      rect(ex - 1, ey + 5, 3, 1, CORE.eye);
      pset(ex - 2, ey + 4, CORE.eye); pset(ex + 2, ey + 4, CORE.eye);
    } else {
      const h = blink > 0 ? 1 : 3, y0 = blink > 0 ? ey + 1 : ey;
      rect(ex - 3, y0, 2, h, CORE.eye); rect(ex + 2, y0, 2, h, CORE.eye);
      rect(ex, ey + 5, 1, 1, CORE.eye);
    }
    pset(ex - 5, ey + 4, CORE.cheek); pset(ex + 5, ey + 4, CORE.cheek);
    // cracks for every heart lost
    if (lives <= 2) { pset(ox + 4, oy - 7, CORE.line); pset(ox + 3, oy - 6, CORE.line); pset(ox + 4, oy - 5, CORE.line); pset(ox + 3, oy - 4, CORE.line); }
    if (lives <= 1) { pset(ox - 7, oy + 3, CORE.line); pset(ox - 6, oy + 4, CORE.line); pset(ox - 5, oy + 3, CORE.line); pset(ox - 4, oy + 4, CORE.line); pset(ox - 4, oy + 5, CORE.line); }
  }

  function drawPopup(p: Popup) {
    const rise = Math.round(easeOutCubic(Math.min(1, p.t / 0.45)) * 8);
    const fp = p.t < 0.06 && !reduced ? p.fp + 1 : p.fp;
    const x = clamp(p.x, textWidth(p.sub || p.text, 1) / 2 + 3, iw - textWidth(p.sub || p.text, 1) / 2 - 3);
    textC(p.text, x, p.y - rise, fp, p.c);
    if (p.sub) textC(p.sub, x, p.y - rise - 10, 1, p.c);
  }

  function drawHud() {
    const fp = hudFp();
    const p = hudPop;
    let fx = fp, fy = fp, col = WHITE;
    if (!reduced && p < 0.05) { fx = fp + 1; fy = fp - 1; col = hudFlash; }
    else if (!reduced && p < 0.1) { fy = fp + 1; col = hudFlash; }
    else if (p < 0.18) col = hudFlash;
    const str = String(shown);
    const x0 = 6, base = 6 + 7 * fp;
    for (let pass = 0; pass < 2; pass++) {
      let x = x0;
      for (const ch of str) { glyph(ch, x, base - 7 * fy, fx, fy, pass === 0 ? INK : col, pass); x += 6 * fx; }
    }
    // multiplier and the streak pips toward the next one
    const my = base + 6;
    const mfp = multPop < 0.08 && !reduced ? 2 : 1;
    const mt = "x" + mult;
    text(mt, x0, my, mfp, mult > 1 ? GOLD : DIM);
    if (mult < 5) {
      const px0 = x0 + textWidth(mt, mfp) + 4, filled = combo % 10;
      for (let i = 0; i < 10; i++) rect(px0 + i * 3, my + 3, 2, 2, i < filled ? GOLD : HEART_EMPTY);
    }
    // hearts
    const hs = Math.max(1, fp - 1);
    for (let i = 0; i < LIVES; i++) heart(heartX(i, hs), 6, hs, i < lives ? HEART_FULL : HEART_EMPTY, true);
    for (const f of falls) heart(Math.round(f.x), Math.round(f.y), hs, mix(HEART_FULL, SKY, clamp(f.t / 0.8, 0, 0.7)), false);
  }

  /** Dark glass strip behind the pause and game over text, under the particles. */
  function drawBand() {
    if (state === "paused") shadeRows(cy - 22, cy + 24, 0.55);
    else if (state === "over") shadeRows(cy - 40, cy + 44, 0.55 * clamp(stateT / 0.3, 0, 1));
  }

  function drawOverlay() {
    const slow = Math.floor(realT * 1.6) % 2 === 0;
    if (state === "title") {
      const fp = ih >= 260 && iw >= 260 ? 4 : 3;
      const word = (wd: string, y: number, hue: number[]) => {
        const x0 = Math.round(iw / 2 - textWidth(wd, fp) / 2);
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < wd.length; i++) {
            const bob = reduced ? 0 : Math.round(Math.sin(realT * 3.5 + i * 0.7) * 1.5);
            glyph(wd[i], x0 + i * 6 * fp, y + bob, fp, fp, pass === 0 ? INK : hue[i % hue.length], pass);
          }
        }
      };
      const y = Math.max(8, Math.round(ih * 0.07));
      word("COMET", y, [STYLES.normal.head, STYLES.gold.head, STYLES.normal.head, STYLES.gold.head, STYLES.normal.head]);
      word("KEEPER", y + 7 * fp + 5, [SHIELD.main, SHIELD.edge]);
      if (best > 0) textC("BEST " + best, iw / 2, y + 14 * fp + 12, 1, GOLD);
      const by = ih - 42;
      if (slow) textC("PRESS SPACE TO START", iw / 2, by, 1, WHITE);
      textC("ARROWS OR MOUSE TO GUARD", iw / 2, by + 12, 1, PALE);
      textC("TAP AS IT HITS FOR PERFECT", iw / 2, by + 23, 1, DIM);
    } else if (state === "paused") {
      textC("PAUSED", iw / 2, cy - 14, 2, WHITE);
      if (slow) textC("PRESS SPACE TO RESUME", iw / 2, cy + 8, 1, PALE);
    } else if (state === "over") {
      if (stateT < 0.3) return;
      const big = iw >= 200 ? 4 : 3;
      textC("SCORE", iw / 2, cy - 33, 1, DIM);
      const fp = overPop < 0.07 && !reduced ? big + 1 : big;
      textC(String(overShown), iw / 2, cy - 22 - (fp - big) * 3, fp, newBest && overDone ? GOLD : WHITE);
      if (overDone) {
        if (newBest) {
          const wd = "NEW BEST!", x0 = Math.round(iw / 2 - textWidth(wd, 2) / 2);
          for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < wd.length; i++) {
              const bob = reduced ? 0 : Math.round(Math.sin(realT * 6 + i * 0.6) * 1.2);
              glyph(wd[i], x0 + i * 12, cy + 14 + bob, 2, 2, pass === 0 ? INK : GOLD, pass);
            }
          }
        } else textC("BEST " + best, iw / 2, cy + 16, 1, GOLD);
        if (slow && stateT > 0.9) textC("PRESS SPACE TO RETRY", iw / 2, cy + 33, 1, PALE);
      }
    }
  }

  // ---------- input ----------
  function press() {
    ensureAudio();
    if (state === "title") startGame();
    else if (state === "play") turn(shDir, true);
    else if (state === "paused") resume();
    else if (state === "over") {
      if (!overDone) finishCount();
      else if (stateT > 0.9) retry();
    }
  }
  function aim(lane: number) {
    ensureAudio();
    if (state === "title") { shDir = lane; startGame(); return; }
    if (state === "play") turn(lane, true);
    else if (state === "paused") resume();
    else if (state === "over" && overDone && stateT > 1.2) retry();
  }
  function pause() {
    if (state !== "play") return;
    pausedFrom = state; state = "paused"; stateT = 0;
    play("click");
  }
  function resume() {
    if (state !== "paused") return;
    state = pausedFrom; stateT = 1;
    play("click");
  }
  function setMuted(m: boolean) {
    muted = !!m;
    save(storageKey + ".muted", muted ? 1 : 0);
    if (!muted) { ensureAudio(); play("click"); }
  }
  function laneAt(e: PointerEvent): number | null {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * iw - cx, y = ((e.clientY - r.top) / r.height) * ih - cy;
    if (Math.hypot(x, y) < 5) return null;
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? 1 : 3) : (y > 0 ? 2 : 0);
  }
  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    const lane = laneAt(e);
    if (state === "play" && lane != null) aim(lane);
    else press();
  }
  function onPointerMove(e: PointerEvent) {
    if (e.pointerType !== "mouse" || state !== "play") return;
    const lane = laneAt(e);
    if (lane != null && lane !== shDir) turn(lane, false);
  }
  function onContextMenu(e: Event) { e.preventDefault(); }
  const KEY_LANE: Record<string, number> = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 };
  function onKey(ev: Event) {
    const e = ev as KeyboardEvent;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const lane = KEY_LANE[e.code];
    if (lane != null) {
      e.preventDefault();
      if (!e.repeat) aim(lane);
    } else if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      if (!e.repeat) press();
    } else if (e.code === "KeyP" && !e.repeat) {
      if (state === "paused") resume(); else pause();
    } else if (e.code === "KeyM" && !e.repeat) setMuted(!muted);
  }
  const onBlur = () => pause();

  // ---------- loop ----------
  let raf = 0, last = performance.now();
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    update(dt);
    render();
  }
  const onVisibility = () => { last = performance.now(); if (document.hidden) pause(); };

  resize();
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("contextmenu", onContextMenu);
  keyTarget.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", resize);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  ro?.observe(host);
  raf = requestAnimationFrame(frame);

  return {
    press,
    setMuted,
    isMuted: () => muted,
    setVolume(v: number) {
      volume = clamp(+v || 0, 0, 1);
      save(storageKey + ".volume", Math.round(volume * 100) / 100);
      sfx?.setVolume(volume);
    },
    getVolume: () => volume,
    setBot: (b: boolean) => { bot = !!b; },
    getState: () => ({ state, score, best, lives, combo, mult, muted, time: state === "title" ? 0 : gt - runStart }),
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("contextmenu", onContextMenu);
      keyTarget.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", resize);
      ro?.disconnect();
      if (ac) { ac.close().catch(() => {}); ac = null; sfx = null; }
    },
  };
}
