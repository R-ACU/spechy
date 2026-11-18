// Comet Keeper inside the Games stage (rules, controls and scoring: see the README block at
// the top of engine.ts). The canvas fills the stage, keys only reach the game while its
// panel has focus, and leaving the game destroys the loop, listeners and audio. A small
// volume control sits in the corner; the game remembers the value itself.
import { useEffect, useRef, useState } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { COMET_BEST_KEY, create, type CometKeeperGame } from "./engine";
import type { GameProps } from "../catalog";
import "../games.css";
import "./cometKeeper.css";

export default function CometKeeper({ onBest }: GameProps) {
  const panel = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<CometKeeperGame | null>(null);
  const best = useRef(onBest);
  best.current = onBest;
  const [volume, setVolume] = useState(0.8);
  const lastOn = useRef(0.8);

  useEffect(() => {
    const host = panel.current, cv = canvas.current;
    if (!host || !cv) return;
    const g = create(cv, {
      keyTarget: host,
      storageKey: COMET_BEST_KEY,
      onGameOver: (r) => { if (r.newBest) best.current(r.best); },
    });
    game.current = g;
    const v = g.isMuted() ? 0 : g.getVolume();
    setVolume(v);
    if (g.getVolume() > 0) lastOn.current = g.getVolume();
    // The game prevents default on pointerdown, which keeps the focus where it was;
    // take it explicitly so the keys keep working after a click on the board.
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
    <div
      ref={panel}
      className="ck"
      tabIndex={0}
      aria-label="Comet Keeper. Arrow keys or the mouse swing the shield, Space bashes, P pauses, M toggles sound."
    >
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
