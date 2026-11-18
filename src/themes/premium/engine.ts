// Field engine of the three premium themes (port of class `Field` in _dev/mockups/social-shop).
// Each frame paints a tiny source image, one pixel per character cell, then turns it into ASCII:
//   genesis  the two hands of the Creation of Adam at the edges, a turning 3D logo in the gap
//   bloom    a rose seen from the side grows bottom right, opens, sheds petals, fades, regrows
//   horizon  a black hole: tilted accretion disk, lensed arc, photon ring; burns while you dictate
// Loaded with a dynamic import (registry.ts, ThemeCardPreview) so it only costs while it is used.
//
// Budget: every field shares one requestAnimationFrame loop capped at 30 fps, which stops while the
// window is hidden; cards pause when off screen; reduced motion draws one still frame. Adaptive cap:
// when the fields' average draw time per frame climbs over SLOW_AVG_MS (software canvas, as in
// WebKitGTK on Linux, where Bloom alone took about 30 % CPU) the loop drops to 20 fps, and it only
// goes back to 30 fps once frames are cheap again. Glyphs are not
// drawn cell by cell: each row is one fillText in white, then the upscaled source image is laid over
// with "source-in", so a frame costs about one fillText per row instead of one per cell.
import handAdamUrl from "./assets/hand-adam.png";
import handGodUrl from "./assets/hand-god.png";
import claudeCodeUrl from "./assets/logo-claudecode.png";
import claudeUrl from "./assets/logo-claude.png";
import codexUrl from "./assets/logo-codex.png";
import geminiUrl from "./assets/logo-gemini.png";
import grokUrl from "./assets/logo-grok.png";
import type { PremiumThemeId } from "./catalog";
import { dictationEnergy, followDictation } from "./dictation";

const FRAME_MS = 1000 / 30;
const SLOW_FRAME_MS = 1000 / 20;
/** Average draw time of one loop tick (all fields) in ms: above SLOW the loop drops to 20 fps,
 *  below FAST it returns to 30 fps. The gap keeps it from flipping back and forth. */
const SLOW_AVG_MS = 10;
const FAST_AVG_MS = 5;
/** Ticks measured before the cap may change. */
const WARMUP = 30;
const RAMP = " .:-=+*#%@";
const FONT_STACK = `"Cascadia Mono", "JetBrains Mono", Consolas, "DejaVu Sans Mono", ui-monospace, monospace`;
/** The art runs under the whole window; left of `data-calm` (the transparent navigation) its colour
 *  is dimmed to this factor, eased back to full over CALM_BLEND css px, so the labels stay readable. */
const CALM_LEVEL = 0.3;
const CALM_BLEND = 120;

/** Field ground per theme; the same values are --bg / --skin-panel in themes.css. */
export const FIELD_BG: Record<PremiumThemeId, string> = { genesis: "#0a0806", bloom: "#090506", horizon: "#050403" };

// ---------------------------------------------------------------- art assets
const images: Record<string, HTMLImageElement> = {};
const pending = new Set<() => void>();
function image(key: string, url: string): HTMLImageElement {
  const i = new Image();
  i.decoding = "async";
  i.onload = () => pending.forEach((f) => f());
  i.src = url;
  images[key] = i;
  return i;
}
const ok = (i: HTMLImageElement | undefined): i is HTMLImageElement => !!i && i.complete && i.naturalWidth > 0;

image("handL", handAdamUrl);
image("handR", handGodUrl);
const LOGOS = ["claudecode", "claude", "codex", "gemini", "grok"] as const;
const LOGO_URL: Record<(typeof LOGOS)[number], string> = { claudecode: claudeCodeUrl, claude: claudeUrl, codex: codexUrl, gemini: geminiUrl, grok: grokUrl };
LOGOS.forEach((k) => image("logo_" + k, LOGO_URL[k]));

/** CPU-side copy of an image, at most `maxH` px high. The source canvas is read back every frame,
 *  so everything drawn into it must live on the CPU too: an image or canvas on the GPU would cost a
 *  readback per draw (measured: 3x the frame time with accelerated canvas). */
const copies = new Map<string, HTMLCanvasElement>();
function cpu(key: string, maxH: number): HTMLCanvasElement | null {
  const hit = copies.get(key);
  if (hit) return hit;
  const src = images[key];
  if (!ok(src)) return null;
  const k = Math.min(1, maxH / src.naturalHeight);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.naturalWidth * k));
  c.height = Math.max(1, Math.round(src.naturalHeight * k));
  const x = c.getContext("2d", { willReadFrequently: true });
  if (!x) return null;
  x.imageSmoothingQuality = "high";
  x.drawImage(src, 0, 0, c.width, c.height);
  copies.set(key, c);
  return c;
}

