// Pill skins (shop slot "pill"): the accent colour each skin gives the native pill's level dots
// while recording, and `paintPillPreview`, which draws the recording pill the way the Rust
// rasterizer does (src-tauri/src/pill.rs, `draw_static` + `draw_dynamic`), so a shop card shows
// the exact look. Colours must match `PILL_SKINS` in pill.rs. Fixed colours are art here.

export const PILL_SKINS = {
  "pill-amber": "#e8b44a",
  "pill-mint": "#4fd8a4",
  "pill-coral": "#f0736f",
} as const;

export type PillSkinId = keyof typeof PILL_SKINS;

/** Default dot colour when no skin is equipped. */
export const PILL_DEFAULT_ACCENT = "#ffffff";

/** Accent colour of a pill skin item, or the default white for null / unknown ids. */
export function pillAccent(skinId: string | null | undefined): string {
  return (skinId && (PILL_SKINS as Record<string, string>)[skinId]) || PILL_DEFAULT_ACCENT;
}

// Geometry of the pill at 100 % (pill.rs constants).
const PILL_W = 195;
const PILL_H = 52;
const SIDE_PADDING = 11;
const BUTTON_RADIUS = 15;
const DOT_RADIUS = 1.75;
const DOT_RADIUS_MAX = 3.5;
const DOT_SPACING = 7.5;
const RIM = 1.5;

export interface PillPreviewOptions {
  /** Microphone level 0..1 the dots show. Default 0.75. */
  level?: number;
  /** Animation time in seconds (drives the dot wave). Default a fixed pleasant frame. */
  time?: number;
}

/**
 * Draws the recording pill with `skinId`'s accent (null = default look) centred in `canvas`,
 * scaled to fit its pixel size. The canvas background is cleared to transparent; the pill body
 * is the same near-black translucent glass as the real one.
 */
export function paintPillPreview(canvas: HTMLCanvasElement, skinId: string | null | undefined, options: PillPreviewOptions = {}): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const level = Math.min(1, Math.max(0, options.level ?? 0.75));
  const time = options.time ?? 0.32;
  const accent = pillAccent(skinId);

  const { width, height } = canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  // Leave room for the shadow around the shape.
  const s = Math.min(width / (PILL_W + 24), height / (PILL_H + 24));
  const w = PILL_W * s;
  const h = PILL_H * s;
  const x = (width - w) / 2;
  const y = (height - h) / 2;
  const r = h / 2;

  const capsule = (cx: number, cy: number, cw: number, ch: number, cr: number) => {
    ctx.beginPath();
    ctx.roundRect(cx, cy, cw, ch, cr);
  };

  // Soft shadow, offset down.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 10 * s;
  ctx.shadowOffsetY = 4 * s;
  capsule(x, y, w, h, r);
  ctx.fillStyle = "rgba(16, 16, 18, 0.80)";
  ctx.fill();
  ctx.restore();

  // Glass body: flat near black.
  capsule(x, y, w, h, r);
  ctx.fillStyle = "rgba(21, 21, 23, 0.80)";
  ctx.fill();

  // Rim highlight: one flat translucent white.
  capsule(x + (RIM * s) / 2, y + (RIM * s) / 2, w - RIM * s, h - RIM * s, r - (RIM * s) / 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = RIM * s;
  ctx.stroke();

  const middle = y + h / 2;
  const br = BUTTON_RADIUS * s;
  ctx.lineCap = "round";

  // Cancel: grey circle with a thin X.
  const cancelX = x + SIDE_PADDING * s + br;
  ctx.fillStyle = "#4a4a4a";
  ctx.beginPath();
  ctx.arc(cancelX, middle, br, 0, Math.PI * 2);
  ctx.fill();
  const arm = 5 * s;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(cancelX - arm, middle - arm);
  ctx.lineTo(cancelX + arm, middle + arm);
  ctx.moveTo(cancelX - arm, middle + arm);
  ctx.lineTo(cancelX + arm, middle - arm);
  ctx.stroke();

  // Confirm: white circle with a dark check.
  const confirmX = x + w - SIDE_PADDING * s - br;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(confirmX, middle, br, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#0d0d0d";
  ctx.lineWidth = 1.9 * s;
  ctx.beginPath();
  ctx.moveTo(confirmX - 4.6 * s, middle + 0.3 * s);
  ctx.lineTo(confirmX - 1.4 * s, middle + 3.6 * s);
  ctx.lineTo(confirmX + 4.8 * s, middle - 3.6 * s);
  ctx.stroke();

  // Ten level dots in the skin accent, same wave as the native pill.
  const spacing = DOT_SPACING * s;
  const center = (cancelX + br + confirmX - br) / 2;
  const left = center - spacing * 4.5;
  ctx.fillStyle = accent;
  for (let i = 0; i < 10; i++) {
    const wave = 0.55 + 0.45 * Math.sin(time * 7 + i * 0.85);
    const amount = level * wave;
    ctx.globalAlpha = 0.6 + 0.4 * amount;
    ctx.beginPath();
    ctx.arc(left + spacing * i, middle, (DOT_RADIUS + (DOT_RADIUS_MAX - DOT_RADIUS) * amount) * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
