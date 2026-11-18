// Pixel-art cover for the Voice Snake card (128 x 80, shown upscaled with
// image-rendering: pixelated, same style as covers.ts). A retro studio microphone under a
// spotlight, the snake coiled up its stand and speaking into it, sound waves rolling out.
// The colours are game art (the dark-theme snake palette), not UI colours.

type G = CanvasRenderingContext2D;

const W = 128;
const H = 80;

// palette
const BG = ["#0a1916", "#0e211d", "#132c27", "#1a3a33", "#21483f"];
const FLOOR = ["#0b1b18", "#0f2420", "#143029", "#1b3d35"];
const GRID = "#2a5a50";
const GRID_NEAR = "#36705f";
const METAL = ["#22302d", "#3e504b", "#62786f", "#93a8a0", "#c6d3ce", "#eef3ef"];
const INK = "#071311";
const EDGE = "#1f5f58";
const BODY = "#36b384";
const BODY_BACK = "#2a8a69";
const SHINE = "#7fe6c0";
const HEAD = "#4fd8a4";
const HEAD_LIGHT = "#a6f0d4";
const TONGUE = "#f0736f";
const AMBER = "#e8b44a";
const AMBER_DARK = "#b9822a";
const AMBER_LIGHT = "#fbe7b8";
const WAVES = ["#a6f0d4", "#5fc7a6", "#2f8a73"];

function rect(g: G, x: number, y: number, w: number, h: number, c: string) {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

/** Small deterministic random so the cover looks the same on every paint. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Filled pixel disc around a (possibly fractional) centre. */
function disc(g: G, cx: number, cy: number, r: number, c: string) {
  g.fillStyle = c;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    const dy = y + 0.5 - cy;
    if (dy * dy > r * r) continue;
    const half = Math.sqrt(r * r - dy * dy);
    const x0 = Math.round(cx - half), x1 = Math.round(cx + half);
    if (x1 > x0) g.fillRect(x0, y, x1 - x0, 1);
  }
}

/** Arc of a pixel ring (one pixel thick), angles in radians, y grows downwards. */
function arc(g: G, cx: number, cy: number, r: number, a0: number, a1: number, c: string, dash = 0) {
  g.fillStyle = c;
  const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
  const y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    const d = Math.hypot(dx, dy);
    if (Math.abs(d - r) > 0.55) continue;
    const a = Math.atan2(dy, dx);
    if (a < a0 || a > a1) continue;
    if (dash && Math.floor((a - a0) * r / dash) % 2) continue;
    g.fillRect(x, y, 1, 1);
  }
}

const MIC_X = 64; // centre column of mic and stand
const HORIZON = 58;

/** Spotlit backdrop and a perspective floor with the game's dotted grid. */
function backdrop(g: G) {
  const img = g.createImageData(W, H);
  const bg = BG.map(hex), fl = FLOOR.map(hex);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = BAYER[(y & 3) * 4 + (x & 3)] / 16;
    let rgb: [number, number, number];
    if (y < HORIZON) {
      const d = Math.hypot((x - MIC_X) / 1.15, (y - 26) * 1.05);
      const v = Math.max(0, 1 - d / 62) * (BG.length - 1);
      rgb = bg[Math.min(BG.length - 1, Math.floor(v + t))];
    } else {
      // light pool under the mic, darker towards the front corners
      const d = Math.hypot((x - MIC_X) / 2.6, (y - 69) * 1.3);
      const v = Math.max(0, 1 - d / 26) * (FLOOR.length - 1) + 0.35;
      rgb = fl[Math.min(FLOOR.length - 1, Math.floor(v + t))];
    }
    const i = (y * W + x) * 4;
    img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  // horizon line, faint
  for (let x = 0; x < W; x++) if (Math.abs(x - MIC_X) < 50 || x % 2 === 0) rect(g, x, HORIZON, 1, 1, "#173831");

  // dotted grid on the floor: rows spread out towards the viewer, columns fan from a vanishing point
  const rows = [60, 62, 65, 69, 74];
  rows.forEach((y, ri) => {
    const spread = (y - 50) / 30;
    for (let k = -9; k <= 9; k++) {
      const x = Math.round(MIC_X + k * 16 * spread);
      if (x < 0 || x >= W) continue;
      const near = ri >= 3;
      rect(g, x, y, near ? 2 : 1, 1, near ? GRID_NEAR : GRID);
    }
  });

  // distant motes in the spotlight
  const rnd = seeded(31);
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * (HORIZON - 4));
    if (Math.abs(x - MIC_X) < 16 && y < 44) continue;
    const near = Math.hypot(x - MIC_X, y - 26) < 40;
    rect(g, x, y, 1, 1, near ? "#2d5e53" : "#1c3f37");
  }
}

