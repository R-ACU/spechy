// Game skins (palette swaps sold in the shop): which skin a game plays with, the neon snake
// colours, and `paintSkinPreview`, which draws a small scene in the real skin colours for the
// shop cards. Skins are Spechy-only; the standalone game files stay as they are.
//
// A game reads its equipped skin once when it starts (`withEquippedSkin`), so switching skins
// on the hub applies on the next round. Not equipped (or not owned) means the original look.
import { economySnapshot, loadEconomy, useEconomy } from "../../../lib/economy";
import type { EquipSlot } from "../../../lib/ipc";
import { cometSkinLook } from "../cometKeeper/engine";
import { towerSkinSwatches } from "../pixelTower";

export type TowerSkin = "sunset" | null;
export type SnakeSkin = "neon" | null;
export type CometSkinId = "ice" | null;

export const SKIN_ITEMS = {
  "tower-skin": { "tower-sunset": "sunset" },
  "snake-skin": { "snake-neon": "neon" },
  "comet-skin": { "comet-ice": "ice" },
} as const satisfies Record<string, Record<string, string>>;

/** Skin name a game option understands for the item equipped in `slot`, or null for the original look. */
export function skinFor(slot: "tower-skin", equipped: string | undefined): TowerSkin;
export function skinFor(slot: "snake-skin", equipped: string | undefined): SnakeSkin;
export function skinFor(slot: "comet-skin", equipped: string | undefined): CometSkinId;
export function skinFor(slot: EquipSlot, equipped: string | undefined): string | null {
  const map: Record<string, string> | undefined = (SKIN_ITEMS as Record<string, Record<string, string>>)[slot];
  return (equipped && map?.[equipped]) || null;
}

/** Calls `start` with the skin equipped right now (waiting for the economy if it is not
 *  loaded yet). Returns a cancel function: after it ran, `start` is never called. */
export function withEquippedSkin<S>(slot: EquipSlot, pick: (equipped: string | undefined) => S, start: (skin: S) => void): () => void {
  let live = true;
  const known = economySnapshot().state;
  if (known) start(pick(known.equipped[slot]));
  else {
    void loadEconomy()
      .then((s) => { if (live) start(pick(s.equipped[slot])); })
      .catch(() => { if (live) start(pick(undefined)); });
  }
  return () => { live = false; };
}

/** Skin name equipped right now for `slot` (null = original look); follows the economy state. */
export function useEquippedSkin(slot: "tower-skin"): TowerSkin;
export function useEquippedSkin(slot: "snake-skin"): SnakeSkin;
export function useEquippedSkin(slot: "comet-skin"): CometSkinId;
export function useEquippedSkin(slot: EquipSlot): string | null {
  const equipped = useEconomy().state?.equipped[slot];
  return (skinFor as (s: EquipSlot, e: string | undefined) => string | null)(slot, equipped);
}

/** Voice Snake colours: the original ones come from the theme tokens, the neon skin is fixed. */
export const NEON_SNAKE = {
  board: "#070d0a",
  grid: "#1c3a29",
  body: "#39ff6a",
  edge: "#0c9e3a",
  shine: "#c8ffd8",
  head: "#d6ffe2",
  glow: "#39ff6a",
  apple: "#ff4fa0",
  leaf: "#39ff6a",
  eye: "#ffffff",
  pupil: "#06120a",
};

// ---------- previews ----------

type Ctx = CanvasRenderingContext2D;
const rgb = (c: number) => `rgb(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255})`;

