// Sound state of a canvas game (Pixel Tower, Comet Keeper) for the play header: mute and
// volume come from the game, which persists them under `<best key>.muted` and `.volume`.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { SoundControl } from "./catalog";

export interface SoundEngine {
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  getVolume(): number;
  setVolume(volume: number): void;
}

/** Publishes the game's SoundControl through `onSound`; returns `sync` to re-read the game
 *  (call it after the game is created and after its own M shortcut). */
export function useGameSound(game: RefObject<SoundEngine | null>, onSound?: (c: SoundControl | null) => void): () => void {
  const [s, setS] = useState({ muted: false, volume: 0.8 });
  const sync = useCallback(() => {
    const g = game.current;
    if (g) setS({ muted: g.isMuted(), volume: g.getVolume() });
  }, [game]);
  const ops = useRef({
    setMuted: (m: boolean) => {
      const g = game.current;
      if (!g) return;
      g.setMuted(m);
      // An old "off" was stored as volume 0: unmuting brings the sound back audibly.
      if (!m && g.getVolume() <= 0) g.setVolume(0.8);
      sync();
    },
    setVolume: (v: number) => {
      const g = game.current;
      if (!g) return;
      g.setVolume(v);
      if (v > 0 && g.isMuted()) g.setMuted(false);
      sync();
    },
  });

  useEffect(() => {
    const on = !s.muted && s.volume > 0;
    onSound?.({
      on,
      muted: s.muted || s.volume <= 0,
      volume: s.volume,
      toggle: () => ops.current.setMuted(on),
      setMuted: (m) => ops.current.setMuted(m),
      setVolume: (v) => ops.current.setVolume(v),
    });
  }, [s, onSound]);
  useEffect(() => () => onSound?.(null), [onSound]);
  return sync;
}