/** Soft dithered contact shadow (ellipse). */
function shadow(g: G, cx: number, cy: number, rx: number, ry: number) {
  g.fillStyle = "#06110f";
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
    const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
    if (d > 1) continue;
    if (d > 0.45 && (x + y) % 2) continue;
    g.fillRect(x, y, 1, 1);
  }
}

/** Cylinder shading: column position 0..1 across the part to a METAL index. */
function metalAt(u: number, darken = 0) {
  const ramp = [1, 2, 4, 5, 4, 3, 2, 2, 1, 0];
  const i = ramp[Math.min(ramp.length - 1, Math.floor(u * ramp.length))];
  return METAL[Math.max(0, i - darken)];
}

function stand(g: G) {
  shadow(g, MIC_X + 2, 71, 17, 3.2);
  // base plate
  const by = 67;
  for (let x = MIC_X - 11; x <= MIC_X + 11; x++) {
    const u = (x - (MIC_X - 11)) / 23;
    const inset = Math.abs(x - MIC_X) > 9 ? 1 : 0;
    rect(g, x, by + inset, 1, 3 - inset, metalAt(u, 1));
    rect(g, x, by + 3, 1, 1, METAL[0]);
  }
  rect(g, MIC_X - 8, by, 17, 1, METAL[4]);
  // pole
  for (let x = MIC_X - 1; x <= MIC_X + 1; x++) rect(g, x, 40, 1, 27, metalAt((x - MIC_X + 1.5) / 3.2));
  rect(g, MIC_X - 2, 40, 5, 2, METAL[1]);
}

function yoke(g: G) {
  // U bracket holding the mic at its belt, joined to the pole
  const l = MIC_X - 13, r = MIC_X + 12, top = 19, bottom = 38;
  for (const x of [l, r]) {
    rect(g, x, top, 2, bottom - top, METAL[2]);
    rect(g, x, top, 1, bottom - top, x === l ? METAL[3] : METAL[1]);
  }
  rect(g, l + 1, bottom, r - l, 2, METAL[2]);
  rect(g, l + 2, bottom, r - l - 2, 1, METAL[3]);
  rect(g, l, bottom - 1, 1, 1, METAL[1]);
  rect(g, r + 1, bottom - 1, 1, 1, METAL[1]);
  // pivot knobs
  for (const x of [l - 1, r - 1]) {
    disc(g, x + 2, 22, 2.6, INK);
    disc(g, x + 2, 22, 2, METAL[3]);
    rect(g, x + 1, 21, 1, 1, METAL[5]);
  }
}

/** Retro capsule microphone: chrome shell, slotted grille, belt with an on-air light. */
function mic(g: G) {
  const cx = MIC_X, top = 4, bottom = 38, rad = 10;
  const inside = (x: number, y: number, r: number) => {
    const px = x + 0.5 - cx;
    let py = 0;
    if (y + 0.5 < top + rad) py = y + 0.5 - (top + rad);
    else if (y + 0.5 > bottom - rad) py = y + 0.5 - (bottom - rad);
    return px * px + py * py <= r * r;
  };
  for (let y = top - 1; y <= bottom + 1; y++) for (let x = cx - rad - 1; x <= cx + rad + 1; x++) {
    if (!inside(x, y, rad + 0.9)) continue;
    if (!inside(x, y, rad)) { rect(g, x, y, 1, 1, INK); continue; }
    const u = (x + 0.5 - (cx - rad)) / (2 * rad);
    const belt = y >= 20 && y <= 23;
    let c: string;
    if (belt) c = metalAt(u, y === 23 ? 2 : y === 20 ? 0 : 1);
    else {
      // grille slots: every other row is a dark gap, the lit side stays readable
      const slot = (y & 1) === 0 && y > top + 2 && y < bottom - 2;
      c = metalAt(u, slot ? 2 : 0);
      if (slot && u > 0.2 && u < 0.5) c = METAL[2];
    }
    rect(g, x, y, 1, 1, c);
  }
  // belt highlight and on-air light
  rect(g, cx - 6, 20, 4, 1, METAL[5]);
  rect(g, cx + 2, 20, 4, 4, "#3a1414");
  rect(g, cx + 3, 21, 2, 2, TONGUE);
  rect(g, cx + 3, 21, 1, 1, "#ffd0cc");
  // specular streak on the dome and a cool rim from the spotlight
  rect(g, cx - 5, top + 3, 2, 1, "#ffffff");
  rect(g, cx - 6, top + 4, 1, 3, "#ffffff");
  for (let y = top + 6; y < bottom - 6; y += 1) rect(g, cx + rad - 1, y, 1, 1, (y & 1) ? "#3f8f80" : METAL[1]);
}

