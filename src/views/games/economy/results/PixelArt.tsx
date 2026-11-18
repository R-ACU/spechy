// A tiny canvas painted once at low resolution and shown upscaled with crisp pixels.
// Game art: fixed colours are allowed here.
import { useEffect, useRef, type CSSProperties } from "react";

export type Paint = (g: CanvasRenderingContext2D, rect: (x: number, y: number, w: number, h: number, c: string) => void) => void;

export function PixelArt({ w, h, scale, paint, className = "", style }: {
  w: number; h: number; scale: number; paint: Paint; className?: string; style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const g = cv?.getContext("2d");
    if (!cv || !g) return;
    g.clearRect(0, 0, w, h);
    paint(g, (x, y, rw, rh, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), rw, rh); });
  }, [w, h, paint]);
  return (
    <canvas
      ref={ref}
      width={w}
      height={h}
      className={`gr-pixel ${className}`}
      style={{ width: w * scale, height: h * scale, ...style }}
      aria-hidden="true"
    />
  );
}
