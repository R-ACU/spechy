// Animated background field for the backdrop themes, drawn only inside the content panel
// (ThemeLayer sizes and places the canvas over `.content`; the navigation stays plain).
// Two looks from the owner's references:
//  - "glyph": a strict monospace grid of faint ASCII glyphs forming soft diagonal contour bands
//    that drift and bend, like the chat screen in the Nova post.
//  - "dot":   a halftone grid of round dots whose size follows a slowly flowing field,
//    like the dot-matrix pieces by Emil Kowalski and Charles Postiaux.
// Loaded with a dynamic import by registry.ts, so it costs nothing for other themes.
// Budget: capped at 30 fps, paused while hidden, one still frame for reduced motion, sprites are
// rendered once and blitted, only cells whose level changed are repainted, no per-frame allocations.

export type FieldMode = "glyph" | "dot";

interface Spec {
  cellW: number;
  cellH: number;
  levels: number;
  /** 0..1 field value at css position (x, y) and time t (seconds). */
  value: (x: number, y: number, t: number) => number;
  sprite: (g: CanvasRenderingContext2D, level: number, w: number, h: number, dpr: number, rgb: string) => void;
}

const FRAME_MS = 1000 / 30;
/** The navigation (left of `data-calm` css px) gets a weaker field; this many px blend it in. */
const CALM_LEVEL = 0.3;
const CALM_BLEND = 160;
const STILL_T = 40;
const RAMP = [" ", "·", ":", "-", "=", "+", "#"];
const GLYPH_ALPHA = [0, 0.10, 0.14, 0.18, 0.22, 0.26, 0.30];

const SPECS: Record<FieldMode, Spec> = {
  glyph: {
    cellW: 8,
    cellH: 12,
    levels: RAMP.length,
    value(x, y, t) {
      const band = Math.sin(
        x * 0.011 + y * 0.016
        + 1.8 * Math.sin(x * 0.0034 - t * 0.23)
        + 1.3 * Math.sin(y * 0.0052 + t * 0.19)
        - t * 0.85,
      );
      if (band <= 0.15) return 0;
      const ridge = (band - 0.15) / 0.85;
      const env = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(x * 0.0029 - y * 0.0021 + t * 0.12));
      return ridge * ridge * env;
    },
    sprite(g, level, w, h, dpr, rgb) {
      g.font = `500 ${Math.round(10 * dpr)}px "Cascadia Mono", "JetBrains Mono", Consolas, ui-monospace, monospace`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = `rgba(${rgb},${GLYPH_ALPHA[level]})`;
      g.fillText(RAMP[level], w / 2, h / 2);
    },
  },
  dot: {
    cellW: 9,
    cellH: 9,
    levels: 8,
    value(x, y, t) {
      const a = Math.sin(x * 0.0105 + 1.6 * Math.sin(y * 0.0085 + t * 0.33) + t * 0.5);
      const b = Math.cos(y * 0.0125 - 1.3 * Math.sin(x * 0.0068 - t * 0.27) - t * 0.38);
      const v = 0.5 + 0.5 * a * b;
      return v * v;
    },
    sprite(g, level, w, h, dpr, rgb) {
      const r = (0.5 + level * 0.32) * dpr;
      g.fillStyle = `rgba(${rgb},${0.08 + level * 0.03})`;
      g.beginPath();
      g.arc(w / 2, h / 2, r, 0, Math.PI * 2);
      g.fill();
    },
  },
};

export function start(canvas: HTMLCanvasElement, mode: FieldMode): () => void {
  const spec = SPECS[mode];
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return () => {};
  const atlas = document.createElement("canvas");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let dpr = 1, cw = spec.cellW, ch = spec.cellH, cols = 0, rows = 0, panel = "#0e0e0e";
  let levels = new Uint8Array(0);
  let raf = 0, last = 0, dead = false;

  function readColours(): string {
    const css = getComputedStyle(document.documentElement);
    panel = css.getPropertyValue("--skin-panel").trim() || css.getPropertyValue("--bg").trim() || "#0e0e0e";
    return (css.getPropertyValue("--skin-glyph").trim() || "220 220 220").split(/[\s,]+/).join(",");
  }

  function buildAtlas() {
    const rgb = readColours();
    atlas.width = cw * spec.levels;
    atlas.height = ch;
    const a = atlas.getContext("2d");
    if (!a) return;
    a.clearRect(0, 0, atlas.width, atlas.height);
    for (let i = 1; i < spec.levels; i++) {
      a.save();
      a.translate(i * cw, 0);
      spec.sprite(a, i, cw, ch, dpr, rgb);
      a.restore();
    }
  }

  function resize() {
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    cw = Math.round(spec.cellW * dpr);
    ch = Math.round(spec.cellH * dpr);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    cols = Math.ceil(w / cw);
    rows = Math.ceil(h / ch);
    levels = new Uint8Array(cols * rows);
    buildAtlas();
    ctx!.fillStyle = panel;
    ctx!.fillRect(0, 0, w, h);
  }

  function draw(t: number) {
    const top = spec.levels - 1;
    const calm = Number(canvas.dataset.calm) || 0, calmEnd = calm + CALM_BLEND;
    let i = 0;
    for (let cy = 0; cy < rows; cy++) {
      const y = cy * spec.cellH, py = cy * ch;
      for (let cx = 0; cx < cols; cx++, i++) {
        const x = cx * spec.cellW;
        let v = spec.value(x, y, t);
        if (x < calmEnd) {
          if (x < calm) v *= CALM_LEVEL;
          else { const k = (x - calm) / CALM_BLEND; v *= CALM_LEVEL + (1 - CALM_LEVEL) * k * k * (3 - 2 * k); }
        }
        let lvl = (v * spec.levels) | 0;
        if (lvl > top) lvl = top;
        if (lvl === levels[i]) continue;
        levels[i] = lvl;
        const px = cx * cw;
        ctx!.fillStyle = panel;
        ctx!.fillRect(px, py, cw, ch);
        if (lvl) ctx!.drawImage(atlas, lvl * cw, 0, cw, ch, px, py, cw, ch);
      }
    }
  }

  function frame(now: number) {
    raf = 0;
    if (dead || document.hidden) return;
    if (now - last >= FRAME_MS - 2) {
      last = now;
      draw(now / 1000);
    }
    raf = requestAnimationFrame(frame);
  }

  function run() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (dead) return;
    if (motion.matches) { draw(STILL_T); return; }
    if (!document.hidden) raf = requestAnimationFrame(frame);
  }

  const ro = new ResizeObserver(() => {
    resize();
    draw(motion.matches ? STILL_T : performance.now() / 1000);
  });
  // Theme tokens can change under a running backdrop (e.g. while the switch veil is up).
  const mo = new MutationObserver(() => { resize(); draw(motion.matches ? STILL_T : performance.now() / 1000); });

  resize();
  draw(motion.matches ? STILL_T : performance.now() / 1000);
  run();
  ro.observe(canvas);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-skin"] });
  document.addEventListener("visibilitychange", run);
  motion.addEventListener("change", run);

  return () => {
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    mo.disconnect();
    document.removeEventListener("visibilitychange", run);
    motion.removeEventListener("change", run);
    canvas.width = 0;
    canvas.height = 0;
    atlas.width = 0;
    atlas.height = 0;
    levels = new Uint8Array(0);
  };
}
