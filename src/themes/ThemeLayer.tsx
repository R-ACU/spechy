// Animated field for themes that have one (Halftone dots, ASCII glyphs, the premium themes). The
// canvas covers the whole window under the app layer; `.content`, navigation and title bar are
// transparent, and the navigation's width goes to the field as `data-calm`: the art runs on behind the
// navigation, dimmed there so the labels stay readable. Renders nothing for plain themes; the effect code is fetched with a dynamic import
// only while such a theme is active, so it lives in its own chunk (fieldBackdrop-*.js).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { loadBackdrop, themeById } from "./registry";
import { usePreviewTheme } from "./preview";

type Box = { left: number; top: number; width: number; height: number; radius: string; calm: number };

/** Follow the content panel's position and size, including when it appears later (after onboarding). */
function useContentBox(active: boolean): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    if (!active) { setBox(null); return; }
    let el: Element | null = null;
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (!el || !el.isConnected) el = document.querySelector(".content");
      if (!el) { setBox(null); return; }
      // The whole window, title bar and navigation included, so everything reads as one surface.
      // The navigation's width goes to the field as a calm zone (dimmed field behind the items).
      const c = el.getBoundingClientRect();
      const r = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const radius = "0";
      const calm = Math.round(c.left);
      setBox((b) => (b && b.left === r.left && b.top === r.top && b.width === r.width && b.height === r.height && b.radius === radius && b.calm === calm
        ? b : { left: r.left, top: r.top, width: r.width, height: r.height, radius, calm }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    const ro = new ResizeObserver(schedule);
    const watch = () => {
      const next = document.querySelector(".content");
      if (next && next !== el) { if (el) ro.unobserve(el); el = next; ro.observe(el); }
      schedule();
    };
    watch();
    // The panel can mount later (onboarding) or move when the sidebar collapses.
    const poll = window.setInterval(watch, 500);
    window.addEventListener("resize", schedule);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active]);
  return box;
}

export default function ThemeLayer({ theme: saved }: { theme: string }) {
  // A shop preview (premium/index.ts startThemePreview) wins over the saved theme while it runs.
  const theme = usePreviewTheme() ?? saved;
  const backdrop = themeById(theme)?.backdrop;
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useContentBox(!!backdrop);
  const ready = !!box;

  useEffect(() => {
    if (!backdrop || !ready) return;
    let stop: (() => void) | undefined;
    let dead = false;
    loadBackdrop(theme)
      .then((mod) => {
        if (!dead && mod && ref.current) stop = mod.start(ref.current);
      })
      .catch(() => { /* chunk failed to load: the theme still works without its field */ });
    return () => {
      dead = true;
      stop?.();
    };
    // Restart only when the effect kind changes, not on every theme id with the same effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backdrop, ready]);

  if (!backdrop || !box) return null;
  const style: CSSProperties = { left: box.left, top: box.top, width: box.width, height: box.height, borderRadius: box.radius };
  // Keyed by effect: the premium engine needs a context with alpha, the classic fields one without,
  // and a canvas keeps its first context for life.
  return <canvas key={backdrop} ref={ref} className="theme-backdrop" style={style} data-calm={box.calm} aria-hidden="true" />;
}
