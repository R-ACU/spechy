// Server of the leaderboard join scene (design: variant B of the join view mockup). Four
// wireframe boxes stacked on each other, drawn with depth towards the upper right (front, right
// side, top face of the top box), edges in the text colour. Each box has a slot line and two
// lights. Above the top face the official Cloudflare logo turns as a thick extruded coin on a
// canvas, lingers while it faces you and casts a flat shadow on the top face.
//
// Phases come from JoinView: sending lets the boxes light up bottom to top in the accent colour
// with a soft glow and blinking lights while the logo spins faster; success sweeps them into the
// success colour and shows the check; failed blinks the lights red. Reduced motion: static,
// front-facing logo, states switch without animation. The loop only runs while the scene is on
// screen. Line colours are tokens; the logo's side wall shades are illustration art.
import { useEffect, useId, useRef } from "react";
import { Check } from "lucide-react";
import cloudflareLogo from "./assets/cloudflare.svg";
import "./serverRack.css";

export type RackPhase = "idle" | "sending" | "success" | "failed" | "soon";

// stack geometry (svg units = css px)
const BOXES = 4;
const W = 94, H = 26, DX = 20, DY = -12, X = 6, TOP = 6 - DY;
const VW = X + W + DX + 6, VH = TOP + BOXES * H + 6;

// logo
const HALF_TURN_S = 4.2;    // one half turn (front to front) at rest
const FAST = 4.2;           // speed factor while sending
const CROP_Y = 6.4, CROP_H = 11.2, ASPECT = CROP_H / 24; // the mark's band in the 24 x 24 view box
const RES = 12;             // sprite px per view box unit
const LOGO_L = 66;          // drawn logo width in css px
// The extruded side wall in six light levels: dark while it hides, brighter as it turns to you.
const EDGE_SHADES = ["#5e2a07", "#70330a", "#823d0c", "#94470e", "#a65110", "#b85b12"];

type Sprites = { face: HTMLCanvasElement; edge: HTMLCanvasElement[]; shade: HTMLCanvasElement };
let spritesP: Promise<Sprites> | null = null;
function loadSprites(): Promise<Sprites> {
  if (spritesP) return spritesP;
  spritesP = new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const make = (color: string | null) => {
        const c = document.createElement("canvas");
        c.width = 24 * RES; c.height = Math.ceil(CROP_H * RES);
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, -CROP_Y * RES, 24 * RES, 24 * RES);
        if (color) { g.globalCompositeOperation = "source-in"; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height); }
        return c;
      };
      res({ face: make(null), edge: EDGE_SHADES.map(make), shade: make("#000") });
    };
    img.onerror = () => { spritesP = null; rej(new Error("logo")); };
    img.src = cloudflareLogo;
  });
  return spritesP;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const reducedQuery = () => window.matchMedia?.("(prefers-reduced-motion: reduce)");

type Box = { g: SVGGElement; leds: SVGCircleElement[]; cls: string; ledCls: string[] };

function buildStack(svg: SVGSVGElement, filterId: string): Box[] {
  const NS = "http://www.w3.org/2000/svg";
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    parent.appendChild(e);
    return e;
  };
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  // the glow: the blurred stroke in its own colour under the sharp stroke (no gradient)
  const filter = el("filter", { id: filterId, x: "-40%", y: "-60%", width: "180%", height: "220%", "color-interpolation-filters": "sRGB" }, el("defs", {}, svg));
  el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 2.6, result: "b" }, filter);
  const merge = el("feMerge", {}, filter);
  el("feMergeNode", { in: "b" }, merge);
  el("feMergeNode", { in: "SourceGraphic" }, merge);

  const boxes: Box[] = [];
  for (let i = 0; i < BOXES; i++) {           // index 0 is the bottom box
    const y = TOP + (BOXES - 1 - i) * H, r = X + W;
    const g = el("g", { class: "lb-box" }, svg);
    let d = `M${X} ${y}H${r}V${y + H}H${X}Z M${r} ${y}l${DX} ${DY}v${H}l${-DX} ${-DY}`;
    if (i === BOXES - 1) d += ` M${X} ${y}l${DX} ${DY}H${r + DX}`;
    el("path", { d }, g);
    el("path", { d: `M${X + 11} ${y + H / 2}h28` }, g);
    const leds = [0, 1].map((j) => el("circle", { class: "lb-box-led", cx: r - 22 + j * 10, cy: y + H / 2, r: 2.6 }, g));
    boxes.push({ g, leds, cls: "lb-box", ledCls: ["lb-box-led", "lb-box-led"] });
  }
  return boxes;
}

