// Picks the results screen of a game. Returns null for a game without its own screen, so
// the caller can fall back to the generic ResultsCard.
import type { ComponentType } from "react";
import CometResults from "./CometResults";
import SnakeResults from "./SnakeResults";
import TowerResults from "./TowerResults";
import type { ResultsProps } from "./types";

export type { ResultsProps } from "./types";

const SCREENS: Record<string, ComponentType<ResultsProps>> = {
  tower: TowerResults,
  snake: SnakeResults,
  comet: CometResults,
};

export function resultsScreenFor(game: string): ComponentType<ResultsProps> | null {
  return SCREENS[game] ?? null;
}
