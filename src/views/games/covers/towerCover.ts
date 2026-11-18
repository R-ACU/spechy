// Pixel-art cover for the Pixel Tower card (128 x 80, shown upscaled with
// image-rendering: pixelated). The colours are game art taken from pixelTower.js:
// its block palette with hue shifting, the sky ramp, white pixel clouds, gold sparks
// and the dark navy ink of the title letters.

type G = CanvasRenderingContext2D;
type RGB = [number, number, number];

const CW = 128;
const CH = 80;

const INK: RGB = [27, 21, 48]; // #1b1530
const GOLD: RGB = [255, 216, 74]; // #ffd84a
const WHITE: RGB = [255, 255, 255];
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t),
];
const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

function rect(g: G, x: number, y: number, w: number, h: number, c: RGB) {
  g.fillStyle = css(c);
  g.fillRect(x, y, w, h);
}
const px = (g: G, x: number, y: number, c: RGB) => rect(g, x, y, 1, 1, c);

/** Small deterministic random so the cover looks the same on every paint. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
}

function hsl(h: number, s: number, l: number): RGB {
  h = (((h % 360) + 360) % 360) / 360; s /= 100; l /= 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

// Same block palette as the game: shadows drift to blue, highlights to yellow.
interface Pal { top: RGB; rim: RGB; edge: RGB; left: RGB; right: RGB; seamL: RGB; seamR: RGB }
function hueToward(h: number, target: number, amt: number) {
  const d = ((target - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), amt);
}
function blockPalette(h: number): Pal {
  const warm = (a: number) => hueToward(h, 50, a), cool = (a: number) => hueToward(h, 245, a);
  return {
    top: hsl(warm(6), 64, 76),
    rim: hsl(warm(12), 82, 90),
    edge: hsl(warm(6), 60, 72),
    left: hsl(cool(10), 52, 62),
    right: hsl(cool(22), 46, 47),
    seamL: hsl(cool(16), 50, 55),
    seamR: hsl(cool(28), 46, 40),
  };
}

/** Walks the columns of an iso box like the game's drawBox; (sx, sy) is the left corner of the top face. */
function columns(sx: number, sy: number, w: number, d: number, h: number, fn: (x: number, top: number, bot: number, k: number) => void) {
  const W = w + d, hw = w >> 1, hd = d >> 1, syB = sy - hd + hw;
  for (let k = 0; k < W; k++) {
    const top = k < d ? sy - (k >> 1) : syB - ((W - 1 - k) >> 1);
    const bot = k < w ? sy + 1 + (k >> 1) : syB + 1 + ((W - 1 - k) >> 1);
    fn(sx + k, top, bot + h, k);
  }
}

function drawBox(g: G, sx: number, sy: number, w: number, d: number, h: number, pal: Pal) {
  const W = w + d, hd = d >> 1, hw = w >> 1, syB = sy - hd + hw;
  for (let k = 0; k < W; k++) {
    const x = sx + k;
    const top = k < d ? sy - (k >> 1) : syB - ((W - 1 - k) >> 1);
    const left = k < w;
    const bot = left ? sy + 1 + (k >> 1) : syB + 1 + ((W - 1 - k) >> 1);
    rect(g, x, top, 1, bot - 1 - top, pal.top);
    px(g, x, bot - 1, pal.rim);
    const side = left ? (k === w - 1 ? pal.edge : pal.left) : pal.right;
    rect(g, x, bot, 1, h - 1, side);
    px(g, x, bot + h - 1, left ? pal.seamL : pal.seamR);
  }
}

/** 1 px ink silhouette around a box, painted before the fills so only the outer edge stays. */
function inkBox(g: G, sx: number, sy: number, w: number, d: number, h: number) {
  const W = w + d;
  columns(sx, sy, w, d, h, (x, top, bot, k) => {
    rect(g, x, top - 1, 1, bot - top + 2, INK);
    if (k === 0) rect(g, x - 1, top, 1, bot - top, INK);
    if (k === W - 1) rect(g, x + 1, top, 1, bot - top, INK);
  });
}

