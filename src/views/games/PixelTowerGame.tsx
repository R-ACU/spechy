// Pixel Tower inside the Games stage: the canvas fills the stage, keys only reach the game
// while its panel has focus, and leaving the game destroys the loop, listeners and audio.
// The sound button and volume popover live in the shared play header (Games.tsx, SoundMenu.tsx);
// the game remembers volume and mute itself. Every finished round, and a round left while
// still running, goes to `onRoundEnd` for the coin award.
import { useEffect, useRef } from "react";
import { create, type PixelTowerGame as Game } from "./pixelTower";
import { TOWER_BEST_KEY, type GameProps } from "./catalog";
import { useGameSound } from "./useGameSound";
import { skinFor, withEquippedSkin, type TowerSkin } from "./shop/gameSkins";

export default function PixelTowerGame({ onBest, onSound, onRoundEnd }: GameProps) {
  const panel = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<Game | null>(null);
  const best = useRef(onBest);
  best.current = onBest;
  const roundEnd = useRef(onRoundEnd);
  roundEnd.current = onRoundEnd;
  const syncSound = useGameSound(game, onSound);

  useEffect(() => {
    const host = panel.current, cv = canvas.current;
    if (!host || !cv) return;
    const run = (skin: TowerSkin) => {
      const g = create(cv, {
        keyTarget: host,
        storageKey: TOWER_BEST_KEY,
        // The stage is wide and short, so use finer pixels than the standalone version.
        shortSide: 240,
        // The app's results card replaces the game's own game over UI.
        appResults: true,
        skin,
        onGameOver: (r) => {
          best.current(r.best);
          roundEnd.current?.({ score: r.score, newBest: r.newBest, quit: false });
        },
      });
      game.current = g;
      syncSound();
      // The game prevents default on pointerdown (no text selection), which also keeps the
      // focus where it was; take it explicitly so Space keeps working after a click on the board.
      const focus = (e: PointerEvent) => { if (e.target === cv) host.focus({ preventScroll: true }); };
      // M toggles the sound inside the game; mirror it in the header.
      const onKey = (e: KeyboardEvent) => { if (e.key === "m" || e.key === "M") window.setTimeout(syncSound, 0); };
      host.addEventListener("pointerdown", focus, true);
      host.addEventListener("keydown", onKey);
      host.focus({ preventScroll: true });
      return () => {
        host.removeEventListener("pointerdown", focus, true);
        host.removeEventListener("keydown", onKey);
        // Leaving mid round still pays what the round earned so far.
        const s = g.getState();
        if ((s.state === "play" || s.state === "dying") && s.score > 0) roundEnd.current?.({ score: s.score, newBest: false, quit: true });
        g.destroy();
        game.current = null;
      };
    };
    // The equipped skin is read once when the game starts; a change on the hub applies next round.
    let stop = () => {};
    const cancel = withEquippedSkin("tower-skin", (e) => skinFor("tower-skin", e), (skin) => { stop = run(skin); });
    return () => { cancel(); stop(); };
  }, [syncSound]);

  return (
    <div ref={panel} className="gm-tower" tabIndex={0} aria-label="Pixel Tower. Press Space or click to drop the block, M toggles sound.">
      <canvas ref={canvas} />
    </div>
  );
}