// ---------- snake ----------
type P = [number, number, number]; // x, y, depth (>0 in front of the pole)

/** Body path: tail across the floor, coil up the pole, neck rising to the mic. */
function snakePath(): P[] {
  const pts: P[] = [];
  // tail slithering in from the left over the floor (an S curve)
  for (let i = 0; i <= 36; i++) {
    const k = i / 36;
    const x = 28 + k * 26;
    const y = 72 + Math.sin(k * Math.PI * 2) * 2.5 - k * 3;
    pts.push([x, y, 1]);
  }
  // helix around the pole
  const turns = 2.25, R = 10, yb = 66, yt = 43;
  const steps = 150;
  const start = -Math.PI / 2; // enter at the left
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const a = start + k * turns * Math.PI * 2;
    const x = MIC_X + Math.sin(a) * R;
    const y = yb + (yt - yb) * k + Math.cos(a) * 3.6;
    pts.push([x, y, Math.cos(a)]);
  }
  // neck: from the right of the last coil, up and in towards the grille
  const [lx, ly] = pts[pts.length - 1];
  const ex = 90, ey = 23;
  for (let i = 1; i <= 30; i++) {
    const k = i / 30;
    const x = lx + (ex - lx) * k + Math.sin(k * Math.PI * 2) * 4;
    const y = ly + (ey - ly) * (1 - (1 - k) * (1 - k));
    pts.push([x, y, 1]);
  }
  return pts;
}

function snakeBody(g: G, pts: P[], front: boolean) {
  const n = pts.length;
  const radius = (i: number) => 1.2 + 1.9 * Math.min(1, i / 60);
  const pick = (i: number) => (pts[i][2] >= 0) === front;
  for (let i = 0; i < n; i++) if (pick(i)) disc(g, pts[i][0], pts[i][1], radius(i) + 1, EDGE);
  // dark belly first, the lit back slightly higher on top: reads as a round body
  for (let i = 0; i < n; i++) if (pick(i)) disc(g, pts[i][0], pts[i][1], radius(i), front ? BODY_BACK : "#1f6e55");
  for (let i = 0; i < n; i++) if (pick(i)) disc(g, pts[i][0], pts[i][1] - 0.7, radius(i) - 0.6, front ? BODY : BODY_BACK);
  // shine along the back, and belly scales as darker ticks on the front coils
  for (let i = 0; i < n; i += 1) {
    if (!pick(i) || !front) continue;
    const [x, y] = pts[i];
    if (i % 2 === 0) rect(g, Math.round(x - 0.5), Math.round(y - radius(i) + 0.4), 1, 1, SHINE);
  }
}

function snakeHead(g: G, x: number, y: number) {
  // head faces left, towards the grille, tongue flicking at the mic
  disc(g, x, y, 6.6, EDGE);
  disc(g, x + 0.5, y + 0.3, 5.6, HEAD);
  // snout pushed forward
  rect(g, x - 9, y - 3, 5, 5, EDGE);
  rect(g, x - 8, y - 2, 4, 3, HEAD);
  rect(g, x - 7, y - 3, 3, 1, EDGE);
  // highlight across the top of the head
  rect(g, x - 4, y - 5, 6, 1, HEAD_LIGHT);
  rect(g, x - 6, y - 4, 3, 1, HEAD_LIGHT);
  rect(g, x - 8, y - 2, 2, 1, HEAD_LIGHT);
  // jaw line
  rect(g, x - 8, y + 2, 7, 1, "#1b6a52");
  // forked tongue
  rect(g, x - 13, y + 1, 4, 1, TONGUE);
  rect(g, x - 14, y, 1, 1, TONGUE);
  rect(g, x - 14, y + 2, 1, 1, TONGUE);
  // eye: big, looking at the mic, with a glint
  rect(g, x - 3, y - 3, 4, 4, "#ffffff");
  rect(g, x - 3, y - 2, 2, 3, INK);
  rect(g, x - 2, y - 3, 1, 1, INK);
  rect(g, x - 3, y - 2, 1, 1, "#ffffff");
  // nostril and cheek scales
  rect(g, x - 7, y - 1, 1, 1, EDGE);
  rect(g, x + 2, y + 2, 1, 1, BODY);
  rect(g, x + 4, y, 1, 1, BODY);
}

