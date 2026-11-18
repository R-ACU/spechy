// Pixel Tower inside the Games stage: the canvas fills the stage, keys only reach the game
// while its panel has focus, and leaving the game destroys the loop, listeners and audio.
// A small volume control sits in the corner (the game remembers the value itself).
import { useEffect, useRef, useState } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { create, type PixelTowerGame as Game } from "./pixelTower";
import { TOWER_BEST_KEY, type GameProps } from "./catalog";

export default function PixelTowerGame({ onBest }: GameProps) {
  const panel = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<Game | null>(null);
  const best = useRef(onBest);
  best.current = onBest;
  const [volume, setVolume] = useState(0.8);
  const lastOn = useRef(0.8);

  useEffect(() => {
    const host = panel.current, cv = canvas.current;
    if (!host || !cv) return;
    const g = create(cv, {
      keyTarget: host,
      storageKey: TOWER_BEST_KEY,
      // The stage is wide and short, so use finer pixels than the standalone version.
      shortSide: 240,
      onGameOver: (r) => best.current(r.best),
    });
    game.current = g;
    setVolume(g.getVolume());
    if (g.getVolume() > 0) lastOn.current = g.getVolume();
    // The game prevents default on pointerdown (no text selection), which also keeps the
    // focus where it was; take it explicitly so Space keeps working after a click on the board.
    const focus = (e: PointerEvent) => { if (e.target === cv) host.focus({ preventScroll: true }); };
    host.addEventListener("pointerdown", focus, true);
    host.focus({ preventScroll: true });
    return () => {
      host.removeEventListener("pointerdown", focus, true);
      g.destroy();
      game.current = null;
    };
  }, []);

  const apply = (v: number) => {
    setVolume(v);
    if (v > 0) lastOn.current = v;
    const g = game.current;
    if (!g) return;
    g.setVolume(v);
    if (v > 0 && g.isMuted()) g.setMuted(false);
  };

  const Icon = volume <= 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div ref={panel} className="gm-tower" tabIndex={0} aria-label="Pixel Tower. Press Space or click to drop the block, M toggles sound.">
      <canvas ref={canvas} />
      <div className="gm-vol" onKeyDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="gm-vol-btn"
          aria-label={volume > 0 ? "Mute sound" : "Turn sound on"}
          onClick={() => apply(volume > 0 ? 0 : lastOn.current || 0.8)}
        >
          <Icon size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <input
          className="gm-vol-range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          onChange={(e) => apply(Number(e.target.value) / 100)}
          aria-label="Sound volume"
          style={{ ["--fill" as string]: `${Math.round(volume * 100)}%` }}
        />
      </div>
    </div>
  );
}
