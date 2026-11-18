// Pixel-art cover for the Comet Keeper card (128 x 80, shown upscaled with
// image-rendering: pixelated, same style as covers.ts). The colours are game art.

type G = CanvasRenderingContext2D;

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

/** Comet flying toward (ux, uy) with its head at (x, y) and the trail behind it. */
function comet(g: G, x: number, y: number, ux: number, uy: number, len: number, head: string, core: string, trail: string[]) {
  const px = -uy, py = ux;
  for (let i = 2; i < len + 6; i++) {
    if (i >= len && (i - len) % 2) continue;
    const k = i / len;
    const c = k < 0.35 ? trail[0] : k < 0.7 ? trail[1] : trail[2];
    const tx = x - ux * i, ty = y - uy * i;
    rect(g, tx, ty, 1, 1, c);
    if (i < 5) { rect(g, tx + px, ty + py, 1, 1, c); rect(g, tx - px, ty - py, 1, 1, c); }
  }
  rect(g, x - 1, y - 1, 3, 3, head);
  rect(g, x - 2, y, 1, 1, head); rect(g, x + 2, y, 1, 1, head);
  rect(g, x, y - 2, 1, 1, head); rect(g, x, y + 2, 1, 1, head);
  rect(g, x, y, 1, 1, core);
}

function heart(g: G, x: number, y: number, c: string) {
  const rows = [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."];
  rows.forEach((r, j) => { for (let i = 0; i < 7; i++) if (r[i] === "X") rect(g, x + i, y + j, 1, 1, c); });
}

export function paint(g: G) {
  const W = 128, H = 80, cx = 58, cy = 42;
  const rnd = seeded(23);
  rect(g, 0, 0, W, H, "#1d1b3c");
  for (let i = 0; i < 46; i++) rect(g, Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 1, i % 4 ? "#5d5890" : "#e9e6ff");

  // ringed planet in the corner
  const px = 102, py = 62, pr = 10;
  for (let k = -17; k <= 17; k++) {
    const e = Math.sqrt(1 - (k / 17) ** 2) * 4;
    rect(g, px + k, Math.round(py + 1 - e - k * 0.15), 1, 1, "#4f4590");
  }
  for (let dy = -pr; dy < pr; dy++) for (let dx = -pr; dx < pr; dx++) {
    const fx = dx + 0.5, fy = dy + 0.5;
    if (Math.hypot(fx, fy) > pr) continue;
    let c = Math.floor((fy + 20) / 4) % 2 ? "#4a4690" : "#3b3878";
    if (fx * 0.6 + fy * 0.8 > pr * 0.45) c = "#2b2960";
    rect(g, px + dx, py + dy, 1, 1, c);
  }
  for (let k = -17; k <= 17; k++) {
    const e = Math.sqrt(1 - (k / 17) ** 2) * 4;
    rect(g, px + k, Math.round(py + 1 + e - k * 0.15), 1, 1, "#7a6cc0");
  }

  // dotted lanes and shield track
  for (let d = 24; d < 70; d += 4) {
    rect(g, cx + d, cy, 1, 1, "#2d2a55"); rect(g, cx - d - 1, cy, 1, 1, "#2d2a55");
    if (d < cy) { rect(g, cx, cy - d - 1, 1, 1, "#2d2a55"); rect(g, cx, cy + d, 1, 1, "#2d2a55"); }
  }
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * Math.PI * 2;
    rect(g, Math.floor(cx + Math.cos(a) * 18), Math.floor(cy + Math.sin(a) * 18), 1, 1, "#3a3670");
  }

  // incoming comets: orange from the top, blue fast one from the right
  comet(g, cx, 10, 0, 1, 11, "#ff9a5a", "#fff0d0", ["#ff6b5a", "#c8456e", "#7a3470"]);
  comet(g, cx + 44, cy, -1, 0, 20, "#9fe6ff", "#ffffff", ["#6fc8ff", "#4a7fe0", "#3a4aa0"]);

  // shield on the left, mid parry: a gold comet bounces back with sparks
  const R = 18;
  for (let dy = -R - 2; dy <= R + 2; dy++) for (let dx = -R - 2; dx <= R + 2; dx++) {
    const fx = dx + 0.5, fy = dy + 0.5, d = Math.hypot(fx, fy);
    if (d < R - 1.6 || d > R + 1.6) continue;
    let diff = Math.abs(Math.atan2(fy, fx) - Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > 0.72) continue;
    let c = d > R + 0.55 ? "#d4f8ff" : d < R - 0.55 ? "#2f8fc4" : "#6fdcff";
    if (diff > 0.63) c = "#2f8fc4";
    rect(g, cx + dx, cy + dy, 1, 1, c);
  }
  comet(g, cx - 37, cy, -1, 0, 9, "#ffe14a", "#fffbe0", ["#ffb43a", "#d9802a", "#8a4a2a"]);
  // ring and sparks at the contact point
  const hx = cx - R - 2;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    rect(g, Math.round(hx + Math.cos(a) * 7), Math.round(cy + Math.sin(a) * 7), 1, 1, k % 2 ? "#ffd84a" : "#ffffff");
  }
  for (const [sx, sy, c] of [[-12, -9, "#ffd84a"], [-15, 5, "#ffffff"], [-9, 10, "#ffd84a"], [-6, -12, "#ffffff"], [-17, -3, "#ffe14a"]] as const) {
    rect(g, hx + sx, cy + sy, 2, 2, c);
  }

  // the keeper: a warm round lantern with a happy face
  const r = 8;
  for (let dy = -r - 1; dy <= r; dy++) for (let dx = -r - 1; dx <= r; dx++) {
    const fx = dx + 0.5, fy = dy + 0.5, d = Math.hypot(fx, fy);
    if (d > r + 1) continue;
    let c = d > r ? "#3a2148" : "#ffd27a";
    if (d <= r && (fx * 0.6 + fy * 0.8) / r > 0.42) c = "#f0a050";
    rect(g, cx + dx, cy + dy, 1, 1, c);
  }
  rect(g, cx - 5, cy - 6, 2, 2, "#fff3c4");
  rect(g, cx - 6, cy - 4, 1, 1, "#fff3c4");
  const ex = cx - 1, ey = cy - 2;
  for (const sx of [-4, 2]) { rect(g, ex + sx, ey + 1, 1, 1, "#3a2148"); rect(g, ex + sx + 1, ey, 1, 1, "#3a2148"); rect(g, ex + sx + 2, ey + 1, 1, 1, "#3a2148"); }
  rect(g, ex - 1, ey + 5, 3, 1, "#3a2148");
  rect(g, ex - 2, ey + 4, 1, 1, "#3a2148"); rect(g, ex + 2, ey + 4, 1, 1, "#3a2148");
  rect(g, ex - 5, ey + 4, 1, 1, "#ff9a8a"); rect(g, ex + 5, ey + 4, 1, 1, "#ff9a8a");

  // three hearts top right
  for (let i = 0; i < 3; i++) heart(g, 98 + i * 9, 4, i < 2 ? "#ff6b8a" : "#3a3766");
}
