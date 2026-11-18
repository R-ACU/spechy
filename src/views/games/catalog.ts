// The games shown in the Games tab. Each one is its own lazily loaded module.
import type { ComponentType } from "react";

export interface GameProps {
  /** Report a new personal best so the hub can show it. */
  onBest: (best: number) => void;
}

export type GameModule = { default: ComponentType<GameProps> };

export interface GameInfo {
  id: "tower" | "snake";
  title: string;
  tagline: string;
  /** Short control hint shown on the card. */
  controls: string;
  bestKey: string;
  load: () => Promise<GameModule>;
}

export const TOWER_BEST_KEY = "spechy.games.pixelTower.best";
/** Kept from the first Voice Snake so existing records survive. */
export const SNAKE_BEST_KEY = "spechy.snake.best";

export const GAMES: GameInfo[] = [
  {
    id: "tower",
    title: "Pixel Tower",
    tagline: "Stack the sliding blocks as high as you can.",
    controls: "Space or click",
    bestKey: TOWER_BEST_KEY,
    load: () => import("./PixelTowerGame"),
  },
  {
    id: "snake",
    title: "Voice Snake",
    tagline: "Steer the snake with your voice: up, down, left, right.",
    controls: "Voice or arrow keys",
    bestKey: SNAKE_BEST_KEY,
    load: () => import("./VoiceSnake"),
  },
];

export function readBest(key: string): number {
  try {
    return parseInt(localStorage.getItem(key) ?? "", 10) || 0;
  } catch {
    return 0;
  }
}
