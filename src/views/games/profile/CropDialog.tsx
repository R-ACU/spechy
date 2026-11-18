// Crops a picked image to a square (shown as a circle) and returns a 256 x 256 PNG.
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button, Dialog } from "../../../components/ui";

const VIEW = 264;
const OUT = 256;

export default function CropDialog({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (bytes: Uint8Array) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const url = URL.createObjectURL(file);
    setSrc(url);
    const i = new Image();
    i.onload = () => { if (alive) setImg(i); };
    i.onerror = () => { if (alive) setBad(true); };
    i.src = url;
    return () => {
      alive = false;
      // Revoking while the image still loads fails that request (StrictMode remount): wait for it.
      const revoke = () => URL.revokeObjectURL(url);
      if (i.complete) revoke(); else { i.onload = revoke; i.onerror = revoke; }
    };
  }, [file]);

  const base = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = base * zoom;
  const w = img ? img.naturalWidth * scale : VIEW;
  const h = img ? img.naturalHeight * scale : VIEW;
  const clamp = (x: number, y: number) => ({ x: Math.min(0, Math.max(VIEW - w, x)), y: Math.min(0, Math.max(VIEW - h, y)) });

  // Centre the picture on load and keep it covering the circle when zooming.
  useEffect(() => {
    if (!img) return;
    setPos((p) => (p.x === 0 && p.y === 0 && zoom === 1 ? { x: (VIEW - w) / 2, y: (VIEW - h) / 2 } : clamp(p.x, p.y)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, zoom]);

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) setPos(clamp(d.ox + e.clientX - d.px, d.oy + e.clientY - d.py));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = 12;
    const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    setPos((p) => clamp(p.x + d[0], p.y + d[1]));
  };

  const save = () => {
    if (!img) return;
    setBusy(true);
    const c = document.createElement("canvas");
    c.width = c.height = OUT;
    const g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, -pos.x / scale, -pos.y / scale, VIEW / scale, VIEW / scale, 0, 0, OUT, OUT);
    c.toBlob(async (b) => {
      if (!b) { setBusy(false); setBad(true); return; }
      onDone(new Uint8Array(await b.arrayBuffer()));
    }, "image/png");
  };

  return (
    <Dialog title="Crop your picture" onClose={onCancel} width={360}>
      <div className="pf-crop">
        {bad ? (
          <p className="pf-crop-err">This file could not be read as an image.</p>
        ) : (
          <>
            <div
              className="pf-crop-view"
              style={{ width: VIEW, height: VIEW }}
              tabIndex={0}
              role="group"
              aria-label="Drag to move the picture, arrow keys also work"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={() => { drag.current = null; }}
              onKeyDown={onKey}
            >
              {src && img && <img src={src} alt="" draggable={false} style={{ width: w, height: h, transform: `translate(${pos.x}px, ${pos.y}px)` }} />}
              <span className="pf-crop-ring" aria-hidden="true" />
            </div>
            <label className="pf-crop-zoom">
              <span>Zoom</span>
              <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            </label>
          </>
        )}
        <div className="pf-crop-actions">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={save} disabled={!img || busy || bad}><Check size={16} aria-hidden="true" />Use picture</Button>
        </div>
      </div>
    </Dialog>
  );
}