function rhombus(g: G, sx: number, sy: number, w: number, d: number, c: RGB, dotted = false) {
  const W = w + d, hd = d >> 1, hw = w >> 1, syB = sy - hd + hw;
  for (let k = 0; k < W; k++) {
    if (dotted && k & 2) continue;
    const top = k < d ? sy - (k >> 1) : syB - ((W - 1 - k) >> 1);
    const bot = k < w ? sy + 1 + (k >> 1) : syB + 1 + ((W - 1 - k) >> 1);
    px(g, sx + k, top, c);
    px(g, sx + k, bot - 1, c);
  }
}

/** The game's pixel cloud with its shade row underneath. */
function cloud(g: G, x: number, y: number, w: number, c1: RGB, c2: RGB) {
  const a = Math.round(w * 0.18), b = Math.round(w * 0.36), c = Math.round(w * 0.52), d = Math.round(w * 0.3);
  rect(g, x + a + 1, y, b - 2, 1, c1);
  rect(g, x + a, y + 1, b, 4, c1);
  rect(g, x + c + 1, y + 2, d - 2, 1, c1);
  rect(g, x + c, y + 3, d, 3, c1);
  rect(g, x + 2, y + 4, w - 4, 5, c1);
  rect(g, x, y + 6, w, 3, c1);
  rect(g, x + 1, y + 9, w - 2, 1, c2);
}

function disc(g: G, cx: number, cy: number, r: number, c: RGB) {
  for (let y = -r; y <= r; y++) {
    const hw = Math.round(Math.sqrt(r * r - y * y));
    rect(g, cx - hw, cy + y, hw * 2 + 1, 1, c);
  }
}

function sparkle(g: G, x: number, y: number, big: boolean, c: RGB) {
  px(g, x - 1, y, c); px(g, x + 1, y, c); px(g, x, y - 1, c); px(g, x, y + 1, c);
  if (big) { px(g, x - 2, y, c); px(g, x + 2, y, c); px(g, x, y - 2, c); px(g, x, y + 2, c); }
  px(g, x, y, WHITE);
}

