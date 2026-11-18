// Rank art "Schatzkammer" (variant 1 of _dev/mockups/social-shop/rank-art.js, picked by the owner):
// Bronze a nugget, Silver a bar, Gold three bars, Platinum a bar pyramid, Diamond a cut stone,
// Master a heap of gems, Champion a crown on gold bars. Flat fills, light from the top, no
// outlines, no gradients, no text. Illustration art, so fixed colours are allowed here.
// Everything lives in a 100 x 100 box standing on y = 84; the division pips sit at y 90..96.

export interface RankPalette { hi: string; mid: string; lo: string; dk: string; gem?: string; gem2?: string }

/** One palette per tier: 0 Bronze .. 6 Champion. */
export const RANK_PALETTES: readonly RankPalette[] = [
  { hi: "#f2b88a", mid: "#d08750", lo: "#a05d2e", dk: "#6f3d1c" },
  { hi: "#f5f7fa", mid: "#c7ced8", lo: "#8f99a8", dk: "#5c6574" },
  { hi: "#ffe08a", mid: "#f6b93b", lo: "#c8851a", dk: "#8c560a" },
  { hi: "#bdfcf1", mid: "#5fd8c9", lo: "#2d9d91", dk: "#196a62" },
  { hi: "#e4d8ff", mid: "#ad8eff", lo: "#7757e2", dk: "#4c33a6" },
  { hi: "#ffc4d1", mid: "#ff6b8b", lo: "#d23d61", dk: "#8f2140" },
  { hi: "#fff2c2", mid: "#ffcf4d", lo: "#e39a1c", dk: "#a8650a", gem: "#ff4f74", gem2: "#7fd8ff" },
];

/** The signature colour of every tier (the mid tone of its art). */
export const RANK_COLORS: readonly string[] = RANK_PALETTES.map((p) => p.mid);

export const RANK_TIER_NAMES = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Champion"] as const;
export const CHAMPION_TIER = 6;

type Pt = readonly [number, number];

const r1 = (n: number) => Math.round(n * 10) / 10;
const pts = (a: readonly Pt[]) => a.map((p) => `${r1(p[0])},${r1(p[1])}`).join(" ");
const poly = (a: readonly Pt[], f: string) => `<polygon points="${pts(a)}" fill="${f}"/>`;
const rect = (x: number, y: number, w: number, h: number, f: string, rx = 0) =>
  `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${rx}" fill="${f}"/>`;
const circ = (cx: number, cy: number, r: number, f: string) => `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="${f}"/>`;
const ell = (cx: number, cy: number, rx: number, ry: number, f: string) =>
  `<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(rx)}" ry="${r1(ry)}" fill="${f}"/>`;
const g = (inner: string, t: string) => `<g transform="${t}">${inner}</g>`;

/** Division pips I..III; unlit pips take their colour from the theme (class rank-pip-off). */
function pips(ti: number, div: number | null | undefined): string {
  if (div == null || ti >= CHAMPION_TIER) return "";
  const c = RANK_PALETTES[ti].mid;
  return [0, 1, 2]
    .map((d) => (d <= div ? rect(50 - 29 + d * 20, 90, 18, 6, c, 3) : `<rect class="rank-pip-off" x="${r1(21 + d * 20)}" y="90" width="18" height="6" rx="3"/>`))
    .join("");
}

/** Ingot seen from the front, slightly from above: top face, front face, shaded right end, stamp. */
function ingot(cx: number, by: number, w: number, h: number, p: RankPalette, stamp = true): string {
  const k = h * 0.42, d = h * 0.42;
  const A: Pt = [cx - w / 2, by], B: Pt = [cx + w / 2, by], C: Pt = [cx + w / 2 - k, by - h], D: Pt = [cx - w / 2 + k, by - h];
  const tC: Pt = [C[0] - k * 0.55, by - h - d], tD: Pt = [D[0] + k * 0.55, by - h - d];
  let s = poly([D, C, tC, tD], p.hi);
  s += poly([A, B, C, D], p.mid);
  s += poly([B, C, [C[0] - w * 0.06, C[1]], [B[0] - w * 0.06 - k * 0.3, by]], p.lo);
  if (stamp) s += rect(cx - w * 0.2, by - h * 0.68, w * 0.4, h * 0.36, p.lo, h * 0.08);
  return s;
}

/** Brilliant-cut gem pointing down. top = table height, w = girdle width, h = total height. */
function gem(cx: number, top: number, w: number, h: number, p: RankPalette): string {
  const gy = top + h * 0.3;
  const L: Pt = [cx - w / 2, gy], R: Pt = [cx + w / 2, gy], TL: Pt = [cx - w * 0.27, top], TR: Pt = [cx + w * 0.27, top];
  const mL: Pt = [cx - w * 0.16, gy], mR: Pt = [cx + w * 0.16, gy], B: Pt = [cx, top + h];
  return poly([L, TL, mL], p.mid) + poly([TL, TR, mR, mL], p.hi) + poly([TR, R, mR], p.lo) +
    poly([L, mL, B], p.lo) + poly([mL, mR, B], p.mid) + poly([mR, R, B], p.dk);
}

