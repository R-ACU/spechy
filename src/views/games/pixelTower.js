/*
  Pixel Tower for Spechy's Games tab: an ES module port of the standalone minigame in
  projects/games/pixel-tower/game.js (that folder stays the browser test version; port
  gameplay fixes in both directions). Differences: ES exports instead of window.PixelTower,
  own storage keys (spechy.games.pixelTower.best and .muted), and destroy() also removes the
  context menu listener. The pixel palette is game art and keeps its own colours.

    const game = create(canvas, { keyTarget: panel, onGameOver });
    game.tap(); game.setMuted(true); game.getState(); game.destroy();

  The canvas fills its parent element, so give the parent a size.
*/
const root = window;


// ---------- tuning ----------
const S = 40;            // start footprint of a block in world units (even)
const H = 8;             // block height
const RANGE = 64;        // how far the sliding block travels from the centre
const HUE_STEP = 8;      // hue change per block
const SHORT_SIDE = 190;  // internal pixels across the shorter screen side

// ---------- helpers ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => { const c = 1.9; t -= 1; return 1 + (c + 1) * t * t * t + c * t * t; };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function hash(n) {
  n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  n ^= n >>> 13; n = Math.imul(n, 0xc2b2ae35); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

// colours are packed as 0xAABBGGRR for the Uint32 view of ImageData
const pack = (c) => (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mixc = (a, b, t) => [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];

function hsl(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

// pixel-art hue shifting: shadows drift to blue, highlights drift to yellow
function hueToward(h, target, amt) {
  const d = ((target - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), amt);
}

function blockPalette(h, sat = 1) {
  const warm = (a) => hueToward(h, 50, a), cool = (a) => hueToward(h, 245, a);
  const top = hsl(warm(6), 64 * sat, 76);
  return {
    top: pack(top),
    rim: pack(hsl(warm(12), 82 * sat, 90)),
    edge: pack(hsl(warm(6), 60 * sat, 72)),
    left: pack(hsl(cool(10), 52 * sat, 62)),
    right: pack(hsl(cool(22), 46 * sat, 47)),
    seamL: pack(hsl(cool(16), 50 * sat, 55)),
    seamR: pack(hsl(cool(28), 46 * sat, 40)),
  };
}

const WHITE = pack([255, 255, 255]);
const GOLD = pack(hex('#ffd84a'));
const INK = pack(hex('#1b1530'));
const DIM = pack(hex('#8a84a3'));
const DUST = pack(hex('#f4f1ea'));
const SHUTTER = pack(hex('#141024'));
const PALE = pack([214, 214, 226]);
const FLASH = { top: WHITE, rim: WHITE, edge: WHITE, left: WHITE, right: PALE, seamL: WHITE, seamR: PALE };

// sky colour by tower height (in blocks)
const SKY = [
  [0, '#8fd1bf'], [18, '#f3d3a6'], [34, '#f0a98f'], [50, '#c47a9b'],
  [66, '#6f5596'], [82, '#36306a'], [100, '#1a1838'], [140, '#0b0a18'],
].map(([b, c]) => [b, hex(c)]);

function skyAt(blocks) {
  if (blocks <= SKY[0][0]) return SKY[0][1];
  for (let i = 1; i < SKY.length; i++) {
    if (blocks < SKY[i][0]) {
      const [b0, c0] = SKY[i - 1], [b1, c1] = SKY[i];
      return mixc(c0, c1, (blocks - b0) / (b1 - b0));
    }
  }
  return SKY[SKY.length - 1][1];
}

// ---------- 5x7 pixel font ----------
const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '10001', '01010', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};
const FONT = {};
for (const ch in GLYPHS) {
  const px = [];
  GLYPHS[ch].forEach((row, y) => { for (let x = 0; x < 5; x++) if (row[x] === '1') px.push(x, y); });
  FONT[ch] = px;
}
const advance = (ch, fp) => (ch === ' ' ? 4 * fp : 6 * fp);
const textWidth = (str, fp) => { let w = 0; for (const ch of str) w += advance(ch, fp); return Math.max(0, w - fp); };

// ---------- sound (Web Audio synthesis) ----------
function createSfx(ac, out) {
  const master = ac.createGain();
  master.gain.value = 0.8;
  const shaper = ac.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6); }
  shaper.curve = curve;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 4;
  comp.attack.value = 0.002; comp.release.value = 0.15;
  // Makeup gain after the compressor: the bank was too quiet next to other apps.
  const post = ac.createGain();
  post.gain.value = 1.6;
  master.connect(shaper); shaper.connect(comp); comp.connect(post); post.connect(out || ac.destination);

  const noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  function env(g, t, a, vol, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  // oscillator with optional exponential pitch sweep from f0 to f1 over `sweep` seconds
  function osc(type, f0, f1, sweep, t, a, d, vol) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (sweep > 0 && f1 > 0 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    env(g, t, a, vol, d);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + a + d + 0.05);
  }
  // filtered noise burst, filter frequency sweeps from f0 to f1
  function nz(type, f0, f1, q, t, a, d, vol) {
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
  const STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

  return {
    setVolume(v) {
      master.gain.setTargetAtTime(1.0 * v, ac.currentTime, 0.02);
    },
    place() {
      const t = now(), r = 1 + (Math.random() - 0.5) * 0.08;
      osc('sine', 200 * r, 50, 0.09, t, 0.002, 0.17, 0.45);         // body
      osc('triangle', 820 * r, 360, 0.045, t, 0.001, 0.08, 0.8);   // tock, audible on laptop speakers
      osc('square', 520 * r, 180, 0.05, t, 0.001, 0.06, 0.22);      // knock
      nz('bandpass', 3400 * r, 0, 1.4, t, 0.001, 0.04, 0.9);         // click
      nz('bandpass', 1400, 400, 0.8, t, 0.002, 0.09, 0.5);         // air
    },
    slice() {
      const t = now();
      nz('bandpass', 7000, 1700, 2.2, t, 0.002, 0.12, 0.45);
      osc('square', 1500, 280, 0.09, t, 0.001, 0.09, 0.06);
    },
    perfect(combo) {
      const t = now();
      const f = 587.33 * Math.pow(2, STEPS[Math.min(combo - 1, STEPS.length - 1)] / 12);
      osc('sine', 250, 44, 0.12, t, 0.002, 0.24, 0.6);              // heavy thump
      osc('triangle', 900, 400, 0.05, t, 0.001, 0.09, 0.7);           // tock
      nz('highpass', 4200, 0, 0.7, t, 0.001, 0.035, 0.45);
      nz('lowpass', 1800, 200, 0.7, t, 0.002, 0.12, 0.45);
      osc('square', f, f, 0, t, 0.002, 0.07, 0.12);                 // chime, rises with combo
      osc('square', f * 1.5, f * 1.5, 0, t + 0.06, 0.002, 0.24, 0.1);
      osc('triangle', f * 3, f * 3, 0, t + 0.06, 0.002, 0.34, 0.14);
      osc('triangle', f * 3, f * 3, 0, t + 0.18, 0.002, 0.22, 0.05);
      nz('highpass', 6500, 0, 0.7, t + 0.01, 0.02, 0.22, 0.12);     // shimmer
      if (combo >= 3) osc('sine', 92, 32, 0.4, t, 0.003, 0.5, 0.75); // sub boom
    },
    grow() {
      const t = now() + 0.1;
      [1, 1.26, 1.5, 2].forEach((m, i) => osc('triangle', 1046 * m, 1046 * m, 0, t + i * 0.035, 0.002, 0.12, 0.09));
    },
    miss() {
      const t = now();
      osc('sine', 170, 26, 0.5, t, 0.002, 0.75, 0.55);
      osc('square', 260, 70, 0.35, t, 0.002, 0.45, 0.35);
      nz('bandpass', 1100, 300, 1.0, t, 0.002, 0.35, 0.9);
      nz('lowpass', 2400, 80, 0.8, t, 0.002, 0.5, 0.85);
      osc('sawtooth', 260, 38, 0.45, t, 0.003, 0.5, 0.13);
      nz('bandpass', 1600, 260, 1.2, t + 0.12, 0.12, 0.45, 0.22);   // falling whoosh
    },
    over() {
      const t = now();
      osc('square', 392, 392, 0, t, 0.003, 0.12, 0.07);
      osc('square', 294, 262, 0.2, t + 0.13, 0.003, 0.3, 0.07);
    },
    best() {
      const t = now();
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
        osc('square', f, f, 0, t + i * 0.07, 0.002, i === 3 ? 0.4 : 0.1, 0.07);
        osc('triangle', f * 2, f * 2, 0, t + i * 0.07, 0.002, i === 3 ? 0.5 : 0.12, 0.08);
      });
      nz('highpass', 7000, 0, 0.7, t + 0.21, 0.03, 0.4, 0.08);
    },
    milestone(big) {
      const t = now() + 0.05;
      osc('triangle', 1568, 1568, 0, t, 0.002, 0.45, 0.13);
      osc('sine', 3136, 3136, 0, t, 0.002, 0.3, 0.05);
      osc('square', 784, 784, 0, t, 0.002, 0.06, 0.05);
      if (big) [1175, 1568, 2349].forEach((f, i) => osc('triangle', f, f, 0, t + 0.08 + i * 0.05, 0.002, 0.2, 0.08));
    },
    start() {
      const t = now();
      osc('square', 523, 523, 0, t, 0.002, 0.06, 0.08);
      osc('square', 784, 784, 0, t + 0.07, 0.002, 0.12, 0.08);
    },
    swish() {
      const t = now();
      nz('bandpass', 400, 2800, 1, t, 0.08, 0.14, 0.22);
    },
    click() {
      const t = now();
      osc('square', 1800, 1800, 0, t, 0.001, 0.02, 0.05);
    },
  };
}