export default function ServerRack({ phase }: { phase: RackPhase }) {
  const filterId = `lb-glow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef<{ phase: RackPhase; since: number }>({ phase, since: 0 });
  const kick = useRef<() => void>(() => {});

  // a new phase restarts its timeline and wakes the loop (or redraws once under reduced motion)
  useEffect(() => {
    if (phaseRef.current.phase === phase && phaseRef.current.since) return;
    phaseRef.current = { phase, since: performance.now() };
    kick.current();
  }, [phase]);

  useEffect(() => {
    const svg = svgRef.current, canvas = canvasRef.current;
    if (!svg || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const boxes = buildStack(svg, filterId);
    const mq = reducedQuery();
    let rm = !!mq?.matches;
    let sprites: Sprites | null = null;
    let visible = true;
    let raf = 0, last = 0;
    let turn = 0, speed = 1;
    let shadow = "rgba(0,0,0,.5)", shadowAge = Infinity;
    if (!phaseRef.current.since) phaseRef.current.since = performance.now();

    const drawBoxes = (now: number) => {
      const { phase: p, since } = phaseRef.current;
      const e = now - since;
      boxes.forEach((b, i) => {
        let color = "", glow = false;
        const led = ["", ""];
        if (p === "idle") {
          // calm: one light per box breathes now and then
          const k = ((now + i * 410) % 3200) / 3200;
          if (!rm && k > 0.78 && k < 0.9) led[1] = "soft";
        } else if (p === "sending") {
          if (rm) { color = "acc"; led[0] = "on"; }
          else {
            // climb: boxes light bottom to top and stay lit, then all go dark and it climbs again
            const c = e % 1600;
            if (c >= i * 260 && c < 1240) {
              color = "acc"; glow = true;
              led[0] = Math.floor(e / 110 + i * 1.7) % 3 ? "on" : "";
              led[1] = Math.floor(e / 140 + i * 2.3 + 1) % 3 ? "on" : "";
            }
          }
        } else if (p === "success") {
          // quick sweep in the success colour, the glow fades, the lights stay on
          const on = rm || e >= i * 70;
          if (on && (rm || e < 900)) { color = "ok"; glow = !rm; }
          if (on) led[0] = led[1] = "ok";
        } else if (p === "failed") {
          if (rm || e < 1200) led[0] = led[1] = rm || Math.floor(e / 200) % 2 === 0 ? "bad" : "";
        }
        const cls = "lb-box" + (color ? ` is-${color}` : "") + (glow ? " is-glow" : "");
        if (cls !== b.cls) {
          b.cls = cls;
          b.g.setAttribute("class", cls);
          if (glow) b.g.setAttribute("filter", `url(#${filterId})`); else b.g.removeAttribute("filter");
        }
        b.leds.forEach((l, j) => {
          const lc = "lb-box-led" + (led[j] ? ` is-${led[j]}` : "");
          if (lc !== b.ledCls[j]) { b.ledCls[j] = lc; l.setAttribute("class", lc); }
        });
      });
      // a lit box draws above its neighbours, so shared edges show its colour
      const lit = (b: Box) => b.cls.includes("is-");
      const order = boxes.filter((b) => !lit(b)).concat(boxes.filter(lit));
      const cur = Array.from(svg.querySelectorAll(":scope > g"));
      if (order.some((b, i) => cur[i] !== b.g)) order.forEach((b) => svg.appendChild(b.g));
    };

    const drawLogo = (now: number) => {
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (!cw || !ch) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      if (!sprites) return;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      // the shadow colour follows the theme (resolved css colour of the canvas)
      if (now - shadowAge > 500 || shadowAge === Infinity) { shadow = getComputedStyle(canvas).color; shadowAge = now; }

      // A thick coin turning about the vertical axis. Eased half turns linger while the face looks
      // at you; both sides carry the same unmirrored mark.
      let phi = 0;
      if (!rm) {
        const f = turn - Math.floor(turn);
        phi = (f - (Math.sin(2 * Math.PI * f) / (2 * Math.PI)) * 0.9) * Math.PI;
      }
      const Lh = LOGO_L * ASPECT, cx = cw / 2, cy = 24, depth = LOGO_L * 0.13;
      const c = Math.cos(phi), s = Math.sin(phi);
      const sx = Math.max(0.025, Math.abs(c)), w = LOGO_L * sx;
      const frontX = cx + (depth / 2) * s, backX = cx - (depth / 2) * s;
      const nearX = c >= 0 ? frontX : backX, farX = c >= 0 ? backX : frontX;

      // flat shadow on the top face, as wide as the footprint
      const foot = w + depth * Math.abs(s);
      ctx.fillStyle = shadow;
      ctx.beginPath(); ctx.ellipse(cx, ch - 7, Math.max(6, foot * 0.42), 3.2, 0, 0, Math.PI * 2); ctx.fill();

      // the side wall: copies of the mark from the far face to the near one, half a pixel apart
      const n = Math.max(2, Math.ceil(Math.abs(nearX - farX) * 2.5));
      const side = sprites.edge[Math.min(5, Math.round(Math.abs(s) * 5))];
      for (let i = 0; i <= n; i++) ctx.drawImage(side, lerp(farX, nearX, i / n) - w / 2, cy - Lh / 2, w, Lh);
      // the face: full brand orange head on, a little darker as it turns away
      ctx.drawImage(sprites.face, nearX - w / 2, cy - Lh / 2, w, Lh);
      const dark = (1 - sx) * 0.42;
      if (dark > 0.01) { ctx.globalAlpha = dark; ctx.drawImage(sprites.shade, nearX - w / 2, cy - Lh / 2, w, Lh); ctx.globalAlpha = 1; }
    };

    const draw = (now: number) => { drawBoxes(now); drawLogo(now); };

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(50, last ? now - last : 16);
      last = now;
      const { phase: p, since } = phaseRef.current;
      const e = now - since;
      // the logo spins faster while sending and in the first moment of success
      const target = p === "sending" || (p === "success" && e < 500) ? FAST : 1;
      speed = lerp(speed, target, clamp01(dt / (target > speed ? 260 : 700)));
      turn += (dt / 1000 / HALF_TURN_S) * speed;
      draw(now);
      if (visible && !rm) raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf) return;
      if (rm || !visible) { draw(performance.now()); return; }
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    kick.current = () => { if (rm || !visible) draw(performance.now()); else start(); };

    const io = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          visible = entries.some((en) => en.isIntersecting);
          if (visible) start(); else stop();
        })
      : null;
    io?.observe(canvas.parentElement ?? canvas);
    const onMq = () => { rm = !!mq?.matches; stop(); start(); };
    mq?.addEventListener?.("change", onMq);

    let live = true;
    void loadSprites().then((sp) => { if (!live) return; sprites = sp; draw(performance.now()); }, () => {});
    start();
    return () => {
      live = false;
      stop();
      io?.disconnect();
      mq?.removeEventListener?.("change", onMq);
      kick.current = () => {};
    };
  }, [filterId]);

  return (
    <div className="lb-srv" data-phase={phase}>
      <canvas ref={canvasRef} className="lb-cf3d" role="img" aria-label="Cloudflare" />
      <svg
        ref={svgRef}
        className="lb-stack"
        viewBox={`0 0 ${VW} ${VH}`}
        width={VW}
        height={VH}
        aria-hidden="true"
        focusable="false"
      />
      <span className="lb-ok" aria-hidden="true"><Check size={18} strokeWidth={3} /></span>
    </div>
  );
}
