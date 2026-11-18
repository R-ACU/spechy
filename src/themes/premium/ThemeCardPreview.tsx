// Small live preview of a premium theme for shop and settings cards. Fills its parent (give the
// parent a size), loads the field engine lazily and pauses while the card is off screen.
import { useEffect, useRef } from "react";
import { premiumById } from "./catalog";
import type { FieldHandle } from "./engine";

export default function ThemeCardPreview({ id, className }: { id: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const theme = premiumById(id);
    const canvas = ref.current;
    if (!theme || !canvas) return;
    let handle: FieldHandle | null = null;
    let dead = false;
    let visible = false;
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      handle?.setVisible(visible);
    }, { rootMargin: "48px" });
    io.observe(canvas);
    import("./engine")
      .then((m) => {
        if (dead || !ref.current) return;
        handle = m.startField(ref.current, theme.id, "card");
        handle.setVisible(visible);
      })
      .catch(() => { /* chunk failed: the card just stays dark */ });
    return () => {
      dead = true;
      io.disconnect();
      handle?.stop();
    };
  }, [id]);

  return <canvas ref={ref} className={className ? `th-card-canvas ${className}` : "th-card-canvas"} aria-hidden="true" />;
}
