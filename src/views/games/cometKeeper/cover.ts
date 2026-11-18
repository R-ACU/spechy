// Pixel-art cover for the Comet Keeper card (128 x 80, shown upscaled with
// image-rendering: pixelated, same style as covers.ts). The colours are game art.
//
// Composition: the lantern sits left of centre in a warm halo, its shield is turned to the
// upper right and a big gold comet slams into it there, throwing a burst of sparks and a
// shock ring. More comets streak in from the dark, a ringed planet hangs far away top left.

type G = CanvasRenderingContext2D;

const W = 128, H = 80;

// palette from engine.ts
const INK = "#141228", SKY = "#1d1b3c", STAR_DIM = "#5d5890", STAR = "#e9e6ff", PALE = "#c9c4ee";
const WHITE = "#ffffff", GOLD = "#ffd84a";
const CORE = { body: "#ffd27a", shade: "#f0a050", light: "#fff3c4", line: "#3a2148", cheek: "#ff9a8a" };
const SHIELD = { main: "#6fdcff", edge: "#d4f8ff", inner: "#2f8fc4" };
const PLANET = { body: "#3b3878", band: "#4a4690", shade: "#2b2960", ring: "#7a6cc0", ringDark: "#4f4590" };
interface Style { head: string; core: string; trail: [string, string, string] }
const NORMAL: Style = { head: "#ff9a5a", core: "#fff0d0", trail: ["#ff6b5a", "#c8456e", "#7a3470"] };
const FAST: Style = { head: "#9fe6ff", core: "#ffffff", trail: ["#6fc8ff", "#4a7fe0", "#3a4aa0"] };
const GOLDEN: Style = { head: "#ffe14a", core: "#fffbe0", trail: ["#ffb43a", "#d9802a", "#8a4a2a"] };

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function rect(g: G, x: number, y: number, w: number, h: number, c: string) {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), w, h);
}

/** Small deterministic random so the cover looks the same on every paint. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
}

// lantern centre, shield radius and the direction the big comet comes from
const CX = 50, CY = 46, CORE_R = 11, RS = 21;
const HIT_A = -0.62; // angle of the impact point on the shield (upper right)
const HX = CX + Math.cos(HIT_A) * RS, HY = CY + Math.sin(HIT_A) * RS;

/** Background into an ImageData: navy with a warm halo round the lantern, a nebula band and
 *  a dark vignette, all as hard pixel bands with checker dithering at the seams. */