function paintTower(g: Ctx, w: number, h: number, skin: TowerSkin) {
  // dusk sky, the same tones the game shows at 18 to 34 blocks
  // flat sky bands, no smooth gradient
  for (const [from, to, c] of [[0, 0.28, "#c47a9b"], [0.28, 0.55, "#dc9393"], [0.55, 0.78, "#f0a98f"], [0.78, 1, "#f3d3a6"]] as const) {
    g.fillStyle = c;
    g.fillRect(0, Math.round(h * from), w, Math.ceil(h * (to - from)));
  }
  g.fillStyle = "rgba(255,255,255,0.55)";
  for (const [x, y] of [[0.16, 0.14], [0.8, 0.22], [0.62, 0.08], [0.3, 0.3]]) g.fillRect(Math.round(w * x), Math.round(h * y), 2, 2);

  const count = 5, bw = w * 0.4, bh = bw * 0.2;
  const sw = towerSkinSwatches(skin, count, 2);
  const cx = w / 2, base = h - bw * 0.5 - 4;
  const offs = [0, 0.06, -0.05, 0.04, -0.03, 0.02];
  for (let i = 0; i < count; i++) {
    const s = sw[i], bwi = bw * (1 - i * 0.03), x = cx + offs[i] * w, yTop = base - (i + 1) * bh;
    const half = bwi / 2, q = bwi / 4;
    g.fillStyle = s.left;
    g.beginPath(); g.moveTo(x - half, yTop + q); g.lineTo(x, yTop + 2 * q); g.lineTo(x, yTop + 2 * q + bh); g.lineTo(x - half, yTop + q + bh); g.closePath(); g.fill();
    g.fillStyle = s.right;
    g.beginPath(); g.moveTo(x + half, yTop + q); g.lineTo(x, yTop + 2 * q); g.lineTo(x, yTop + 2 * q + bh); g.lineTo(x + half, yTop + q + bh); g.closePath(); g.fill();
    g.fillStyle = s.top;
    g.beginPath(); g.moveTo(x, yTop); g.lineTo(x + half, yTop + q); g.lineTo(x, yTop + 2 * q); g.lineTo(x - half, yTop + q); g.closePath(); g.fill();
    g.strokeStyle = s.rim; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x - half, yTop + q); g.lineTo(x, yTop); g.lineTo(x + half, yTop + q); g.stroke();
  }
}

function paintSnake(g: Ctx, w: number, h: number) {
  const N = 8, cell = Math.min(w, h) / N, ox = (w - cell * N) / 2, oy = (h - cell * N) / 2;
  g.fillStyle = NEON_SNAKE.board;
  g.fillRect(0, 0, w, h);
  g.fillStyle = NEON_SNAKE.grid;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { g.beginPath(); g.arc(ox + (x + 0.5) * cell, oy + (y + 0.5) * cell, Math.max(1, cell * 0.05), 0, Math.PI * 2); g.fill(); }
  const at = (c: number, r: number): [number, number] => [ox + (c + 0.5) * cell, oy + (r + 0.5) * cell];
  // apple
  const [ax, ay] = at(6, 5), ar = cell * 0.3;
  g.fillStyle = NEON_SNAKE.apple; g.beginPath(); g.arc(ax, ay + cell * 0.05, ar, 0, Math.PI * 2); g.fill();
  g.fillStyle = NEON_SNAKE.leaf; g.beginPath(); g.ellipse(ax + ar * 0.35, ay - ar * 0.9, ar * 0.42, ar * 0.2, -0.6, 0, Math.PI * 2); g.fill();
  // body, tail to head, heading right
  const cells: [number, number][] = [[0, 5], [1, 5], [2, 5], [2, 4], [2, 3], [3, 3], [4, 3], [4, 4], [5, 4]];
  const pts = cells.map(([c, r]) => at(c, r)).reverse(); // head first
  const n = pts.length, width = (i: number) => cell * (0.76 - 0.26 * (i / (n - 1)));
  g.lineCap = "round"; g.lineJoin = "round";
  const passes: [string, number, number, number][] = [[NEON_SNAKE.edge, 2.4, 1, 0], [NEON_SNAKE.body, 0, 1, cell * 0.5], [NEON_SNAKE.shine, 0, 0.2, 0]];
  for (const [colour, extra, scale, glow] of passes) {
    g.strokeStyle = colour; g.shadowColor = NEON_SNAKE.glow; g.shadowBlur = glow;
    for (let i = n - 1; i > 0; i--) {
      g.lineWidth = width(i - 1) * scale + extra;
      g.beginPath(); g.moveTo(pts[i][0], pts[i][1]); g.lineTo(pts[i - 1][0], pts[i - 1][1]); g.stroke();
    }
  }
  g.shadowBlur = 0;
  const [hx, hy] = pts[0], hr = cell * 0.45;
  g.fillStyle = NEON_SNAKE.head; g.beginPath(); g.arc(hx, hy, hr, 0, Math.PI * 2); g.fill();
  for (const side of [-1, 1]) {
    const ex = hx + hr * 0.3, ey = hy + hr * 0.45 * side;
    g.fillStyle = NEON_SNAKE.eye; g.beginPath(); g.arc(ex, ey, hr * 0.26, 0, Math.PI * 2); g.fill();
    g.fillStyle = NEON_SNAKE.pupil; g.beginPath(); g.arc(ex + hr * 0.1, ey, hr * 0.13, 0, Math.PI * 2); g.fill();
  }
}