// ---------- game ----------
function create(canvas, opts = {}) {
  const ctx2d = canvas.getContext('2d', { alpha: false });
  const host = canvas.parentElement || document.body;
  const reduced = opts.reducedMotion != null ? !!opts.reducedMotion
    : !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const storageKey = opts.storageKey || 'spechy.games.pixelTower.best';
  const shortSide = opts.shortSide || SHORT_SIDE;
  const keyTarget = opts.keyTarget || root;

  const load = (k) => { try { return parseInt(root.localStorage.getItem(k), 10) || 0; } catch (e) { return 0; } };
  const save = (k, v) => { try { root.localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } };

  // framebuffer
  let iw = 0, ih = 0, img = null, buf = null;
  let ax = 0, ay = 0, OX = 0, OY = 0, Z = 1;
  let clipX0 = 0, clipY0 = 0, clipX1 = 0, clipY1 = 0;

  // world and game state
  let state = 'title', score = 0, best = load(storageKey), combo = 0;
  let muted = opts.muted != null ? !!opts.muted : load(storageKey + '.muted') === 1;
  let volume = (() => {
    if (opts.volume != null) return clamp(+opts.volume || 0, 0, 1);
    try { const v = parseFloat(root.localStorage.getItem(storageKey + '.volume')); return isNaN(v) ? 0.8 : clamp(v, 0, 1); } catch (e) { return 0.8; }
  })();
  let bot = !!opts.bot;
  let blocks = [], moving = null, debris = [], particles = [], rings = [], popups = [], sparks = [];
  let hue0 = rand(0, 360);
  const foundation = { x0: -S / 2, x1: S / 2, z0: -S / 2, z1: S / 2, y0: -4000, y1: 0, pal: blockPalette(260, 0.22) };
  let cam = { x: 0, y: 0, z: 0, zoom: 1 };
  let shakeAmp = 0, shakeX = 0, shakeY = 0;
  let hitstop = 0, transition = null;
  let realTime = 0, stateT = 0, newBest = false, bestAnnounced = false;
  let sfxRect = null;
  const hud = { str: '0', digits: [{ ch: '0', prev: '0', t: 1 }], w: 0, pop: 1, flash: WHITE, mega: 9 };

  // ---------- audio ----------
  let ac = null, sfx = null;
  function ensureAudio() {
    if (!ac) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      sfx = createSfx(ac);
      sfx.setVolume(volume);
    }
    if (ac.state === 'suspended') ac.resume();
  }
  function play(name, arg) {
    if (muted || !sfx || volume <= 0) return;
    try { sfx[name](arg); } catch (e) { /* audio is optional */ }
  }

  // ---------- framebuffer primitives ----------
  function resetClip() { clipX0 = 0; clipY0 = 0; clipX1 = iw; clipY1 = ih; }
  function rect(x, y, w, h, c) {
    let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
    if (x0 < clipX0) x0 = clipX0; if (y0 < clipY0) y0 = clipY0;
    if (x1 > clipX1) x1 = clipX1; if (y1 > clipY1) y1 = clipY1;
    if (x1 <= x0 || y1 <= y0) return;
    for (let yy = y0; yy < y1; yy++) buf.fill(c, yy * iw + x0, yy * iw + x1);
  }
  function vspan(x, y0, y1, c) {
    if (x < 0 || x >= iw) return;
    if (y0 < 0) y0 = 0; if (y1 > ih) y1 = ih;
    for (let y = y0; y < y1; y++) buf[y * iw + x] = c;
  }
  function pset(x, y, c) { if (x >= 0 && x < iw && y >= 0 && y < ih) buf[y * iw + x] = c; }
  // Isometric box, rasterized column by column so every edge is a clean 2:1 pixel line.
  // (sxD, syD) is the left corner of the top face, w/d are even widths along x/z, h is height.
  function drawBox(sxD, syD, w, d, h, pal) {
    const W = w + d, hw = w >> 1, hd = d >> 1;
    if (sxD >= iw || sxD + W <= 0 || syD - hd >= ih || syD + hw + h < 0) return;
    const syB = syD - hd + hw;
    const seam = h > 2;
    for (let k = 0; k < W; k++) {
      const x = sxD + k;
      if (x < 0 || x >= iw) continue;
      const top = k < d ? syD - (k >> 1) : syB - ((W - 1 - k) >> 1);
      const left = k < w;
      const bot = left ? syD + 1 + (k >> 1) : syB + 1 + ((W - 1 - k) >> 1);
      vspan(x, top, bot - 1, pal.top);
      pset(x, bot - 1, pal.rim);
      const side = left ? (k === w - 1 ? pal.edge : pal.left) : pal.right;
      if (seam) {
        vspan(x, bot, bot + h - 1, side);
        pset(x, bot + h - 1, left ? pal.seamL : pal.seamR);
      } else vspan(x, bot, bot + h, side);
    }
  }
  function rhombusOutline(sxD, syD, w, d, c, dotted) {
    const W = w + d, hd = d >> 1, hw = w >> 1, syB = syD - hd + hw;
    for (let k = 0; k < W; k++) {
      if (dotted && (k & 2)) continue;
      const top = k < d ? syD - (k >> 1) : syB - ((W - 1 - k) >> 1);
      const bot = k < w ? syD + 1 + (k >> 1) : syB + 1 + ((W - 1 - k) >> 1);
      pset(sxD + k, top, c);
      pset(sxD + k, bot - 1, c);
    }
  }
  const projX = (x, z) => OX + Math.round((x - z) * Z);
  const projY = (x, y, z) => OY + Math.round(((x + z) / 2) * Z) - Math.round(y * Z);
  function projBox(b, pal, squash) {
    const s = squash || 0;
    const syTop = OY + Math.round(((b.x0 + b.z1) / 2) * Z) - Math.round(b.y1 * Z) + s;
    const h = Math.round(b.y1 * Z) - Math.round(b.y0 * Z) - s;
    drawBox(OX + Math.round((b.x0 - b.z1) * Z), syTop, even((b.x1 - b.x0) * Z), even((b.z1 - b.z0) * Z), h, pal);
  }

  // ---------- text ----------
  // pass 0 draws outline plus a 1px drop shadow, pass 1 the fill
  function glyph(ch, x, y, fx, fy, c, pass) {
    const px = FONT[ch];
    if (!px) return;
    if (pass === 0) for (let i = 0; i < px.length; i += 2) rect(x + px[i] * fx - 1, y + px[i + 1] * fy - 1, fx + 2, fy + 3, c);
    else for (let i = 0; i < px.length; i += 2) rect(x + px[i] * fx, y + px[i + 1] * fy, fx, fy, c);
  }
  function text(str, x, y, fp, fill, outline) {
    for (let pass = 0; pass < 2; pass++) {
      let cx = x;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        glyph(ch, cx, y, fp, fp, pass === 0 ? outline : (typeof fill === 'function' ? fill(i) : fill), pass);
        cx += advance(ch, fp);
      }
    }
  }
  const textC = (str, cx, y, fp, fill, outline) => text(str, Math.round(cx - textWidth(str, fp) / 2), Math.round(y), fp, fill, outline);

  // ---------- layout ----------
  function resize() {
    const cw = host.clientWidth || root.innerWidth, chh = host.clientHeight || root.innerHeight;
    const dpr = root.devicePixelRatio || 1;
    const dw = Math.max(1, Math.round(cw * dpr)), dh = Math.max(1, Math.round(chh * dpr));
    const scale = Math.max(2, Math.round(Math.min(dw, dh) / shortSide));
    const nw = Math.ceil(dw / scale), nh = Math.ceil(dh / scale);
    if (nw !== iw || nh !== ih) {
      iw = nw; ih = nh;
      canvas.width = iw; canvas.height = ih;
      img = ctx2d.createImageData(iw, ih);
      buf = new Uint32Array(img.data.buffer);
    }
    canvas.style.width = (iw * scale) / dpr + 'px';
    canvas.style.height = (ih * scale) / dpr + 'px';
    ax = iw >> 1;
    ay = Math.round(ih * 0.6);
    resetClip();
  }
  const scoreFp = () => (iw < 140 ? 2 : ih >= 250 && iw >= 180 ? 4 : 3);

  // ---------- world ----------
  const top = () => (blocks.length ? blocks[blocks.length - 1] : foundation);
  const palFor = (i) => blockPalette(hue0 + i * HUE_STEP);
  const speed = () => Math.min(78 + score * 2.0, 200);

  function spawnMoving() {
    const t = top();
    moving = {
      x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1, y0: t.y1, y1: t.y1 + H,
      axis: blocks.length % 2 === 0 ? 'x' : 'z', offset: -RANGE, dir: 1, age: 0,
      pal: palFor(blocks.length), aim: null,
    };
    placeMoving();
  }
  function placeMoving() {
    const t = top(), m = moving;
    if (m.axis === 'x') { m.x0 = t.x0 + m.offset; m.x1 = t.x1 + m.offset; }
    else { m.z0 = t.z0 + m.offset; m.z1 = t.z1 + m.offset; }
  }

  function drop() {
    const m = moving, t = top();
    if (!m || m.age < 0.1) return;
    const off = Math.round(m.offset / 2) * 2;
    const tol = Math.max(4, speed() * 0.03);
    const size = m.axis === 'x' ? t.x1 - t.x0 : t.z1 - t.z0;
    const b = { x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1, y0: t.y1, y1: t.y1 + H, pal: m.pal, t: 0 };
    if (Math.abs(off) <= tol) {
      combo++;
      const grew = combo >= 3 && grow(b, m.axis);
      place(b, true, grew);
    } else if (Math.abs(off) >= size) {
      miss(m, off);
    } else {
      combo = 0;
      const cut = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.y0, y1: b.y1, pal: m.pal };
      if (m.axis === 'x') {
        if (off > 0) { b.x0 = t.x0 + off; cut.x0 = t.x1; cut.x1 = t.x1 + off; }
        else { b.x1 = t.x1 + off; cut.x0 = t.x0 + off; cut.x1 = t.x0; }
      } else {
        if (off > 0) { b.z0 = t.z0 + off; cut.z0 = t.z1; cut.z1 = t.z1 + off; }
        else { b.z1 = t.z1 + off; cut.z0 = t.z0 + off; cut.z1 = t.z0; }
      }
      addDebris(cut, m.axis, Math.sign(off));
      chips(cut, m.axis, Math.sign(off));
      place(b, false, false);
    }
  }

  // a perfect streak gives some width back, never beyond the start size
  function grow(b, axis) {
    const wx = b.x1 - b.x0, wz = b.z1 - b.z0;
    if ((axis === 'x' ? wx : wz) >= S) axis = axis === 'x' ? 'z' : 'x';
    if (axis === 'x' && wx < S) { b.x0 -= 2; b.x1 = Math.min(b.x0 + S, b.x1 + 2); return true; }
    if (axis === 'z' && wz < S) { b.z0 -= 2; b.z1 = Math.min(b.z0 + S, b.z1 + 2); return true; }
    return false;
  }

  function place(b, perfect, grew) {
    blocks.push(b);
    moving = null;
    score = blocks.length;
    setScore(score, perfect ? GOLD : b.pal.top);
    if (perfect) {
      hitstop = 0.07 + Math.min(combo, 6) * 0.008;
      kick(2 + Math.min(combo, 4) * 0.6);
      rings.push({ b, t: 0, life: 0.34 }, { b, t: -0.08, life: 0.34 });
      sparkle(b, 10 + Math.min(combo, 6) * 2);
      popups.push({ text: 'PERFECT', sub: combo > 1 ? 'x' + combo : '', x: (b.x0 + b.x1) / 2, y: b.y1, z: (b.z0 + b.z1) / 2, t: 0, life: 0.8, fp: 2, shimmer: combo >= 3 });
      play('perfect', combo);
      if (grew) play('grow');
    } else {
      hitstop = 0.035;
      kick(1.6);
      dust(b);
      play('place');
      play('slice');
    }
    if (score % 10 === 0) {
      const big = String(score).length > String(score - 1).length;
      hud.mega = 0;
      burstHud(big ? 22 : 12);
      play('milestone', big);
    }
    if (!bestAnnounced && best > 0 && score > best) {
      bestAnnounced = true;
      const fp = scoreFp();
      popups.push({ text: 'NEW BEST', screen: true, x: iw / 2, y: hudY() + 7 * fp + 8, t: 0, life: 1.5, fp: 1, shimmer: true });
      play('best');
    }
    if (opts.onScore) opts.onScore(score);
    spawnMoving();
  }

  function miss(m, off) {
    const d = { x0: m.x0, x1: m.x1, z0: m.z0, z1: m.z1, y0: m.y0, y1: m.y1, pal: m.pal };
    if (m.axis === 'x') { d.x0 = Math.round(d.x0 / 2) * 2; d.x1 = d.x0 + (m.x1 - m.x0); }
    else { d.z0 = Math.round(d.z0 / 2) * 2; d.z1 = d.z0 + (m.z1 - m.z0); }
    addDebris(d, m.axis, Math.sign(off) || 1);
    moving = null; combo = 0;
    state = 'dying'; stateT = 0;
    hitstop = 0.13;
    kick(6);
    play('miss');
  }

  function addDebris(c, axis, sign) {
    const v = sign * rand(18, 40);
    debris.push({ ...c, vy: 0, vx: axis === 'x' ? v : 0, vz: axis === 'z' ? v : 0, front: sign > 0, t: 0 });
  }

  function enterOver() {
    state = 'over'; stateT = 0;
    newBest = score > best;
    if (newBest) { best = score; save(storageKey, best); }
    play(newBest ? 'best' : 'over');
    if (opts.onGameOver) opts.onGameOver({ score, best, newBest });
  }

  function resetWorld() {
    blocks = []; debris = []; particles = []; rings = []; popups = []; sparks = [];
    moving = null; combo = 0; score = 0; newBest = false; bestAnnounced = false;
    hitstop = 0;
    hue0 = rand(0, 360);
    cam = { x: 0, y: 0, z: 0, zoom: 1 };
    hud.str = '0'; hud.digits = [{ ch: '0', prev: '0', t: 1 }]; hud.pop = 1; hud.mega = 9;
    hud.w = textWidth('0', scoreFp());
  }

  function startGame() {
    state = 'play'; stateT = 0;
    if (!moving) spawnMoving();
    play('start');
  }
  function retry() {
    transition = { phase: 'close', t: 0, dur: 0.2 };
    play('swish');
  }

  // ---------- effects ----------
  function kick(a) { if (!reduced) shakeAmp = Math.max(shakeAmp, a); }
  function dust(b) {
    for (let i = 0; i < 12; i++) {
      const front = i % 2 === 0;
      particles.push({
        x: front ? rand(b.x0, b.x1) : b.x1 + 1, y: b.y0 + 1, z: front ? b.z1 + 1 : rand(b.z0, b.z1),
        vx: front ? rand(-10, 10) : rand(20, 50), vy: rand(10, 45), vz: front ? rand(20, 50) : rand(-10, 10),
        t: 0, life: rand(0.25, 0.45), c: DUST, s: Math.random() < 0.3 ? 2 : 1, g: 140,
      });
    }
  }
  function sparkle(b, n) {
    const cols = [WHITE, GOLD, b.pal.rim];
    for (let i = 0; i < n; i++) {
      particles.push({
        x: rand(b.x0, b.x1), y: b.y1, z: rand(b.z0, b.z1),
        vx: rand(-30, 30), vy: rand(90, 180), vz: rand(-30, 30),
        t: 0, life: rand(0.35, 0.65), c: cols[i % 3], s: Math.random() < 0.4 ? 2 : 1, g: 380,
      });
    }
  }
  function chips(c, axis, sign) {
    const cols = [c.pal.top, c.pal.left, c.pal.right, WHITE];
    for (let i = 0; i < 9; i++) {
      const along = axis === 'x';
      const face = sign > 0 ? (along ? c.x0 : c.z0) : (along ? c.x1 : c.z1);
      particles.push({
        x: along ? face : rand(c.x0, c.x1), y: rand(c.y0, c.y1), z: along ? rand(c.z0, c.z1) : face,
        vx: along ? sign * rand(30, 90) : rand(-15, 15), vy: rand(20, 100), vz: along ? rand(-15, 15) : sign * rand(30, 90),
        t: 0, life: rand(0.3, 0.6), c: cols[i % 4], s: Math.random() < 0.5 ? 2 : 1, g: 420,
      });
    }
  }
  function burstHud(n) {
    const fp = scoreFp(), cy = hudY() + (7 * fp) / 2;
    for (let i = 0; i < n; i++) {
      sparks.push({ x: iw / 2 + rand(-hud.w / 2 - 4, hud.w / 2 + 4), y: cy + rand(-4, 4), vx: rand(-70, 70), vy: rand(-110, -20), t: 0, life: rand(0.35, 0.7), c: i % 2 ? WHITE : GOLD });
    }
  }

  // ---------- HUD score: odometer roll, squash and stretch pop ----------
  const hudY = () => Math.max(5, Math.round(ih * 0.05));
  function setScore(n, flash) {
    const s = String(n), old = hud.str, out = [];
    for (let i = 0; i < s.length; i++) {
      const oi = i - (s.length - old.length);
      const oldCh = oi >= 0 ? old[oi] : ' ';
      out.push(oi >= 0 && oldCh === s[i] ? hud.digits[oi] : { ch: s[i], prev: oldCh, t: 0 });
    }
    hud.digits = out; hud.str = s; hud.pop = 0; hud.flash = flash;
  }
  function updateHud(dt) {
    for (const d of hud.digits) if (d.t < 1) d.t = Math.min(1, d.t + dt / 0.2);
    hud.pop += dt; hud.mega += dt;
    const target = textWidth(hud.str, scoreFp());
    hud.w += (target - hud.w) * (1 - Math.exp(-dt * 16));
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.t += dt;
      if (p.t >= p.life) { sparks.splice(i, 1); continue; }
      p.vy += 260 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }
  function drawScore() {
    const base = scoreFp() + (state === 'over' ? 1 : 0);
    const p = hud.pop, mega = hud.mega < 0.32;
    let fx = base, fy = base, col = WHITE;
    if (p < 0.05) { fx = base + 1; fy = base - 1; col = hud.flash; }
    else if (p < 0.11) { fx = base; fy = base + 1; col = hud.flash; }
    else if (p < 0.17) col = hud.flash;
    if (mega) {
      if (hud.mega < 0.1) { fx = base + 1; fy = base + 1; }
      col = ((hud.mega * 20) | 0) % 2 ? WHITE : GOLD;
    }
    const adv = 6 * base, n = hud.digits.length;
    const w = Math.round(hud.w * (state === 'over' ? (base / (base - 1)) : 1));
    const x0 = Math.round(iw / 2 - w / 2);
    const y0 = hudY() + (state === 'over' ? Math.round(ih * 0.04) : 0);
    const baseline = y0 + 7 * base;
    const rollH = 7 * base + 6;
    clipY0 = Math.max(0, y0 - 3); clipY1 = Math.min(ih, baseline + 4);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const d = hud.digits[i];
        const slotX = x0 + (w - n * adv + base) + i * adv;
        const gx = Math.round(slotX + (5 * base - 5 * fx) / 2);
        const gy = baseline - 7 * fy;
        const c = pass === 0 ? INK : col;
        if (d.t >= 1) { glyph(d.ch, gx, gy, fx, fy, c, pass); continue; }
        const inY = Math.round((1 - easeOutBack(d.t)) * rollH);
        const outY = -Math.round(easeOutCubic(d.t) * rollH);
        if (d.prev !== ' ') glyph(d.prev, gx, gy + outY, fx, fy, c, pass);
        glyph(d.ch, gx, gy + inY, fx, fy, c, pass);
      }
    }
    resetClip();
  }

  // ---------- background ----------
  function drawSky() {
    const hb = cam.y / H;
    const sky = skyAt(hb);
    buf.fill(pack(sky));
    const night = clamp((hb - 58) / 28, 0, 1);
    if (night > 0) drawStars(night);
    drawClouds(sky, hb);
    drawHills(sky);
  }
  function drawStars(night) {
    const p = 0.12, band = 36, off = cam.y * p;
    const b0 = Math.floor(-off / band) - 1, b1 = Math.floor((ih - off) / band) + 1;
    for (let b = b0; b <= b1; b++) {
      for (let k = 0; k < 4; k++) {
        const s = b * 16 + k;
        if (hash(s * 3 + 1) > night) continue;
        const x = Math.floor(hash(s * 3 + 2) * iw);
        const y = Math.floor(b * band + hash(s * 3 + 3) * band + off);
        const tw = hash(s * 7 + 5);
        if (tw > 0.7 && ((realTime * 3 + tw * 20) | 0) % 4 === 0) continue;
        if (tw > 0.93) {
          pset(x, y, WHITE); pset(x - 1, y, DIM); pset(x + 1, y, DIM); pset(x, y - 1, DIM); pset(x, y + 1, DIM);
        } else pset(x, y, tw > 0.5 ? WHITE : DIM);
      }
    }
  }
  function drawClouds(sky, hb) {
    const p = 0.4, band = 64, off = cam.y * p;
    const wf = lerp(0.55, 0.12, clamp((hb - 50) / 30, 0, 1));
    const c1 = pack(mixc(sky, [255, 255, 255], wf)), c2 = pack(mixc(sky, [255, 255, 255], wf * 0.45));
    const b0 = Math.floor(-off / band) - 1, b1 = Math.floor((ih - off) / band) + 1;
    for (let b = b0; b <= b1; b++) {
      const ly = b * band + hash(b * 5 + 1) * band * 0.6;
      const alt = (ay - ly) / p / H;
      if (alt < 3) continue;
      const density = alt < 70 ? 1 : Math.max(0, 1 - (alt - 70) / 40);
      if (hash(b * 5 + 2) > 0.85 * density) continue;
      const cw = 18 + Math.floor(hash(b * 5 + 3) * 34);
      const speedPx = 2 + hash(b * 5 + 4) * 4;
      const span = iw + cw + 20;
      const x = Math.floor(((hash(b * 5 + 6) * span + realTime * speedPx) % span) - cw - 10);
      cloud(x, Math.floor(ly + off), cw, c1, c2);
    }
  }
  function cloud(x, y, w, c1, c2) {
    const a = Math.round(w * 0.18), b = Math.round(w * 0.36), c = Math.round(w * 0.52), d = Math.round(w * 0.3);
    rect(x + a + 1, y, b - 2, 1, c1);
    rect(x + a, y + 1, b, 4, c1);
    rect(x + c + 1, y + 2, d - 2, 1, c1);
    rect(x + c, y + 3, d, 3, c1);
    rect(x + 2, y + 4, w - 4, 5, c1);
    rect(x, y + 6, w, 3, c1);
    rect(x + 1, y + 9, w - 2, 1, c2);
  }
  function drawHills(sky) {
    const layers = [
      { p: 0.32, base: 22, a1: 7, a2: 4, f1: 0.045, f2: 0.11, ph: 1.7, col: mixc(sky, [64, 96, 128], 0.3) },
      { p: 0.55, base: 42, a1: 10, a2: 3, f1: 0.03, f2: 0.13, ph: 4.2, col: mixc(sky, [52, 70, 112], 0.48) },
    ];
    const camSX = cam.x - cam.z;
    for (const L of layers) {
      const horizon = ay + L.base + Math.round(cam.y * L.p);
      if (horizon - 30 > ih) continue;
      const c = pack(L.col), rim = pack(mixc(L.col, [255, 255, 255], 0.18));
      const so = Math.round(camSX * L.p * 0.5);
      for (let x = 0; x < iw; x++) {
        const u = ((x + so) >> 1) * 2;
        const hgt = Math.round(L.a1 * (0.5 + 0.5 * Math.sin(u * L.f1 + L.ph)) + L.a2 * (0.5 + 0.5 * Math.sin(u * L.f2 + L.ph * 2.3)));
        const yTop = horizon - hgt;
        pset(x, yTop, rim);
        vspan(x, yTop + 1, ih, c);
      }
    }
  }
  // ---------- update ----------
  function update(dt) {
    realTime += dt;
    updateHud(dt);
    if (shakeAmp > 0.4) {
      shakeAmp *= Math.exp(-dt * 16);
      shakeX = Math.round(rand(-shakeAmp, shakeAmp)); shakeY = Math.round(rand(-shakeAmp, shakeAmp));
    } else { shakeAmp = 0; shakeX = 0; shakeY = 0; }
    if (transition) updateTransition(dt);
    for (const p of popups) p.t += dt;
    popups = popups.filter((p) => p.t < p.life);
    if (hitstop > 0) { hitstop -= dt; return; }
    step(dt);
  }

  function step(dt) {
    stateT += dt;
    followCamera(dt);

    if (moving) {
      moving.age += dt;
      const prev = moving.offset;
      moving.offset += moving.dir * speed() * dt;
      if (moving.offset > RANGE) { moving.offset = 2 * RANGE - moving.offset; moving.dir = -1; }
      else if (moving.offset < -RANGE) { moving.offset = -2 * RANGE - moving.offset; moving.dir = 1; }
      placeMoving();
      if (bot && state === 'play') botThink(prev);
    }

    for (let i = blocks.length - 1; i >= Math.max(0, blocks.length - 3); i--) blocks[i].t += dt;

    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.t += dt; d.vy -= 720 * dt;
      const dy = d.vy * dt, dx = d.vx * dt, dz = d.vz * dt;
      d.y0 += dy; d.y1 += dy; d.x0 += dx; d.x1 += dx; d.z0 += dz; d.z1 += dz;
      if (d.t > 4 || projY(d.x0, d.y1, d.z0) > ih + 60) debris.splice(i, 1);
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt;
      if (p.t >= p.life) { particles.splice(i, 1); continue; }
      p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    }
    for (const r of rings) r.t += dt;
    rings = rings.filter((r) => r.t < r.life);

    if (state === 'dying' && stateT > 0.8) enterOver();
    else if (state === 'over' && bot && stateT > 2.4 && !transition) retry();
    else if (state === 'title' && bot && stateT > 0.8) startGame();
  }

  function followCamera(dt) {
    const t = top();
    let tx = (t.x0 + t.x1) / 2, tz = (t.z0 + t.z1) / 2, ty = t.y1, tzoom = 1;
    if (state === 'over') {
      tzoom = clamp((ih * 0.6) / (t.y1 + S + 24), 0.12, 1);
      ty = t.y1 * 0.5 - 6; tx *= 0.5; tz *= 0.5;
    }
    const k = 1 - Math.exp(-dt * (state === 'over' ? 3.2 : 7));
    cam.x += (tx - cam.x) * k; cam.z += (tz - cam.z) * k; cam.y += (ty - cam.y) * k;
    cam.zoom += (tzoom - cam.zoom) * k;
  }

  function botThink(prev) {
    const m = moving;
    if (m.aim === null) {
      const t = top(), size = m.axis === 'x' ? t.x1 - t.x0 : t.z1 - t.z0;
      const maxErr = size * 0.42;
      m.aim = Math.random() < 0.72 || maxErr < 6 ? 0 : (Math.random() < 0.5 ? -1 : 1) * rand(6, maxErr);
    }
    if (m.age > 0.25 && (prev - m.aim) * (m.offset - m.aim) <= 0) drop();
  }

  function updateTransition(dt) {
    transition.t += dt;
    if (transition.t < transition.dur) return;
    if (transition.phase === 'close') {
      resetWorld();
      state = 'play'; stateT = 0;
      spawnMoving();
      transition = { phase: 'open', t: 0, dur: 0.24 };
    } else transition = null;
  }

  // ---------- render ----------
  function render() {
    if (!buf) return;
    Z = cam.zoom;
    OX = Math.round(ax - (cam.x - cam.z) * Z) + shakeX;
    OY = Math.round(ay - ((cam.x + cam.z) / 2 - cam.y) * Z) + shakeY;
    resetClip();

    drawSky();

    for (const d of debris) if (!d.front) projBox(d, d.t < 0.05 ? FLASH : d.pal);
    projBox(foundation, foundation.pal);
    drawTower();
    if (moving) projBox(moving, moving.pal);
    for (const d of debris) if (d.front) projBox(d, d.t < 0.05 ? FLASH : d.pal);

    for (const r of rings) {
      if (r.t < 0) continue;
      const k = r.t / r.life, g = Math.round(easeOutCubic(k) * 14) * 2, b = r.b;
      const x0 = b.x0 - g, z1 = b.z1 + g;
      rhombusOutline(OX + Math.round((x0 - z1) * Z), OY + Math.round(((x0 + z1) / 2) * Z) - Math.round(b.y1 * Z),
        even((b.x1 - b.x0 + 2 * g) * Z), even((b.z1 - b.z0 + 2 * g) * Z), WHITE, k > 0.6);
    }
    for (const p of particles) {
      if (p.t > p.life * 0.75 && ((realTime * 30) | 0) % 2) continue;
      rect(projX(p.x, p.z), projY(p.x, p.y, p.z), p.s, p.s, p.c);
    }

    if (state !== 'title') drawScore();
    for (const s of sparks) {
      const x = Math.round(s.x), y = Math.round(s.y);
      pset(x, y, s.c);
      if (s.t < s.life * 0.5) { pset(x - 1, y, s.c); pset(x + 1, y, s.c); pset(x, y - 1, s.c); pset(x, y + 1, s.c); }
    }
    for (const p of popups) drawPopup(p);
    drawUi();

    if (transition) {
      const k = transition.phase === 'close' ? transition.t / transition.dur : 1 - transition.t / transition.dur;
      const half = Math.ceil(ih / 2) + 1;
      const bh = Math.min(half, Math.round((easeInOut(clamp(k, 0, 1)) * half) / 3) * 3);
      rect(0, 0, iw, bh, SHUTTER);
      rect(0, ih - bh, iw, bh, SHUTTER);
    }
    ctx2d.putImageData(img, 0, 0);
  }

  function drawTower() {
    let start = blocks.length - 1;
    while (start > 0 && projY(blocks[start].x0, blocks[start].y1, blocks[start].z0) < ih + 4) start--;
    for (let i = Math.max(0, start); i < blocks.length; i++) {
      const b = blocks[i], last = i === blocks.length - 1;
      const squash = last && b.t < 0.05 ? 2 : last && b.t < 0.1 ? -1 : 0;
      projBox(b, b.t < 0.05 ? FLASH : b.pal, squash);
    }
  }

  function drawPopup(p) {
    const k = p.t / p.life;
    if (k > 0.75 && ((p.t * 20) | 0) % 2) return;
    const rise = Math.round(easeOutCubic(Math.min(1, p.t / 0.5)) * 10);
    const fp = p.t < 0.05 ? p.fp + 1 : p.fp;
    const col = p.shimmer && ((p.t * 16) | 0) % 2 ? GOLD : WHITE;
    if (p.screen) { textC(p.text, p.x, p.y, fp, col, INK); return; }
    // world popups float above the tower; the combo goes on the same line when it fits
    let x = projX(p.x, p.z);
    const y = projY(p.x, p.y, p.z) - 40 - rise;
    const sub = p.sub ? ' ' + p.sub : '';
    const full = textWidth(p.text + sub, fp);
    x = clamp(x, full / 2 + 3, iw - full / 2 - 3);
    if (sub && full <= iw - 6) {
      const x0 = Math.round(x - full / 2);
      text(p.text, x0, y, fp, col, INK);
      text(sub, x0 + textWidth(p.text, fp) + fp, y, fp, GOLD, INK);
    } else {
      textC(p.text, x, y, fp, col, INK);
      if (sub) textC(p.sub, x, y - 8 * fp - 2, fp, GOLD, INK);
    }
  }

  function drawUi() {
    const blink = ((realTime * 2.2) | 0) % 2 === 0;
    if (state === 'title') {
      const fp = iw >= 170 ? 4 : 3, y = Math.round(ih * 0.12);
      const word = (wd, yy, i0) => {
        const x0 = Math.round(iw / 2 - textWidth(wd, fp) / 2);
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < wd.length; i++) {
            const bob = Math.round(Math.sin(realTime * 4 + (i0 + i) * 0.7) * 1.5);
            glyph(wd[i], x0 + i * 6 * fp, yy + bob, fp, fp, pass === 0 ? INK : palFor((i0 + i) * 3).top, pass);
          }
        }
      };
      word('PIXEL', y, 0);
      word('TOWER', y + 8 * fp + 4, 5);
      if (blink) textC('TAP TO START', iw / 2, Math.round(ih * 0.84), 1, WHITE, INK);
      if (best > 0) textC('BEST ' + best, iw / 2, Math.round(ih * 0.84) + 12, 1, GOLD, INK);
    } else if (state === 'over' && stateT > 0.25) {
      const y = Math.round(ih * 0.8);
      if (newBest) textC('NEW BEST!', iw / 2, y - 22, 2, ((realTime * 10) | 0) % 2 ? GOLD : WHITE, INK);
      else textC('BEST ' + best, iw / 2, y - 14, 1, GOLD, INK);
      if (blink && stateT > 0.6) textC('TAP TO RETRY', iw / 2, y + 2, 1, WHITE, INK);
    }
    const label = muted ? 'SFX OFF' : 'SFX ON';
    const lw = textWidth(label, 1), lx = iw - lw - 5, ly = 5;
    text(label, lx, ly, 1, muted ? DIM : WHITE, INK);
    sfxRect = [lx - 5, ly - 5, lw + 10, 17];
  }

  // ---------- input ----------
  function press() {
    ensureAudio();
    if (transition) return;
    if (state === 'title') startGame();
    else if (state === 'play') { if (hitstop <= 0) drop(); }
    else if (state === 'over' && stateT > 0.6) retry();
  }
  function setMuted(m) {
    muted = !!m;
    save(storageKey + '.muted', muted ? 1 : 0);
    if (!muted) { ensureAudio(); play('click'); }
  }
  function onPointer(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * iw, y = ((e.clientY - r.top) / r.height) * ih;
    if (sfxRect && x >= sfxRect[0] && x < sfxRect[0] + sfxRect[2] && y >= sfxRect[1] && y < sfxRect[1] + sfxRect[3]) {
      setMuted(!muted);
      return;
    }
    press();
  }
  function onContextMenu(e) { e.preventDefault(); }
  function onKey(e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      if (!e.repeat) press();
    } else if (e.code === 'KeyM' && !e.repeat) setMuted(!muted);
  }

  // ---------- loop ----------
  let raf = 0, last = performance.now();
  function frame(now) {
    raf = root.requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    update(dt);
    render();
  }
  const onVisibility = () => { last = performance.now(); };

  resize();
  resetWorld();
  spawnMoving();
  canvas.addEventListener('pointerdown', onPointer);
  canvas.addEventListener('contextmenu', onContextMenu);
  keyTarget.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  root.addEventListener('resize', resize);
  const ro = root.ResizeObserver ? new root.ResizeObserver(resize) : null;
  if (ro) ro.observe(host);
  raf = root.requestAnimationFrame(frame);

  return {
    tap: press,
    setMuted,
    isMuted: () => muted,
    /** Sound volume 0..1, remembered like the mute state. */
    setVolume(v) {
      volume = clamp(+v || 0, 0, 1);
      save(storageKey + '.volume', Math.round(volume * 100) / 100);
      if (sfx) sfx.setVolume(volume);
    },
    getVolume: () => volume,
    setBot: (b) => { bot = !!b; },
    getState: () => ({ state, score, best, combo, muted }),
    destroy() {
      root.cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointer);
      canvas.removeEventListener('contextmenu', onContextMenu);
      keyTarget.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      root.removeEventListener('resize', resize);
      if (ro) ro.disconnect();
      if (ac) { ac.close().catch(() => {}); ac = null; sfx = null; }
    },
  };
}

export { create, createSfx };
