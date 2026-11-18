// Pixel-art covers for the game cards, painted at runtime into a tiny canvas and shown
// upscaled with image-rendering: pixelated. The colours are game art (like the palettes
// inside the games), not UI colours; everything around the covers uses the theme tokens.

export const COVER_W = 128;
export const COVER_H = 80;

type Paint = (g: CanvasRenderingContext2D) => void;

function rect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}

function hsl(h: number, s: number, l: number) {
  return `hsl(${((h % 360) + 360) % 360} ${s}% ${l}%)`;
}

/** Small deterministic random so a cover looks the same on every paint. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
}

/** Iso block drawn column by column like the game itself: clean 2:1 edges. */
function isoBlock(g: CanvasRenderingContext2D, sx: number, sy: number, w: number, d: number, h: number, hue: number) {
  const W = w + d, hd = d >> 1, hw = w >> 1, syB = sy - hd + hw;
  const top = hsl(hue + 6, 64, 76), rim = hsl(hue + 10, 82, 90);
  const left = hsl(hue - 10, 52, 62), right = hsl(hue - 22, 46, 47);
  for (let k = 0; k < W; k++) {
    const x = sx + k;
    const t = k < d ? sy - (k >> 1) : syB - ((W - 1 - k) >> 1);
    const isLeft = k < w;
    const b = isLeft ? sy + 1 + (k >> 1) : syB + 1 + ((W - 1 - k) >> 1);
    rect(g, x, t, 1, b - 1 - t, top);
    rect(g, x, b - 1, 1, 1, rim);
    rect(g, x, b, 1, h, isLeft ? left : right);
  }
}

const tower: Paint = (g) => {
  const rnd = seeded(7);
  rect(g, 0, 0, COVER_W, COVER_H, "#f0b49a");
  // sun and clouds
  rect(g, 98, 12, 12, 12, "#fbe3b4");
  rect(g, 96, 14, 16, 8, "#fbe3b4");
  for (const [cx, cy, cw] of [[8, 14, 26], [60, 8, 20], [84, 30, 18]] as const) {
    rect(g, cx + 4, cy, cw - 8, 2, "#f7d2c0");
    rect(g, cx, cy + 2, cw, 4, "#f7d2c0");
  }
  // two hill layers, flat colours
  for (const [base, amp, col, ph] of [[54, 6, "#c98a93", 1.3], [64, 5, "#8d6a92", 4.1]] as const) {
    for (let x = 0; x < COVER_W; x++) {
      const y = Math.round(base - amp * (0.5 + 0.5 * Math.sin(((x >> 1) * 2) * 0.07 + ph)));
      rect(g, x, y, 1, COVER_H - y, col);
    }
  }
  // the tower: blocks shrink and shift a little as they go up
  const hue0 = 175;
  let w = 22, d = 22, sx = 40, sy = 68;
  for (let i = 0; i < 7; i++) {
    isoBlock(g, sx, sy, w, d, 5, hue0 + i * 9);
    sy -= 5;
    if (i === 2) { w -= 4; sx += 4; }
    if (i === 4) { d -= 2; }
  }
  // the sliding block, offset to the right, with a few sparkles
  isoBlock(g, sx + 14, sy - 1, w, d, 5, hue0 + 7 * 9);
  for (let i = 0; i < 9; i++) {
    const x = 34 + Math.floor(rnd() * 44), y = 16 + Math.floor(rnd() * 22);
    rect(g, x, y, 1, 1, i % 3 ? "#ffffff" : "#ffd84a");
  }
};

const snake: Paint = (g) => {
  rect(g, 0, 0, COVER_W, COVER_H, "#16302c");
  // board dots
  for (let y = 4; y < COVER_H; y += 8) for (let x = 4; x < COVER_W; x += 8) rect(g, x, y, 1, 1, "#24504a");
  // snake path on an 8 px grid
  const path: [number, number][] = [[1, 7], [2, 7], [3, 7], [4, 7], [4, 6], [4, 5], [5, 5], [6, 5], [7, 5], [7, 4], [7, 3], [8, 3], [9, 3]];
  path.forEach(([cx, cy], i) => {
    const head = i === path.length - 1;
    rect(g, cx * 8 + 1, cy * 8 + 1, 7, 7, head ? "#9be8d2" : i % 2 ? "#3f9f90" : "#47ad9c");
    if (head) {
      rect(g, cx * 8 + 5, cy * 8 + 2, 2, 2, "#16302c");
      rect(g, cx * 8 + 5, cy * 8 + 5, 2, 2, "#16302c");
    }
  });
  // food
  rect(g, 12 * 8 + 2, 3 * 8 + 2, 5, 5, "#e8b44a");
  rect(g, 12 * 8 + 3, 3 * 8 + 3, 1, 1, "#fbe7b8");
  // voice: speech bubble with level bars over the snake head
  const bx = 66, by = 46;
  rect(g, bx, by, 46, 22, "#f2efea");
  rect(g, bx + 1, by - 1, 44, 1, "#f2efea");
  rect(g, bx + 1, by + 22, 44, 1, "#f2efea");
  rect(g, bx + 6, by + 23, 4, 2, "#f2efea");
  rect(g, bx + 6, by + 25, 2, 2, "#f2efea");
  [4, 8, 12, 7, 14, 10, 5, 11, 6].forEach((h, i) => {
    rect(g, bx + 5 + i * 4, by + 11 - (h >> 1), 2, h, i === 4 ? "#2c7a70" : "#3f9f90");
  });
};

export const COVERS: Record<string, Paint> = { tower, snake };

export function paintCover(canvas: HTMLCanvasElement, id: string, painter?: (g: CanvasRenderingContext2D) => void) {
  canvas.width = COVER_W;
  canvas.height = COVER_H;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.imageSmoothingEnabled = false;
  (painter ?? COVERS[id])?.(g);
}