/** Darkened copy of a logo, stacked to form the extruded edge. */
const sides = new Map<string, HTMLCanvasElement>();
function sideImg(name: string): HTMLCanvasElement | null {
  const hit = sides.get(name);
  if (hit) return hit;
  const src = cpu("logo_" + name, 128);
  if (!src) return null;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d", { willReadFrequently: true });
  if (!x) return null;
  x.drawImage(src, 0, 0, 128, 128);
  x.globalCompositeOperation = "source-atop";
  x.fillStyle = "rgba(0,0,0,.62)";
  x.fillRect(0, 0, 128, 128);
  sides.set(name, c);
  return c;
}

// ---------------------------------------------------------------- helpers
const hash = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, f: number): RGB => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const HOT: RGB = [255, 238, 205], WARM: RGB = [255, 158, 70], COOL: RGB = [185, 58, 24], STAR: RGB = [200, 200, 210];
const PETALS = ["#ff5470", "#ff8ea2", "#e8324f", "#ffb3c1", "#ff6680"];
/** Glyph for a brightness (0..1, quantised to LUT_N steps): the mockup's pow(lum, .8) ramp. */
const LUT_N = 1024;
const GLYPH_LUT = (() => {
  const a: string[] = [];
  for (let q = 0; q <= LUT_N; q++) a.push(RAMP[Math.max(1, Math.min(9, Math.floor(Math.pow(q / LUT_N, 0.8) * 11)))]);
  return a;
})();

interface Layout {
  /** Glyph size in css px; the cell is one advance wide and 1.08 font sizes high unless `cell` is set. */
  font: number;
  /** Fixed cell (width, height) in css px; glyphs are squeezed sideways to fit. Cards use a larger
   *  font in small cells (as the mockup does): 3.6 px glyphs rendered nearly black on a GPU canvas. */
  cell?: [number, number];
  roseScale: number;
  hx: number; hy: number; hr: number;
  /** Genesis: logo edge as a share of the shorter side of the scene. */
  logo: number;
  /** Genesis: hand scale over "the forearm just reaches the corner" (larger: forearms leave through
   *  the edges next to the corners and the meeting hands carry the picture). */
  reach: number;
  /** Fake dictation (cards); the main field follows the real state. */
  autoVoice: boolean;
  /** Honour `data-calm` (navigation width) on the canvas: dim the art there, never move or cut it. */
  calm: boolean;
}
const MAIN: Layout = { font: 7.8, roseScale: 0.62, hx: 0.68, hy: 0.56, hr: 0.1, logo: 0.17, reach: 1.3, autoVoice: false, calm: true };
const CARD: Layout = { font: 5.2, cell: [3, 5.4], roseScale: 0.72, hx: 0.5, hy: 0.5, hr: 0.2, logo: 0.28, reach: 1.8, autoVoice: true, calm: false };

/** Genesis art in painting pixels (adam.jpg, 3524 x 1599): where each crop sits, the fingertip,
 *  and how far the arm runs from the fingertip to its far end. The crops (assets/hand-*.png) are
 *  stored at a smaller scale; drawImage stretches them back to these boxes. Both arms rise about
 *  9 degrees to the right in the painting (TILT); each arm is turned so it points at its corner. */
const ARM = {
  adam: { x: 516, y: 624, w: 833, h: 265, tip: [1330, 735], len: 790 },
  god: { x: 1321, y: 536, w: 703, h: 298, tip: [1340, 718], len: 670 },
} as const;
const TILT = -9 * Math.PI / 180;

interface Petal { x: number; y: number; vx: number; vy: number; r: number; vr: number; f: number; vf: number; s: number; c: string }

// ---------------------------------------------------------------- one field
class Field {
  private g: CanvasRenderingContext2D;
  private src = document.createElement("canvas");
  private sg: CanvasRenderingContext2D;
  private t0 = performance.now();
  private prev = 0;
  private w = 0; private h = 0; private dpr = 1;
  private cw = 4; private ch = 8; private cols = 0; private rows = 0;
  /** Horizontal glyph scale so one advance fills one cell (1 without a fixed cell). */
  private sx = 1;
  private fontKey = "";
  /** Navigation width in css px (`data-calm`): the art is dimmed left of it, the scene still spans
   *  the whole canvas so motifs run on behind the navigation. */
  private ox = 0;
  private runT: string[] = [];
  private runX: number[] = [];
  private runY: number[] = [];
  private shX = new Float32Array(0); private chX = new Float32Array(0);
  private shY = new Float32Array(0); private chY = new Float32Array(0);
  private stars: Int32Array = new Int32Array(0);
  private starsKey = "";
  /** Stars to draw this frame: x, y, intensity triples. */
  private starOut: number[] = [];
  private parts: Petal[] = [];
  /** Genesis: falloff that dims the forearms toward the corners, rebuilt when the scene moves. */
  private shade: CanvasGradient | null = null;
  private shadeKey = "";
  private acc = 0;
  private en = 0;
  private phase = 0;
  visible = true;
  /** Rough cost meter: total ms spent drawing and frames drawn. */
  cost = { ms: 0, frames: 0 };

