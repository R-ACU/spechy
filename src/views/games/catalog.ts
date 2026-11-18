// The games shown in the Games tab. Each one is its own lazily loaded module.
import type { ComponentType } from "react";
import { paint as paintCometCover } from "./cometKeeper/cover";

export interface GameProps {
  /** Report a new personal best so the hub can show it. `key` picks the record of a game
   *  with several (Voice Snake: voice and keys); without it the first one counts. */
  onBest: (best: number, key?: string) => void;
  /** Which record the header shows right now; null shows all of them. */
  onBestKey?: (key: string | null) => void;
}

export type GameModule = { default: ComponentType<GameProps> };

/** One personal record in localStorage; `label` names it when a game has several. */
export interface BestSlot {
  key: string;
  label?: string;
}

export interface GameInfo {
  id: string;
  title: string;
  tagline: string;
  /** Short control hint shown on the card. */
  controls: string;
  bests: BestSlot[];
  load: () => Promise<GameModule>;
  /** Paints the hub cover into a 128 x 80 canvas; without it covers.ts is used. */
  cover?: (g: CanvasRenderingContext2D) => void;
}

export const TOWER_BEST_KEY = "spechy.games.pixelTower.best";
/** Voice Snake keeps one record per mode: steering by voice is a different game. */
export const SNAKE_VOICE_BEST_KEY = "spechy.snake.best.voice";
export const SNAKE_KEYS_BEST_KEY = "spechy.snake.best.keys";
/** The single record of the first Voice Snake, before the modes were split. */
const SNAKE_LEGACY_BEST_KEY = "spechy.snake.best";

export const GAMES: GameInfo[] = [
  {
    id: "tower",
    title: "Pixel Tower",
    tagline: "Stack the sliding blocks as high as you can.",
    controls: "Space or click",
    bests: [{ key: TOWER_BEST_KEY }],
    load: () => import("./PixelTowerGame"),
  },
  {
    id: "snake",
    title: "Voice Snake",
    tagline: "Steer the snake by voice in English or German, or with the arrow keys.",
    controls: "Voice or keys",
    bests: [
      { key: SNAKE_VOICE_BEST_KEY, label: "Voice" },
      { key: SNAKE_KEYS_BEST_KEY, label: "Keys" },
    ],
    load: () => import("./VoiceSnake"),
  },
  {
    id: "comet",
    title: "Comet Keeper",
    tagline: "Turn the shield and bounce the comets back before they reach your little lantern.",
    controls: "Arrows or click",
    bests: [{ key: "spechy.games.comet.best" }],
    load: () => import("./cometKeeper/CometKeeper"),
    cover: paintCometCover,
  },
];

// ---------- reveal of new games ----------
// Every game added after the first Games release gets a one-time reveal the first time the
// hub lists it (fanfare plus cover dissolving in), and a "New" badge until it is played once.
/** Games of the first Games release: known to everyone, never revealed. */
const LAUNCH_GAMES = ["tower", "snake"];
const REVEALED_KEY = "spechy.games.revealed";
const PLAYED_KEY = "spechy.games.played";

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function addToList(key: string, id: string): void {
  const list = readList(key);
  if (list.includes(id)) return;
  try { localStorage.setItem(key, JSON.stringify([...list, id])); } catch { /* storage blocked */ }
}

export const needsReveal = (id: string) => !LAUNCH_GAMES.includes(id) && !readList(REVEALED_KEY).includes(id);
export const markRevealed = (id: string) => addToList(REVEALED_KEY, id);
export const isNewGame = (id: string) => !LAUNCH_GAMES.includes(id) && !readList(PLAYED_KEY).includes(id);
export const markPlayed = (id: string) => addToList(PLAYED_KEY, id);

export function readBest(key: string): number {
  try {
    return parseInt(localStorage.getItem(key) ?? "", 10) || 0;
  } catch {
    return 0;
  }
}

/** Store `value` under `key` if it beats the record there. True when it did. */
export function writeBest(key: string, value: number): boolean {
  if (value <= readBest(key)) return false;
  try { localStorage.setItem(key, String(value)); } catch { /* storage blocked */ }
  return true;
}

/** Fold the old single Voice Snake record into the keys record once (it was set with
 *  the keys or with the old speech engine), then drop the old key. */
export function migrateSnakeBest(): void {
  try {
    if (localStorage.getItem(SNAKE_LEGACY_BEST_KEY) === null) return;
    writeBest(SNAKE_KEYS_BEST_KEY, readBest(SNAKE_LEGACY_BEST_KEY));
    localStorage.removeItem(SNAKE_LEGACY_BEST_KEY);
  } catch { /* storage blocked */ }
}

/** Every record of every game, by storage key. */
export function readAllBests(): Record<string, number> {
  migrateSnakeBest();
  return Object.fromEntries(GAMES.flatMap((g) => g.bests.map((b) => [b.key, readBest(b.key)])));
}

/** "Best 12", "Voice 5 · Keys 12" or "No best yet". */
export function bestText(game: GameInfo, best: Record<string, number>, only: string | null = null): string {
  const slots = only ? game.bests.filter((b) => b.key === only) : game.bests;
  if (!slots.some((b) => (best[b.key] ?? 0) > 0)) {
    return slots.length === 1 && slots[0].label ? `No ${slots[0].label.toLowerCase()} best yet` : "No best yet";
  }
  if (slots.length === 1) return slots[0].label ? `${slots[0].label} best ${best[slots[0].key] ?? 0}` : `Best ${best[slots[0].key] ?? 0}`;
  return slots.map((b) => `${b.label ?? "Best"} ${best[b.key] ?? 0}`).join(" · ");
}