function paintSky(g: G) {
  const img = g.createImageData(W, H);
  const bands = [hex("#33284f"), hex("#272248"), hex(SKY), hex("#17153a"), hex(INK)];
  const neb = [hex("#262457"), hex("#33204a")];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const chk = (x + y) & 1;
    // distance from the lantern drives the halo, distance from the centre the vignette
    const dl = Math.hypot((x - CX) * 0.85, y - CY);
    const dv = Math.hypot((x - 60) / 66, (y - 42) / 44);
    let level = dl < 17 ? 0 : dl < 27 ? 1 : 2;
    if (level === 2 && dv > 1.0) level = 3;
    if (level === 3 && dv > 1.22) level = 4;
    // one row of checker dither on each seam
    if (chk && ((dl >= 16 && dl < 17) || (dl >= 26 && dl < 27))) level++;
    let c = bands[level];
    // soft nebula clouds: low-frequency waves, dithered at the fringe
    if (level >= 2) {
      const f = Math.sin(x * 0.065 + 0.8) + Math.sin(y * 0.11 - x * 0.035 + 2.2) + Math.sin((x + y) * 0.045 + 4.1);
      if (f > 2.05) c = neb[chk];
      else if (f > 1.75) c = chk ? neb[0] : c;
      else if (f > 1.5 && ((x + 2 * y) & 3) === 0) c = neb[0];
    }
    const i = (y * W + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

function stars(g: G, rnd: () => number) {
  for (let i = 0; i < 70; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H);
    if (Math.hypot(x - CX, y - CY) < RS + 4) continue;
    rect(g, x, y, 1, 1, i % 5 ? STAR_DIM : i % 2 ? PALE : STAR);
  }
  // a few big twinkles
  for (const [x, y] of [[90, 8], [8, 66], [118, 46], [30, 6], [74, 72]] as const) {
    rect(g, x, y, 1, 1, STAR);
    rect(g, x - 1, y, 1, 1, STAR_DIM); rect(g, x + 1, y, 1, 1, STAR_DIM);
    rect(g, x, y - 1, 1, 1, STAR_DIM); rect(g, x, y + 1, 1, 1, STAR_DIM);
  }
}

function planet(g: G) {
  const px = 15, py = 14, r = 11, rl = 20;
  const ring = (front: boolean) => {
    for (let k = -rl; k <= rl; k++) {
      const e = Math.sqrt(Math.max(0, 1 - (k / rl) ** 2)) * 4;
      const y = Math.round(py + 1 + (front ? e : -e) + k * 0.22);
      if (!front && Math.abs(k) < r && Math.abs(y - py) < r) continue;
      rect(g, px + k, y, 1, 1, front ? PLANET.ring : PLANET.ringDark);
      if (front && Math.abs(k) < rl - 3) rect(g, px + k, y + 1, 1, 1, PLANET.ringDark);
    }
  };
  ring(false);
  for (let dy = -r; dy < r; dy++) for (let dx = -r; dx < r; dx++) {
    const fx = dx + 0.5, fy = dy + 0.5;
    if (Math.hypot(fx, fy) > r) continue;
    let c = Math.floor((fy + 20 - fx * 0.2) / 4) % 2 ? PLANET.band : PLANET.body;
    // lit from the lantern (lower right), shade on the far side
    if (-fx * 0.6 - fy * 0.8 > r * 0.35) c = PLANET.shade;
    else if (fx * 0.6 + fy * 0.8 > r * 0.62) c = "#5a54a8";
    rect(g, px + dx, py + dy, 1, 1, c);
  }
  ring(true);
}

/** Comet with its head at (x, y) flying along (ux, uy); trail is `len` long and up to
 *  `wide` px thick near the head. */
function comet(g: G, x: number, y: number, ux: number, uy: number, len: number, wide: number, st: Style, big = false) {
  const n = Math.hypot(ux, uy); ux /= n; uy /= n;
  const px = -uy, py = ux;
  // drawn back to front in half steps so diagonal trails have no holes
  for (let i = len + 8; i >= 2; i -= 0.5) {
    if (i >= len && Math.floor(i - len) % 2) continue;
    const k = i / len;
    const c = k < 0.3 ? st.trail[0] : k < 0.65 ? st.trail[1] : st.trail[2];
    const tx = x - ux * i, ty = y - uy * i;
    const half = Math.max(0, wide * (1 - k) * 0.5);
    for (let w = -half; w <= half; w += 0.5) rect(g, tx + px * w, ty + py * w, 1, 1, c);
    // hot inner streak
    if (k < 0.5 && half >= 1) {
      const ih = half * 0.35;
      for (let w = -ih; w <= ih; w += 0.5) rect(g, tx + px * w, ty + py * w, 1, 1, k < 0.25 ? st.core : st.head);
    }
  }
  if (big) {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > 3.3) continue;
      rect(g, x + dx, y + dy, 1, 1, d > 2.3 ? st.trail[0] : d > 1.2 ? st.head : st.core);
    }
    rect(g, x - 1, y - 1, 1, 1, WHITE);
  } else {
    rect(g, x - 1, y - 1, 3, 3, st.head);
    rect(g, x - 2, y, 1, 1, st.head); rect(g, x + 2, y, 1, 1, st.head);
    rect(g, x, y - 2, 1, 1, st.head); rect(g, x, y + 2, 1, 1, st.head);
    rect(g, x, y, 1, 1, st.core);
  }
}

/** Tiny far-away comets: a short fading dash, for depth. */
function farComet(g: G, x: number, y: number, ux: number, uy: number, len: number, c: string, tail: string) {
  rect(g, x, y, 1, 1, c);
  for (let i = 1; i < len; i++) rect(g, x - ux * i, y - uy * i, 1, 1, i < len / 2 ? c : tail);
}

function shield(g: G) {
  const ARC = 0.78, lim = RS + 3;
  for (let dy = -lim; dy <= lim; dy++) for (let dx = -lim; dx <= lim; dx++) {
    const fx = dx + 0.5, fy = dy + 0.5, d = Math.hypot(fx, fy);
    if (d < RS - 1.7 || d > RS + 1.7) continue;
    let diff = Math.abs(Math.atan2(fy, fx) - HIT_A);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > ARC) continue;
    let c = d > RS + 0.6 ? SHIELD.edge : d < RS - 0.6 ? SHIELD.inner : SHIELD.main;
    if (diff > ARC - 0.1) c = SHIELD.inner;
    // the bash: the part under the comet glows white
    if (diff < 0.22 && c !== SHIELD.inner) c = WHITE;
    else if (diff < 0.34 && c === SHIELD.main) c = SHIELD.edge;
    rect(g, CX + dx, CY + dy, 1, 1, c);
  }
  // soft inner glow just behind the shield
  for (let k = -9; k <= 9; k++) {
    const a = HIT_A + k * 0.07;
    if (k % 2) continue;
    rect(g, Math.floor(CX + Math.cos(a) * (RS - 3)), Math.floor(CY + Math.sin(a) * (RS - 3)), 1, 1, "#2f5f9c");
  }
}