export function paint(g: G): void {
  const rnd = seeded(31);
  const MAUVE = hex("#c47a9b"), CORAL = hex("#f0a98f"), PEACH = hex("#f3d3a6"), MINT = hex("#8fd1bf");

  // ---- sky: the game's ramp from altitude (mauve, coral) down to the ground (mint), in hard bands
  const stops: [number, RGB][] = [[0, MAUVE], [18, CORAL], [36, PEACH], [58, PEACH], [72, MINT]];
  for (let y = 0; y < CH; y++) {
    let c = stops[stops.length - 1][1];
    for (let i = 1; i < stops.length; i++) {
      if (y < stops[i][0]) {
        const [y0, c0] = stops[i - 1], [y1, c1] = stops[i];
        c = mix(c0, c1, Math.floor(((y - y0) / (y1 - y0)) * 4) / 4);
        break;
      }
    }
    rect(g, 0, y, CW, 1, c);
  }

  // ---- glow behind the top of the tower (the focal point)
  const fx = 62, fy = 24;
  disc(g, fx, fy, 30, mix(CORAL, WHITE, 0.16));
  disc(g, fx, fy, 22, mix(PEACH, WHITE, 0.22));
  disc(g, fx, fy, 14, mix(PEACH, WHITE, 0.5));

  // tiny distant sparkles in the high sky
  for (let i = 0; i < 14; i++) {
    const x = Math.floor(rnd() * CW), y = Math.floor(rnd() * 20);
    if (Math.abs(x - fx) < 32) continue;
    px(g, x, y, mix(CORAL, WHITE, 0.6));
  }

  // ---- far clouds behind the tower
  cloud(g, 2, 26, 26, mix(PEACH, WHITE, 0.5), mix(CORAL, WHITE, 0.3));
  cloud(g, 94, 16, 30, mix(CORAL, WHITE, 0.5), mix(CORAL, WHITE, 0.25));
  cloud(g, 104, 38, 22, mix(PEACH, WHITE, 0.55), mix(PEACH, WHITE, 0.25));

  // ---- far hills at the bottom, seen between the clouds
  for (const [base, a1, a2, f1, f2, ph, t] of [[72, 5, 2, 0.06, 0.17, 1.7, 0.3], [78, 5, 2, 0.045, 0.13, 4.2, 0.48]] as const) {
    const col = mix(MINT, [52, 70, 112], t), rim = mix(col, WHITE, 0.18);
    for (let x = 0; x < CW; x++) {
      const u = (x >> 1) * 2;
      const hgt = Math.round(a1 * (0.5 + 0.5 * Math.sin(u * f1 + ph)) + a2 * (0.5 + 0.5 * Math.sin(u * f2 + ph * 2.3)));
      px(g, x, base - hgt, rim);
      rect(g, x, base - hgt + 1, 1, CH, col);
    }
  }

  // ---- the tower, from far below up to the newest block. Lower blocks are wider (laid
  // before the cuts), the top three were perfect so they share one footprint.
  const H = 5, hue0 = 96, step = 20;
  const spec: [number, number, number][] = [ // from the top block down: [w, d, dx]
    [16, 16, 0], [16, 16, 0], [16, 16, 0], [18, 16, 0], [18, 18, -2], [20, 18, -2], [20, 20, -2],
    [22, 20, -4], [22, 22, -4], [24, 22, -4], [24, 24, -6], [26, 24, -6],
  ];
  const topX = 46, topY = 31;
  const tower = spec.map(([w, d, dx], j) => ({ x: topX + dx, y: topY + j * H, w, d, i: spec.length - 1 - j })).reverse();
  // perfect placement on the newest block: the game's white ring plus a dotted gold one,
  // painted behind the tower so only the part around it shows
  const tb = tower[tower.length - 1];
  rhombus(g, tb.x - 6, tb.y, tb.w + 6, tb.d + 6, WHITE);
  rhombus(g, tb.x - 12, tb.y, tb.w + 12, tb.d + 12, GOLD, true);
  for (const b of tower) inkBox(g, b.x, b.y, b.w, b.d, H);
  for (const b of tower) drawBox(g, b.x, b.y, b.w, b.d, H, blockPalette(hue0 + b.i * step));
  const topB = tower[tower.length - 1];


  // ---- front cloud bank crossing the tower: it reaches into the clouds
  const fc1 = mix(PEACH, WHITE, 0.62), fc2 = mix(CORAL, WHITE, 0.35);
  cloud(g, -6, 54, 40, fc1, fc2);
  cloud(g, 28, 61, 34, fc1, fc2);
  cloud(g, 72, 56, 44, fc1, fc2);
  cloud(g, 106, 63, 30, fc1, fc2);

  // ---- the next block sliding in along the iso axis, one level up, from the upper right
  // it hovers 10 px back along z, so its shadow covers the back strip of the top face
  const shift = 10;
  const shade = mix(blockPalette(hue0 + (spec.length - 1) * step).top, INK, 0.22);
  columns(topB.x + shift, topB.y - (shift >> 1), topB.w, topB.d - shift, 0, (x, top, bot) => rect(g, x, top, 1, bot - 1 - top, shade));
  const sl = { x: topB.x + 2 * shift, y: topB.y - H - shift, w: 16, d: 16 };
  const slPal = blockPalette(hue0 + spec.length * step);
  const line = (x0: number, y0: number, len: number, c: RGB) => {
    for (let t = 0; t < len; t++) {
      if (t > len - 4 && t & 1) continue;
      rect(g, x0 + t * 2, y0 - t, 2, 1, c);
    }
  };
  const lc = mix(slPal.top, WHITE, 0.55);
  const ex = sl.x + sl.w + sl.d;
  line(ex + 2, sl.y - 4, 9, lc);
  line(ex + 1, sl.y + 3, 13, WHITE);
  line(ex - 2, sl.y + 9, 7, lc);
  inkBox(g, sl.x, sl.y, sl.w, sl.d, H);
  drawBox(g, sl.x, sl.y, sl.w, sl.d, H, slPal);

  // ---- sparks of the perfect hit
  const cx = topB.x + ((topB.w + topB.d) >> 1);
  sparkle(g, cx - 20, topB.y - 8, true, GOLD);
  sparkle(g, cx - 2, topB.y - 15, false, WHITE);
  sparkle(g, cx - 26, topB.y + 6, false, GOLD);
  px(g, cx - 12, topB.y - 3, WHITE);
  px(g, cx + 14, topB.y + 9, GOLD);
}