  constructor(private canvas: HTMLCanvasElement, readonly mode: PremiumThemeId, private L: Layout) {
    this.g = canvas.getContext("2d")!;
    this.canvas.style.backgroundColor = FIELD_BG[mode];
    this.sg = this.src.getContext("2d", { willReadFrequently: true })!;
  }

  private measure(): boolean {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w < 2 || h < 2) return false;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    this.w = w; this.h = h; this.dpr = dpr;
    const font = `${this.L.font}px ${FONT_STACK}`;
    if (font !== this.fontKey) {
      this.fontKey = font;
      this.g.font = font;
      const adv = this.g.measureText("MMMMMMMMMM").width / 10 || this.L.font * 0.55;
      this.cw = this.L.cell?.[0] ?? adv;
      this.ch = this.L.cell?.[1] ?? this.L.font * 1.08;
      this.sx = this.cw / adv;
    }
    this.cols = Math.ceil(w / this.cw);
    this.rows = Math.ceil(h / this.ch);
    if (this.shX.length !== this.cols) { this.shX = new Float32Array(this.cols); this.chX = new Float32Array(this.cols); }
    if (this.shY.length !== this.rows) {
      this.shY = new Float32Array(this.rows); this.chY = new Float32Array(this.rows);
      for (let y = 0; y < this.rows; y++) { this.shY[y] = Math.sin(y * 0.22); this.chY[y] = Math.cos(y * 0.22); }
    }
    if (this.src.width !== this.cols) this.src.width = this.cols;
    if (this.src.height !== this.rows) this.src.height = this.rows;
    this.ox = this.L.calm ? Math.max(0, Math.min(w * 0.5, Number(this.canvas.dataset.calm) || 0)) : 0;
    return true;
  }

  /** Draw the frame for wall clock `now` (ms). */
  draw(now: number) {
    const a = performance.now();
    if (!this.measure()) return;
    const t = Math.max(0, (now - this.t0) / 1000);
    const dt = this.prev ? Math.min(0.1, (now - this.prev) / 1000) : 0;
    this.prev = now;
    this.scene(t, dt);
    this.ascii(t);
    this.cost.ms += performance.now() - a;
    this.cost.frames += 1;
  }

  /** One calm frame for reduced motion: logo facing front, rose in full bloom, disk at rest. */
  drawStill() {
    if (!this.measure()) return;
    this.prev = 0;
    if (this.mode === "bloom") {
      this.parts = []; this.acc = 0;
      for (let s = 0; s < 13; s += 0.1) this.scene(s, 0.1);
      this.scene(13, 0.1);
      this.ascii(13);
    } else if (this.mode === "genesis") {
      this.scene(0.2, 0);
      this.ascii(0.2);
    } else {
      this.en = 0; this.phase = 12;
      this.scene(12, 0);
      this.ascii(12);
    }
  }

  private scene(t: number, dt: number) {
    const sg = this.sg;
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalAlpha = 1;
    sg.fillStyle = "#000";
    sg.fillRect(0, 0, this.cols, this.rows);
    if (this.mode === "genesis") this.genesis(t);
    else if (this.mode === "bloom") this.bloom(t, dt);
    else this.horizon(t, dt);
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.globalAlpha = 1;
  }

  // ---- Genesis: on the diagonal of the canvas (the whole window, or the whole card), Adam reaches
  // in from the top left corner (behind the navigation, dimmed there), God from the bottom right; the
  // fingertips meet in the centre and the logo turns in the gap. Drawn in css px, landing in cells.
  private genesis(t: number) {
    const handL = cpu("handL", 1024), handR = cpu("handR", 1024);
    if (!handL || !handR) return;
    const sg = this.sg, W = this.w, H = this.h;
    const cx = W / 2, cy = H / 2;
    const L = Math.min(W, H) * this.L.logo, gap = L * 1.35;
    // Each arm points at its own corner and is long enough to run past it.
    const dA = Math.hypot(cx, cy), dG = Math.hypot(W - cx, H - cy);
    const s = this.L.reach * Math.max((dA - gap / 2) / ARM.adam.len, (dG - gap / 2) / ARM.god.len);
    const drift = Math.sin(t * 0.35) * Math.min(W, H) * 0.008, bob = Math.sin(t * 0.4) * 3;
    sg.setTransform(1 / this.cw, 0, 0, 1 / this.ch, 0, 0);
    sg.save();
    const arm = (img: HTMLCanvasElement, a: (typeof ARM)["adam" | "god"], toward: number, side: -1 | 1, wobble: number) => {
      sg.save();
      sg.translate(cx, cy);
      sg.rotate(toward);
      // fingertip on the arm's axis, half the gap (less the drift) away from the centre
      sg.translate(side * (gap / 2 - drift), wobble);
      sg.rotate(-TILT);
      sg.scale(s, s);
      sg.drawImage(img, a.x - a.tip[0], a.y - a.tip[1], a.w, a.h);
      sg.restore();
    };
    arm(handL, ARM.adam, Math.atan2(cy, cx), -1, bob);
    arm(handR, ARM.god, Math.atan2(H - cy, W - cx), 1, -bob);
    // The forearms dim toward the corners (sparser glyphs), so headings in the top left stay
    // readable and the meeting hands stay the brightest part. Shading of the source image only;
    // cards carry no text and keep the full arms.
    const d = Math.max(dA, dG);
    if (this.L.calm && (!this.shade || this.shadeKey !== `${cx}|${cy}|${d}`)) {
      this.shadeKey = `${cx}|${cy}|${d}`;
      this.shade = sg.createRadialGradient(cx, cy, d * 0.3, cx, cy, d);
      this.shade.addColorStop(0, "rgba(0,0,0,0)");
      this.shade.addColorStop(1, "rgba(0,0,0,.6)");
    }
    if (this.L.calm && this.shade) { sg.fillStyle = this.shade; sg.fillRect(0, 0, W, H); }
    sg.restore();
    this.logo3d(cx, cy + Math.sin(t * 1.1) * 3, L, L, t);
  }

  /** An extruded coin: darkened copies form the edge, the lit face on top. Lingers facing front,
   *  the next logo takes over edge on. */
  private logo3d(cx: number, cy: number, L: number, Lh: number, t: number) {
    const sg = this.sg, P = 3.6, k = Math.floor(t / P);
    let u = (t % P) / P;
    u = u - Math.sin(2 * Math.PI * u) / (2 * Math.PI) * 0.85;
    const phi = u * Math.PI, second = phi > Math.PI / 2;
    const name = LOGOS[(k + (second ? 1 : 0)) % LOGOS.length];
    const face = cpu("logo_" + name, 128);
    if (!face) return;
    const sx = Math.max(0.03, Math.abs(Math.cos(phi))), w = L * sx;
    const dir = second ? 1 : -1, depth = L * 0.1, D = 12;
    const side = sideImg(name);
    if (side) for (let i = D; i >= 1; i--) {
      const off = dir * Math.sin(phi) * depth * i / D;
      sg.drawImage(side, cx - w / 2 + off, cy - Lh / 2, w, Lh);
    }
    sg.globalAlpha = 0.45 + 0.55 * sx;
    sg.drawImage(face, cx - w / 2, cy - Lh / 2, w, Lh);
    sg.globalAlpha = 1;
  }

  // ---- Bloom: stem grows from the ground bottom right, the bud opens petal by petal, loose petals
  // drift across the field, then everything fades and the rose regrows (23 s loop).
  private bloom(t: number, dt: number) {
    const sg = this.sg, cw = this.cw, ch = this.ch;
    const W = this.w, H = this.h;
    sg.setTransform(1 / cw, 0, 0, 1 / ch, 0, 0);   // draw in pixels, land in character cells
    const LOOP = 23, u = t % LOOP;
    const grow = ease(clamp01(u / 4.5)), bl = ease(clamp01((u - 4.5) / 7.5));
    const fade = clamp01((u - 19) / 2.6);
    const k = this.L.roseScale / 0.62;
    // faint ground, no grass
    sg.fillStyle = "rgba(120,96,88,.32)";
    for (let x = 0; x < W; x += cw) if (hash(x | 0, 7) > 0.62) sg.fillRect(x, H - ch * 1.2, cw, ch);
    sg.globalAlpha = 1 - fade;
    const bx = W * 0.86, stemLen = H * 0.5 * k * grow;
    const sway = Math.sin(t * 0.6) * 5 * grow;
    const tx = bx - 14 * k + sway, ty = H - ch - stemLen;
    if (grow > 0) {
      sg.strokeStyle = "#7d8f68"; sg.lineWidth = 8 * k; sg.lineCap = "round";
      sg.beginPath(); sg.moveTo(bx, H - ch);
      sg.bezierCurveTo(bx + 10 * k, H - ch - stemLen * 0.35, tx - 12 * k, H - ch - stemLen * 0.7, tx, ty); sg.stroke();
      // thorns
      sg.fillStyle = "#93a57c";
      for (const [f, s] of [[0.25, 1], [0.48, -1], [0.7, 1]]) {
        if (f > grow) continue;
        const px = bx + (tx - bx) * f + 4 * k * Math.sin(f * 3), py = H - ch - stemLen * f;
        sg.beginPath(); sg.moveTo(px, py - 4 * k); sg.lineTo(px + s * 9 * k, py - 9 * k); sg.lineTo(px, py + 3 * k); sg.fill();
      }
    }
    // the head
    const S = H * 0.2 * k * (0.3 + 0.7 * grow);
    sg.save(); sg.translate(tx, ty); sg.rotate(-0.12 + Math.sin(t * 0.6) * 0.03);
    const petal = (len: number, wid: number, ang: number, open: number, fill: string, rim: string) => {
      // profile of one petal: swells out from the base, the tip rolls outward and down as it opens
      sg.save(); sg.rotate(ang);
      const curl = open * wid * 0.7;
      sg.beginPath(); sg.moveTo(0, 0);
      sg.bezierCurveTo(wid * 1.2, -len * 0.25, wid * 1.05, -len * 0.75, wid * 0.55 + curl, -len * (1 - 0.12 * open));
      sg.bezierCurveTo(wid * 0.8 + curl * 1.35, -len * (0.92 - 0.22 * open), wid * 0.35 + curl * 0.6, -len * (0.88 - 0.1 * open), wid * 0.1, -len * 0.8);
      sg.bezierCurveTo(-wid * 0.15, -len * 0.5, -wid * 0.2, -len * 0.2, 0, 0);
      sg.fillStyle = fill; sg.fill();
      sg.strokeStyle = rim; sg.lineWidth = 5.5; sg.lineJoin = "round"; sg.stroke();
      sg.restore();
    };
    // side petals, outer ones open first and roll back furthest
    const FILL = ["#a81f3b", "#951a35", "#82152f", "#6e1129"], RIM = ["#ff9aac", "#ff8599", "#f86f86", "#e95c75"];
    for (let i = 0; i < 4; i++) {
      const bi = clamp01((bl - i * 0.14) / 0.58);
      const len = S * (1.1 - i * 0.12) * (0.9 + 0.2 * bi), wid = S * (0.36 - i * 0.04);
      const ang = 0.08 + bi * (0.7 - i * 0.15);
      petal(len, wid, -ang, bi, FILL[i], RIM[i]);
      sg.save(); sg.scale(-1, 1); petal(len * 0.96, wid, -ang * 0.94, bi, FILL[i], RIM[i]); sg.restore();
    }
    // closed core with a hint of the spiral
    const coreH = S * (1.0 - 0.25 * bl), coreW = S * (0.3 + 0.1 * bl);
    sg.beginPath(); sg.moveTo(0, 0);
    sg.bezierCurveTo(coreW * 1.2, -coreH * 0.2, coreW * 0.7, -coreH * 0.9, 0, -coreH);
    sg.bezierCurveTo(-coreW * 0.7, -coreH * 0.9, -coreW * 1.2, -coreH * 0.2, 0, 0);
    sg.fillStyle = "#5e0c22"; sg.fill(); sg.strokeStyle = "#ff8aa0"; sg.lineWidth = 4.5; sg.stroke();
    sg.strokeStyle = "#d9475f"; sg.lineWidth = 3.5;
    sg.beginPath(); sg.moveTo(-coreW * 0.55, -coreH * 0.55); sg.quadraticCurveTo(0, -coreH * 0.78, coreW * 0.6, -coreH * 0.5); sg.stroke();
    sg.beginPath(); sg.moveTo(-coreW * 0.3, -coreH * 0.78); sg.quadraticCurveTo(coreW * 0.15, -coreH * 0.92, coreW * 0.35, -coreH * 0.74); sg.stroke();
    // front cup petal, lowers as the rose opens
    const cupT = -S * (0.58 - 0.22 * bl), cupW = S * (0.42 + 0.2 * bl);
    sg.beginPath(); sg.moveTo(-cupW, cupT);
    sg.bezierCurveTo(-cupW * 0.9, S * 0.12, cupW * 0.9, S * 0.12, cupW, cupT);
    sg.bezierCurveTo(cupW * 0.55, cupT + S * 0.16, cupW * 0.2, cupT + S * 0.02, 0, cupT + S * 0.1);
    sg.bezierCurveTo(-cupW * 0.2, cupT + S * 0.02, -cupW * 0.55, cupT + S * 0.16, -cupW, cupT);
    sg.fillStyle = "#b8243f"; sg.fill(); sg.strokeStyle = "#ffc4cf"; sg.lineWidth = 6; sg.stroke();
    // receptacle
    sg.beginPath(); sg.ellipse(0, S * 0.08, S * 0.14, S * 0.1, 0, 0, Math.PI * 2); sg.fillStyle = "#5e1222"; sg.fill();
    sg.restore();
    sg.globalAlpha = 1;
    // falling petals, like sakura
    const P = this.parts;
    const rate = u > 19 ? 0 : clamp01((bl - 0.3) / 0.45) * (26 * Math.max(0.5, W / 1300));
    this.acc += rate * dt;
    while (this.acc >= 1 && P.length < 180) {
      this.acc -= 1;
      const fromHead = Math.random() < 0.25;
      P.push({
        x: fromHead ? tx + (Math.random() - 0.5) * S : Math.random() * W * 1.15, y: fromHead ? ty - S * 0.5 : -12,
        vx: -14 - Math.random() * 22, vy: 26 + Math.random() * 30, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 3,
        f: Math.random() * 6.28, vf: 1.5 + Math.random() * 2.5, s: (0.8 + Math.random() * 0.7) * Math.max(0.6, k * 0.9),
        c: PETALS[Math.floor(Math.random() * PETALS.length)],
      });
    }
    if (this.acc > 1) this.acc = 1;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.x += (p.vx + Math.sin(t * 1.3 + p.f) * 18) * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.f += p.vf * dt;
      if (p.y > H + 20 || p.x < -30) { P.splice(i, 1); continue; }
      sg.save(); sg.translate(p.x, p.y); sg.rotate(p.r); sg.scale(Math.max(0.25, Math.abs(Math.cos(p.f))), 1);
      sg.beginPath(); sg.ellipse(0, 0, 13 * p.s, 7.5 * p.s, 0, 0, Math.PI * 2); sg.fillStyle = p.c; sg.fill();
      sg.restore();
    }
  }

  // ---- Event Horizon: disk, lensed far side over the top, thin photon ring, a few faint stars.
  private horizon(t: number, dt: number) {
    const { cols, rows, cw, ch } = this, W = this.w, H = this.h;
    const target = this.L.autoVoice ? (Math.sin(t * 0.8) > 0.55 ? 1 : 0) : dictationEnergy();
    this.en += (target - this.en) * Math.min(1, dt * 3);
    this.phase += dt * (1 + this.en * 2.4);
    const en = this.en, ph = this.phase;
    const cx = W * this.L.hx, cy = H * this.L.hy, R0 = Math.min(W, H) * this.L.hr * (1 + 0.04 * en);
    const img = this.sg.createImageData(cols, rows), d = img.data;
    // Only cells near the hole can be lit (disk to 4.4 R0 wide, flattened; lens and ring to 1.8 R0).
    const x0 = Math.max(0, Math.floor((cx - R0 * 4.5) / cw)), x1 = Math.min(cols, Math.ceil((cx + R0 * 4.5) / cw));
    const y0 = Math.max(0, Math.floor((cy - R0 * 1.9) / ch)), y1 = Math.min(rows, Math.ceil((cy + R0 * 1.9) / ch));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const X = (x + 0.5) * cw - cx, Y = (y + 0.5) * ch - cy, rho = Math.hypot(X, Y);
      let I = 0, temp = 0;
      const v = Y / 0.2, rd = Math.hypot(X, v), shadow = rho < R0;
      const inDisk = rd > R0 * 1.5 && rd < R0 * 4.4 && !(shadow && v < 0);
      if (inDisk) {
        const rn = (rd / R0 - 1.5) / 2.9, ang = Math.atan2(v, X);
        const a2 = ang - ph * 1.7 / Math.pow(rd / R0, 1.5);
        const streak = 0.55 + 0.45 * Math.sin(a2 * 7 + rn * 14) * Math.sin(a2 * 3 - rn * 6 + 1.3);
        const prof = Math.pow(1 - rn, 1.4) * Math.min(1, (rd / R0 - 1.5) * 3);
        I = 1.5 * prof * streak * (1 + 0.4 * (-X / rd)) * (0.9 + 0.6 * en); temp = 1 - rn;
      } else if (rho > R0 && rho < R0 * 1.8) {
        const k2 = (rho / R0 - 1) / 0.8, ang = Math.atan2(Y, X);
        const s2 = 0.7 + 0.3 * Math.sin(ang * 9 - ph * 2.6);
        I = Math.pow(1 - k2, 1.6) * (Y < 0 ? 1.15 : 0.7) * s2 * (0.9 + 0.5 * en); temp = 0.7 + 0.3 * (1 - k2);
      }
      const ring = 1 - Math.abs(rho / R0 - 1.03) / 0.1;
      if (ring > 0 && !(inDisk && v > 0)) { I = Math.max(I, ring * (1 + 0.2 * en)); temp = 1; }
      if (shadow && !inDisk) I = 0;
      if (I <= 0) continue;
      I = Math.min(1, I);
      const c = temp > 0.5 ? mix(WARM, HOT, (temp - 0.5) * 2) : mix(COOL, WARM, temp * 2);
      const i = (y * cols + x) * 4;
      d[i] = c[0] * I; d[i + 1] = c[1] * I; d[i + 2] = c[2] * I; d[i + 3] = 255;
    }
    // faint twinkling stars wherever nothing else is lit (positions fixed per grid size)
    const key = `${cols}x${rows}`;
    if (key !== this.starsKey) {
      this.starsKey = key;
      const list: number[] = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (hash(x, y) > 0.993) list.push(x, y);
      this.stars = Int32Array.from(list);
    }
    // Stars are drawn straight onto the field after the glyph pass (see ascii), so the colouring pass
    // only has to cover the box around the hole.
    const st = this.stars, out = this.starOut;
    out.length = 0;
    for (let n = 0; n < st.length; n += 2) {
      const x = st[n], y = st[n + 1], i = (y * cols + x) * 4;
      if (d[i + 3]) continue;
      if (x >= x0 && x < x1 && y >= y0 && y < y1 && Math.hypot((x + 0.5) * cw - cx, (y + 0.5) * ch - cy) < R0) continue;   // never inside the shadow
      out.push(x, y, 0.22 + 0.15 * Math.sin(t * 2 + hash(y, x) * 20));
    }
    this.sg.putImageData(img, 0, 0);
  }

  // ---- source image -> glyphs
  private ascii(t: number) {
    const { cols, rows, cw, ch, g, sg, ox } = this;
    const id = sg.getImageData(0, 0, cols, rows), px = id.data;
    const calm = this.L.calm && ox > 0, calmEnd = ox + CALM_BLEND;
    // Glyphs are collected as runs; a gap of GAP or more empty cells starts a new run, so long empty
    // stretches are never shaped as text.
    const GAP = 6;
    const runT = this.runT, runX = this.runX, runY = this.runY;
    let runs = 0, minX = cols, maxX = 0, minY = rows, maxY = 0;
    // shimmer sin(x*.35 + y*.22 + t*1.6), split into per column and per row tables
    const { shX, chX, shY, chY } = this;
    for (let x = 0; x < cols; x++) { const a = x * 0.35 + t * 1.6; shX[x] = Math.sin(a); chX[x] = Math.cos(a); }
    const calmCols = calm ? Math.ceil(calmEnd / cw) : 0;
    for (let y = 0; y < rows; y++) {
      let s = "", begin = -1, gap = 0;
      const sy = shY[y], cy = chY[y];
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4, r = px[i], gr = px[i + 1], b = px[i + 2];
        let lum = (0.299 * r + 0.587 * gr + 0.114 * b) / 255;
        if (lum < 0.06) { if (begin >= 0) gap++; continue; }
        if (begin >= 0 && gap >= GAP) { runT[runs] = s; runX[runs] = begin; runY[runs] = y; runs++; begin = -1; }
        if (begin < 0) { begin = x; s = ""; gap = 0; }
        else if (gap) { s += " ".repeat(gap); gap = 0; }
        let f = 1.25;
        if (x < calmCols) {
          const xp = x * cw;
          if (xp < ox) f *= CALM_LEVEL;
          else { const k = (xp - ox) / CALM_BLEND; f *= CALM_LEVEL + (1 - CALM_LEVEL) * k * k * (3 - 2 * k); }
        }
        lum *= 0.92 + 0.08 * (shX[x] * cy + chX[x] * sy);   // slow shimmer, the art never sits still
        px[i] = r * f; px[i + 1] = gr * f; px[i + 2] = b * f;   // Uint8ClampedArray clamps
        s += GLYPH_LUT[(lum * LUT_N) | 0];
      }
      if (begin >= 0) { runT[runs] = s; runX[runs] = begin; runY[runs] = y; runs++; }
    }
    for (let n = 0; n < runs; n++) {
      const x = runX[n], y = runY[n], e = x + runT[n].length;
      if (x < minX) minX = x;
      if (e > maxX) maxX = e;
      if (y < minY) minY = y;
      if (y + 1 > maxY) maxY = y + 1;
    }
    sg.putImageData(id, 0, 0);

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, this.w, this.h);
    g.font = this.fontKey;
    g.textBaseline = "top";
    g.fillStyle = "#fff";
    const sx = this.sx;
    if (sx !== 1) g.setTransform(this.dpr * sx, 0, 0, this.dpr, 0, 0);
    for (let n = 0; n < runs; n++) g.fillText(runT[n], (runX[n] * cw) / sx, runY[n] * ch);
    if (sx !== 1) g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    runT.length = runs;
    // Colour every glyph with its cell's colour, only inside the box that holds glyphs (the operator
    // clears whatever it covers). The ground is the canvas's CSS background, not a third pass.
    if (runs) {
      const bx = minX * cw, by = minY * ch, bw = (maxX - minX) * cw + 2, bh = (maxY - minY) * ch + 2;
      g.save();
      g.beginPath();
      // Sparse frames (petals, stars): clip to the runs themselves; dense ones: one box.
      if (runs < 160 || bw * bh < this.w * this.h * 0.35) g.rect(bx, by, bw, bh);
      else for (let n = 0; n < runs; n++) g.rect(runX[n] * cw, runY[n] * ch, runT[n].length * cw + 1, ch + 1);
      g.clip();
      g.globalCompositeOperation = "source-in";
      g.imageSmoothingEnabled = false;
      g.drawImage(this.src, 0, 0, cols, rows, 0, 0, cols * cw, rows * ch);
      g.restore();
    }
    g.globalCompositeOperation = "source-over";
    if (this.mode === "horizon" && this.starOut.length) this.drawStars();
  }

  /** Twinkling stars of Event Horizon, in four brightness steps (four fill colours per frame). */
  private drawStars() {
    const { g, cw, ch, ox, sx, starOut: out } = this;
    if (sx !== 1) g.setTransform(this.dpr * sx, 0, 0, this.dpr, 0, 0);
    const calm = this.L.calm && ox > 0, calmEnd = ox + CALM_BLEND;
    const lumStar = (0.299 * STAR[0] + 0.587 * STAR[1] + 0.114 * STAR[2]) / 255;
    for (let step = 0; step < 4; step++) {
      const lo = 0.07 + step * 0.075, hi = lo + 0.075, mid = (lo + hi) / 2;
      let set = false;
      for (let n = 0; n < out.length; n += 3) {
        const x = out[n], y = out[n + 1], xp = x * cw;
        let I = out[n + 2];
        // behind the navigation the stars dim like the rest of the art, down to the faintest step
        if (calm && xp < calmEnd) {
          const k = xp < ox ? 0 : (xp - ox) / CALM_BLEND;
          I = Math.max(0.075, I * (CALM_LEVEL + (1 - CALM_LEVEL) * k * k * (3 - 2 * k)));
        }
        if (I < lo || (I >= hi && step < 3)) continue;
        if (!set) {
          const k = mid * 1.25;
          g.fillStyle = `rgb(${(STAR[0] * k) | 0},${(STAR[1] * k) | 0},${(STAR[2] * k) | 0})`;
          set = true;
        }
        g.fillText(GLYPH_LUT[(Math.min(1, I * lumStar) * LUT_N) | 0], (x * cw) / sx, y * ch);
      }
    }
    if (sx !== 1) g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  release() {
    this.canvas.style.backgroundColor = "";
    this.canvas.width = 0; this.canvas.height = 0;
    this.src.width = 0; this.src.height = 0;
    this.parts = [];
  }
}