function impact(g: G, rnd: () => number) {
  const nx = Math.cos(HIT_A), ny = Math.sin(HIT_A); // outward normal at the hit
  // shock ring: a broken half circle opening away from the lantern
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const facing = Math.cos(a) * nx + Math.sin(a) * ny;
    if (facing < -0.25 || k % 3 === 2) continue;
    rect(g, Math.round(HX + Math.cos(a) * 11), Math.round(HY + Math.sin(a) * 11), 1, 1, k % 2 ? GOLD : "#fff3c4");
  }
  // spark rays spraying off both sides of the comet, away from the lantern, never back
  // along its trail
  for (let i = 0; i < 10; i++) {
    const side = i % 2 ? 1 : -1, step = Math.floor(i / 2);
    const a = HIT_A + side * (0.8 + step * 0.2) + (rnd() - 0.5) * 0.1;
    const len = 13 + Math.floor(rnd() * 5) - step * 2;
    const ux = Math.cos(a), uy = Math.sin(a);
    for (let s = 4; s < len; s += 0.5) rect(g, HX + ux * s, HY + uy * s, 1, 1, s < 6 ? WHITE : s < len - 2 ? GOLD : "#ff9a5a");
    // a loose ember beyond the tip
    rect(g, HX + ux * (len + 2), HY + uy * (len + 2), 1, 1, step % 2 ? "#ffb43a" : "#ff6b5a");
  }
  // bright flash cross on the contact point
  rect(g, HX - 2, HY - 2, 5, 5, "#fff3c4");
  rect(g, HX - 1, HY - 3, 3, 7, WHITE);
  rect(g, HX - 3, HY - 1, 7, 3, WHITE);
  for (let s = 4; s < 7; s++) {
    rect(g, HX + s, HY, 1, 1, GOLD); rect(g, HX - s, HY, 1, 1, GOLD);
    rect(g, HX, HY + s, 1, 1, GOLD); rect(g, HX, HY - s, 1, 1, GOLD);
  }
}

function lantern(g: G) {
  const r = CORE_R;
  for (let dy = -r - 1; dy <= r; dy++) for (let dx = -r - 1; dx <= r; dx++) {
    const fx = dx + 0.5, fy = dy + 0.5, d = Math.hypot(fx, fy);
    if (d > r + 1) continue;
    let c = d > r ? CORE.line : CORE.body;
    const lit = (fx * 0.6 + fy * 0.8) / r;
    if (d <= r && lit > 0.42) c = CORE.shade;
    // rim light from the flash on the upper right
    if (d <= r && d > r - 1.4 && fx * Math.cos(HIT_A) + fy * Math.sin(HIT_A) > r * 0.55) c = CORE.light;
    rect(g, CX + dx, CY + dy, 1, 1, c);
  }
  // highlight
  rect(g, CX - 6, CY - 7, 3, 2, CORE.light);
  rect(g, CX - 7, CY - 5, 1, 2, CORE.light);
  // face looking up at the hit: wide eyes and an open "wow" mouth
  const ex = CX, ey = CY - 1;
  for (const sx of [-5, 2]) {
    rect(g, ex + sx, ey - 1, 3, 3, CORE.line);
    rect(g, ex + sx + 2, ey - 1, 1, 1, WHITE);
  }
  rect(g, ex - 1, ey + 4, 2, 3, CORE.line);
  rect(g, ex - 2, ey + 5, 1, 1, CORE.line); rect(g, ex + 1, ey + 5, 1, 1, CORE.line);
  rect(g, ex - 1, ey + 6, 2, 1, "#c8456e");
  rect(g, ex - 7, ey + 3, 2, 1, CORE.cheek); rect(g, ex + 5, ey + 3, 2, 1, CORE.cheek);
}

export function paint(g: G) {
  const rnd = seeded(23);
  paintSky(g);
  stars(g, rnd);
  planet(g);

  // depth: tiny comets far away
  farComet(g, 112, 20, -1, 0.5, 5, "#ff9a5a", "#7a3470");
  farComet(g, 40, 74, 0.6, -1, 4, "#9fe6ff", "#3a4aa0");
  farComet(g, 70, 70, -0.3, -1, 4, "#ff9a5a", "#7a3470");

  // other comets streaking in from the dark
  comet(g, 13, 55, 1, -0.22, 22, 4, FAST);
  comet(g, 96, 62, -1, -0.45, 16, 4, NORMAL);

  shield(g);
  lantern(g);

  // the big gold comet coming in from the top right, head right on the shield
  const hx = HX + Math.cos(HIT_A) * 6, hy = HY + Math.sin(HIT_A) * 6;
  comet(g, hx, hy, -Math.cos(HIT_A), -Math.sin(HIT_A), 40, 10, GOLDEN, true);
  impact(g, rnd);
}