function paintComet(g: Ctx, w: number, h: number, skin: CometSkinId) {
  const { styles, planet } = cometSkinLook(skin);
  g.fillStyle = "#1d1b3c";
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(((i * 7919) % 1000) / 1000 * w), y = Math.floor(((i * 104729) % 1000) / 1000 * h);
    g.fillStyle = i % 6 === 0 ? "#e9e6ff" : "#5d5890";
    g.fillRect(x, y, 1, 1);
  }
  // planet with its ring, bottom right
  const px = w * 0.8, py = h * 0.78, r = Math.min(w, h) * 0.13;
  g.strokeStyle = rgb(planet.ringDark); g.lineWidth = Math.max(1, r * 0.16);
  g.beginPath(); g.ellipse(px, py + 2, r * 1.9, r * 0.5, -0.18, Math.PI, Math.PI * 2); g.stroke();
  g.fillStyle = rgb(planet.body); g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
  g.save(); g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.clip();
  g.fillStyle = rgb(planet.band); g.fillRect(px - r, py - r * 0.5, r * 2, r * 0.4);
  g.fillStyle = rgb(planet.shade); g.beginPath(); g.arc(px + r * 0.55, py + r * 0.55, r * 0.95, 0, Math.PI * 2); g.fill();
  g.restore();
  g.strokeStyle = rgb(planet.ring); g.beginPath(); g.ellipse(px, py + 2, r * 1.9, r * 0.5, -0.18, 0, Math.PI); g.stroke();

  // keeper with a shield, comets coming in along the lanes
  const cx = w * 0.42, cy = h * 0.5, rs = Math.min(w, h) * 0.14;
  g.fillStyle = "#ffd27a"; g.beginPath(); g.arc(cx, cy, rs * 0.38, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "#6fdcff"; g.lineWidth = Math.max(2, rs * 0.2); g.lineCap = "round";
  g.beginPath(); g.arc(cx, cy, rs, -0.72, 0.72); g.stroke();
  const comet = (kind: "normal" | "fast" | "gold", x: number, y: number, dx: number, dy: number, len: number) => {
    const st = styles[kind], seg = len / 3, wd = Math.max(2, rs * 0.28);
    for (let i = 2; i >= 0; i--) {
      g.strokeStyle = rgb(st.trail[i]); g.lineWidth = wd * (1 - i * 0.2);
      g.beginPath(); g.moveTo(x + dx * seg * i, y + dy * seg * i); g.lineTo(x + dx * seg * (i + 1), y + dy * seg * (i + 1)); g.stroke();
    }
    g.fillStyle = rgb(st.head); g.beginPath(); g.arc(x, y, wd * 0.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = rgb(st.core); g.beginPath(); g.arc(x, y, wd * 0.35, 0, Math.PI * 2); g.fill();
  };
  comet("normal", cx + rs * 2.2, cy, 1, 0, w * 0.26);
  comet("fast", cx, cy - rs * 2.1, 0, -1, h * 0.34);
  comet("gold", cx - rs * 2.6, cy, -1, 0, w * 0.2);
}

/** Draws a small scene in the colours of a skin item ("tower-sunset", "snake-neon",
 *  "comet-ice") onto `canvas`, using its current width and height. Unknown ids clear it. */
export function paintSkinPreview(canvas: HTMLCanvasElement, skinId: string) {
  const g = canvas.getContext("2d");
  if (!g) return;
  const w = canvas.width, h = canvas.height;
  g.save();
  g.clearRect(0, 0, w, h);
  if (skinId === "tower-sunset") paintTower(g, w, h, "sunset");
  else if (skinId === "snake-neon") paintSnake(g, w, h);
  else if (skinId === "comet-ice") paintComet(g, w, h, "ice");
  g.restore();
}
