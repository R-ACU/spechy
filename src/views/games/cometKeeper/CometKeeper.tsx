// Comet Keeper inside the Games stage (rules, controls and scoring: see the README block at
// the top of engine.ts). The canvas fills the stage, keys only reach the game while its
// panel has focus, and leaving the game destroys the loop, listeners and audio. The sound
// popover lives in the shared play header (Games.tsx, SoundMenu.tsx); the game remembers
// volume and mute itself. Finished and left rounds go to `onRoundEnd` for the coin award.
import { useEffect, useRef } from "react";
import { COMET_BEST_KEY, create, type CometKeeperGame } from "./engine";
import type { GameProps } from "../catalog";
import { useGameSound } from "../useGameSound";
import { skinFor, withEquippedSkin, type CometSkinId } from "../shop/gameSkins";
import "../games.css";
import "./cometKeeper.css";

export default function CometKeeper({ onBest, onSound, onRoundEnd }: GameProps) {
  const panel = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<CometKeeperGame | null>(null);
  const best = useRef(onBest);
  best.current = onBest;
  const roundEnd = useRef(onRoundEnd);
  roundEnd.current = onRoundEnd;
  const syncSound = useGameSound(game, onSound);

  useEffect(() => {
    const host = panel.current, cv = canvas.current;
    if (!host || !cv) return;
    const run = (skin: CometSkinId) => {
      const g = create(cv, {
        keyTarget: host,
        storageKey: COMET_BEST_KEY,
        skin,
        onGameOver: (r) => {
          if (r.newBest) best.current(r.best);
          roundEnd.current?.({ score: r.score, newBest: r.newBest, quit: false });
        },
      });
      game.current = g;
      syncSound();
      // The game prevents default on pointerdown, which keeps the focus where it was;
      // take it explicitly so the keys keep working after a click on the board.
      const focus = (e: PointerEvent) => { if (e.target === cv) host.focus({ preventScroll: true }); };
      // M toggles the sound inside the game; mirror it in the header.
      const onKey = (e: KeyboardEvent) => { if (e.key === "m" || e.key === "M") window.setTimeout(syncSound, 0); };
      host.addEventListener("pointerdown", focus, true);
      host.addEventListener("keydown", onKey);
      host.focus({ preventScroll: true });
      return () => {
        host.removeEventListener("pointerdown", focus, true);
        host.removeEventListener("keydown", onKey);
        // Leaving mid round (also paused) still pays what the round earned so far.
        const s = g.getState();
        if ((s.state === "play" || s.state === "paused" || s.state === "dying") && s.score > 0) {
          roundEnd.current?.({ score: s.score, newBest: false, quit: true });
        }
        g.destroy();
        game.current = null;
      };
    };
    // The equipped skin is read once when the game starts; a change on the hub applies next round.
    let stop = () => {};
    const cancel = withEquippedSkin("comet-skin", (e) => skinFor("comet-skin", e), (skin) => { stop = run(skin); });
    return () => { cancel(); stop(); };
  }, [syncSound]);

  return (
    <div
      ref={panel}
      className="ck"
      tabIndex={0}
      aria-label="Comet Keeper. Arrow keys or the mouse swing the shield, Space bashes, P pauses, M toggles sound."
    >
      <canvas ref={canvas} />
    </div>
  );
}
