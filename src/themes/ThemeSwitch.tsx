// The short loading moment when a theme is picked (about 780 ms):
//   0 ms    a veil in the current theme's colours fades in, the theme name starts as scrambled glyphs
//   200 ms  (and once the theme's chunk is loaded) the theme swaps underneath the opaque veil
//   530 ms  the name has resolved, the veil fades out and dissolves into the new theme
// The veil freezes the old tokens on itself, so its own colours never change mid way (no contrast dip,
// no strobe); the only colour of the new theme on it is the progress fill in the new accent.
// Opacity and transform only, all ease-out. Reduced motion: instant switch.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { loadBackdrop, themeById } from "./registry";

const T_SWAP = 200;
const T_OUT = 530;
const T_DONE = 780;
const MAX_LOAD_WAIT = 900;
const SCRAMBLE = "#=+-:*/<>_\\%";
const BAR_CELLS = 18;

type Phase = "mount" | "in" | "swap" | "out";
type Frozen = Record<"--bg" | "--text" | "--text-3" | "--accent", string>;

/** Current tokens, plus the accent of the theme being picked (read from its preview card). */
function freezeColours(id: string): Frozen {
  const css = getComputedStyle(document.documentElement);
  const get = (s: CSSStyleDeclaration, k: string) => s.getPropertyValue(k).trim();
  const preview = document.querySelector(`.th-preview[data-skin="${id}"]`);
  const accent = preview ? get(getComputedStyle(preview), "--accent") : "";
  return { "--bg": get(css, "--bg"), "--text": get(css, "--text"), "--text-3": get(css, "--text-3"), "--accent": accent || get(css, "--accent") };
}

function wait(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Returns a switch function plus the overlay to render. `apply` writes the setting. */
export function useThemeSwitch(apply: (id: string) => void) {
  const [run, setRun] = useState<{ id: string; name: string; phase: Phase; started: number; colours: Frozen } | null>(null);
  const pending = useRef<string | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const token = useRef(0);

  const commit = useCallback(() => {
    if (pending.current === null) return;
    const id = pending.current;
    pending.current = null;
    applyRef.current(id);
  }, []);

  const switchTo = useCallback(async (id: string) => {
    const preload = loadBackdrop(id).catch(() => null);
    if (reducedMotion()) {
      token.current += 1;
      pending.current = null;
      setRun(null);
      applyRef.current(id);
      return;
    }
    // A newer pick wins over a running one; its veil simply continues.
    const my = ++token.current;
    pending.current = id;
    const name = themeById(id)?.name ?? id;
    const started = performance.now();
    const fresh = freezeColours(id);
    // A pick during a running switch keeps the veil's colours, which are still the ones on screen.
    setRun((r) => ({ id, name, phase: r ? "in" : "mount", started, colours: r ? { ...r.colours, "--accent": fresh["--accent"] } : fresh }));
    requestAnimationFrame(() => {
      if (token.current === my) setRun((r) => (r && r.phase === "mount" ? { ...r, phase: "in" } : r));
    });
    await Promise.all([wait(T_SWAP), Promise.race([preload, wait(MAX_LOAD_WAIT)])]);
    if (token.current !== my) return;
    commit();
    setRun((r) => (r ? { ...r, phase: "swap" } : r));
    const elapsed = performance.now() - started;
    await wait(Math.max(0, T_OUT - elapsed));
    if (token.current !== my) return;
    setRun((r) => (r ? { ...r, phase: "out" } : r));
    await wait(T_DONE - T_OUT);
    if (token.current !== my) return;
    setRun(null);
  }, [commit]);

  // Leaving the page mid switch must still apply the pick.
  useEffect(() => () => { token.current += 1; commit(); }, [commit]);

  const overlay = run ? createPortal(<SwitchVeil key="veil" name={run.name} phase={run.phase} started={run.started} colours={run.colours} />, document.body) : null;
  return { switchTo, overlay, busy: !!run };
}

function SwitchVeil({ name, phase, started, colours }: { name: string; phase: Phase; started: number; colours: Frozen }) {
  const doneRef = useRef<HTMLSpanElement>(null);
  const scrRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const restRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let lastScramble = -1;
    let seed = (started * 1000) | 0;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) | 0;
      return ((seed >>> 8) & 0xffff) / 0x10000;
    };
    const text = name.toUpperCase();
    // Characters resolve left to right between 110 ms and about 480 ms, like a reading band.
    const step = Math.min(45, 370 / Math.max(1, text.length));
    const tick = () => {
      const t = performance.now() - started;
      const resolved = Math.max(0, Math.min(text.length, Math.floor((t - 110) / step)));
      if (doneRef.current) doneRef.current.textContent = text.slice(0, resolved);
      // Scrambled glyphs change at about 16 Hz, slow enough to read as texture and not as blinking.
      const slot = Math.floor(t / 60);
      if (scrRef.current && slot !== lastScramble) {
        lastScramble = slot;
        let s = "";
        for (let i = resolved; i < text.length; i++) s += text[i] === " " ? " " : SCRAMBLE[(rand() * SCRAMBLE.length) | 0];
        scrRef.current.textContent = s;
      } else if (scrRef.current && scrRef.current.textContent!.length !== text.length - resolved) {
        scrRef.current.textContent = scrRef.current.textContent!.slice(scrRef.current.textContent!.length - (text.length - resolved));
      }
      const filled = Math.round(Math.min(1, t / T_OUT) * BAR_CELLS);
      if (fillRef.current) fillRef.current.textContent = "#".repeat(filled);
      if (restRef.current) restRef.current.textContent = ":".repeat(BAR_CELLS - filled);
      if (t < T_DONE) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [name, started]);

  return (
    <div className={`tsw ${phase}`} style={colours as CSSProperties} aria-hidden="true">
      <div className="tsw-box">
        <div className="tsw-label">Loading theme</div>
        <div className="tsw-name"><span ref={doneRef} /><span ref={scrRef} className="tsw-scr" /></div>
        <div className="tsw-bar">[<span ref={fillRef} className="tsw-fill" /><span ref={restRef} />]</div>
      </div>
    </div>
  );
}