function apple(g: G, x: number, y: number, r: number) {
  shadow(g, x + 1, y + r + 1, r + 2, 1.6);
  disc(g, x, y, r + 1, "#5a3a12");
  disc(g, x, y, r, AMBER);
  disc(g, x + 1, y + 1, r - 1.6, AMBER);
  for (let yy = Math.round(y); yy <= y + r; yy++) rect(g, Math.round(x + r * 0.2), yy, Math.max(1, Math.round(r * 0.6)), 1, AMBER_DARK);
  disc(g, x, y, r - 1.2, AMBER);
  rect(g, Math.round(x - r / 2), Math.round(y - r / 2), 2, 1, AMBER_LIGHT);
  rect(g, Math.round(x - r / 2), Math.round(y - r / 2) + 1, 1, 1, AMBER_LIGHT);
  rect(g, Math.round(x), Math.round(y - r - 2), 1, 2, "#5a3a12");
  rect(g, Math.round(x + 1), Math.round(y - r - 2), 3, 1, HEAD);
  rect(g, Math.round(x + 2), Math.round(y - r - 3), 2, 1, HEAD);
}

function waves(g: G) {
  // sound rolling out of the mic: wide arcs to the left, a shorter set up and to the right
  const cx = MIC_X, cy = 21;
  [[21, 0], [27, 1], [33, 2], [39, 2]].forEach(([r, c], i) => {
    const span = (0.3 - i * 0.035) * Math.PI;
    const dash = i === 3 ? 2 : 0;
    arc(g, cx, cy, r, Math.PI - span, Math.PI, WAVES[c], dash);
    arc(g, cx, cy, r, -Math.PI, -Math.PI + span, WAVES[c], dash);
  });
  [[21, 0], [27, 1], [33, 2], [39, 2]].forEach(([r, c], i) => arc(g, cx, cy, r, -1.25 + i * 0.08, -0.5 + i * 0.05, WAVES[c], i === 3 ? 2 : 0));
}

/** Level meter pips rising over the snake's head, like a voice being heard. */
function sparkles(g: G) {
  const rnd = seeded(5);
  for (let i = 0; i < 7; i++) {
    const x = 6 + Math.floor(rnd() * 116), y = 4 + Math.floor(rnd() * 46);
    if (Math.abs(x - MIC_X) < 20) continue;
    rect(g, x, y, 1, 1, i % 3 ? "#9be8d2" : AMBER_LIGHT);
    if (i % 2 === 0) {
      rect(g, x - 1, y, 1, 1, "#2f8a73");
      rect(g, x + 1, y, 1, 1, "#2f8a73");
      rect(g, x, y - 1, 1, 1, "#2f8a73");
      rect(g, x, y + 1, 1, 1, "#2f8a73");
    }
  }
}

export function paint(g: G): void {
  g.imageSmoothingEnabled = false;
  backdrop(g);
  sparkles(g);
  waves(g);
  apple(g, 22, 63, 4);
  apple(g, 109, 68, 3);
  const pts = snakePath();
  for (let i = 0; i < 37; i += 3) shadow(g, pts[i][0] + 1, pts[i][1] + 3, 3, 1.2);
  stand(g);
  snakeBody(g, pts, false);
  // the pole again in front of the back coils
  for (let x = MIC_X - 1; x <= MIC_X + 1; x++) for (let y = 42; y < 67; y++) {
    if (pts.some(([px, py, d]) => d < 0 && Math.abs(px - x) < 3.5 && Math.abs(py - y) < 3.5)) rect(g, x, y, 1, 1, metalAt((x - MIC_X + 1.5) / 3.2));
  }
  yoke(g);
  mic(g);
  snakeBody(g, pts, true);
  const [hx, hy] = pts[pts.length - 1];
  snakeHead(g, hx + 1, hy);
}
