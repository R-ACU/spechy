// The game's own title typography, imported guarded: if GameTitle.tsx is missing or renamed,
// the screens fall back to plain text instead of failing to build.
import type { ComponentType } from "react";

type Id = "tower" | "snake" | "comet";
type GameTitleProps = { game: Id; size?: "tab" | "card" | "header"; className?: string };

const mods = import.meta.glob<{ default?: ComponentType<GameTitleProps> }>("../../GameTitle.tsx", { eager: true });
const GameTitle = Object.values(mods)[0]?.default;

const NAMES: Record<Id, string> = { tower: "Pixel Tower", snake: "Voice Snake", comet: "Comet Keeper" };

export function Title({ game, className = "" }: { game: Id; className?: string }) {
  return (
    <span className={`gr-title ${className}`}>
      {GameTitle ? <GameTitle game={game} size="header" /> : <span className="gr-title-text">{NAMES[game]}</span>}
    </span>
  );
}