// ---------------------------------------------------------------- shared loop, 30 fps or 20 fps
const live = new Set<Field>();
let raf = 0, last = 0;
let frameMs = FRAME_MS, avgMs = 0, ticks = 0;

/** Feed one tick's draw time into the running average and pick the frame rate. */
function adapt(cost: number) {
  avgMs = ticks < WARMUP ? (avgMs * ticks + cost) / (ticks + 1) : avgMs * 0.95 + cost * 0.05;
  ticks += 1;
  if (ticks < WARMUP) return;
  if (frameMs === FRAME_MS && avgMs > SLOW_AVG_MS) frameMs = SLOW_FRAME_MS;
  else if (frameMs === SLOW_FRAME_MS && avgMs < FAST_AVG_MS) frameMs = FRAME_MS;
}

function loop(now: number) {
  raf = 0;
  if (document.hidden || live.size === 0) return;
  if (now - last >= frameMs - 2) {
    last = now;
    const a = performance.now();
    let drawn = false;
    live.forEach((f) => { if (f.visible) { f.draw(now); drawn = true; } });
    if (drawn) adapt(performance.now() - a);
  }
  raf = requestAnimationFrame(loop);
}
function kick() {
  if (!raf && live.size && !document.hidden) raf = requestAnimationFrame(loop);
}
document.addEventListener("visibilitychange", kick);