/** Crown with three faces, ball tips and gems on the band. */
function crown(x0: number, x1: number, base: number, top: number, p: RankPalette, gemA: string, gemB: string): string {
  const w = x1 - x0, cx = (x0 + x1) / 2, bandH = (base - top) * 0.22;
  const t1: Pt = [x0 - w * 0.04, top + (base - top) * 0.22], t3: Pt = [x1 + w * 0.04, t1[1]], t2: Pt = [cx, top];
  const v1: Pt = [x0 + w * 0.27, top + (base - top) * 0.46], v2: Pt = [x1 - w * 0.27, v1[1]];
  const bt = base - bandH;
  let s = poly([[x0, bt], t1, v1, [v1[0], bt]], p.hi);
  s += poly([[v1[0], bt], v1, t2, v2, [v2[0], bt]], p.mid);
  s += poly([[v2[0], bt], v2, t3, [x1, bt]], p.lo);
  s += rect(x0, bt, w, bandH, p.dk);
  s += rect(x0, bt, w, bandH * 0.3, p.lo);
  const br = w * 0.065;
  s += circ(t1[0], t1[1], br, p.hi) + circ(t2[0], t2[1], br * 1.15, p.hi) + circ(t3[0], t3[1], br, p.hi);
  const gy = bt + bandH * 0.6, gr = bandH * 0.3;
  s += circ(cx, gy, gr * 1.15, gemA) + circ(x0 + w * 0.2, gy, gr, gemB) + circ(x1 - w * 0.2, gy, gr, gemB);
  return s;
}

/** The art of a tier without pips (inner SVG markup in the 100 x 100 box). */
function tierArt(ti: number): string {
  const p = RANK_PALETTES[ti];
  let s = "";
  if (ti === 0) {
    s += poly([[20, 84], [14, 71], [21, 58], [36, 49], [55, 47], [72, 53], [85, 66], [82, 84]], p.mid);
    s += poly([[21, 58], [36, 49], [55, 47], [72, 53], [62, 60], [44, 59], [30, 66], [17, 66]], p.hi);
    s += poly([[85, 66], [82, 84], [58, 84], [64, 74], [74, 70]], p.lo);
    s += poly([[20, 84], [14, 71], [24, 76], [36, 84]], p.lo);
    s += ell(45, 72, 6, 3.2, p.lo) + ell(66, 62, 3.5, 2, p.mid);
    s = g(s, "translate(50 84) scale(1.2) translate(-50 -84)");
  } else if (ti === 1) {
    s += ingot(50, 84, 80, 30, p);
  } else if (ti === 2) {
    s += ingot(28, 84, 44, 20, p) + ingot(72, 84, 44, 20, p) + ingot(50, 64, 44, 20, p);
  } else if (ti === 3) {
    const w = 30, h = 15;
    s += ingot(19, 84, w, h, p) + ingot(50, 84, w, h, p) + ingot(81, 84, w, h, p);
    s += ingot(34.5, 69, w, h, p) + ingot(65.5, 69, w, h, p) + ingot(50, 54, w, h, p);
  } else if (ti === 4) {
    s += ingot(50, 84, 56, 12, { hi: p.lo, mid: p.dk, lo: "#382578", dk: p.dk }, false);
    s += gem(50, 8, 70, 62, p);
  } else if (ti === 5) {
    s += g(gem(0, -40, 38, 40, p), "translate(27 82) rotate(-24)");
    s += g(gem(0, -40, 38, 40, p), "translate(73 82) rotate(24)");
    s += gem(50, 14, 62, 70, p);
  } else {
    s += ingot(28, 84, 42, 15, p, false) + ingot(72, 84, 42, 15, p, false);
    s += crown(20, 80, 68, 16, p, p.gem ?? p.hi, p.gem2 ?? p.mid);
  }
  return s;
}

const cache = new Map<string, string>();

/** Inline SVG markup of a rank emblem. tier 0..6, division 0..2 (I..III) or null for no pips. */
export function rankArt(tier: number, size: number, division: number | null = null): string {
  const ti = Math.max(0, Math.min(CHAMPION_TIER, Math.round(tier)));
  const key = `${ti}|${size}|${division ?? "-"}`;
  let svg = cache.get(key);
  if (!svg) {
    svg = `<svg class="rank-art" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${tierArt(ti)}${pips(ti, division)}</svg>`;
    cache.set(key, svg);
  }
  return svg;
}

export const tierColor = (tier: number) => RANK_COLORS[Math.max(0, Math.min(CHAMPION_TIER, tier))];