export interface FieldHandle {
  stop(): void;
  /** Cards: pause while off screen. */
  setVisible(on: boolean): void;
  /** Average draw time per frame in ms and frames drawn so far (rough meter). */
  stats(): { avgMs: number; frames: number };
}

/** Start a premium field in `canvas`. "main" is the app backdrop (honours data-calm and the real
 *  dictation state), "card" the small shop and settings preview. */
export function startField(canvas: HTMLCanvasElement, mode: PremiumThemeId, kind: "main" | "card" = "main"): FieldHandle {
  const f = new Field(canvas, mode, kind === "card" ? CARD : MAIN);
  const release = mode === "horizon" && kind === "main" ? followDictation() : null;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let dead = false;
  const still = () => { if (!dead && f.visible) f.drawStill(); };
  const apply = () => {
    if (dead) return;
    if (motion.matches) { live.delete(f); still(); } else { live.add(f); kick(); }
  };
  const ro = new ResizeObserver(() => { if (motion.matches) still(); });
  const onImage = () => { if (motion.matches) still(); };
  pending.add(onImage);
  ro.observe(canvas);
  motion.addEventListener("change", apply);
  apply();
  // TESTCODE (2026-11-18): the cost meter on window.__spechyFieldStats for test pages, Vite dev only.
  if (import.meta.env.DEV) {
    const w = window as unknown as { __spechyFieldStats?: Record<string, () => { avgMs: number; frames: number; fps?: number }> };
    const stats = (w.__spechyFieldStats ??= {});
    stats[`${kind}:${mode}`] = () => ({ avgMs: f.cost.frames ? f.cost.ms / f.cost.frames : 0, frames: f.cost.frames });
    stats.loop = () => ({ avgMs, frames: ticks, fps: Math.round(1000 / frameMs) });
  }
  return {
    stop() {
      if (dead) return;
      dead = true;
      live.delete(f);
      pending.delete(onImage);
      ro.disconnect();
      motion.removeEventListener("change", apply);
      release?.();
      f.release();
    },
    setVisible(on: boolean) {
      if (f.visible === on) return;
      f.visible = on;
      if (on) { if (motion.matches) still(); else kick(); }
    },
    stats: () => ({ avgMs: f.cost.frames ? f.cost.ms / f.cost.frames : 0, frames: f.cost.frames }),
  };
}
