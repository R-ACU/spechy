// Props of the per-game results screens. They mirror what ResultsCard renders, so the
// card can hand its props straight through (see README.md in this folder).
import type { RefObject } from "react";
import type { GameAward } from "../../../../lib/ipc";

export interface ResultsProps {
  award: GameAward;
  /** Record after this round, for the "Best 57" line. */
  best: number;
  /** Shown over the hub after leaving mid round (no stage behind it). */
  floating?: boolean;
  onBack: () => void;
  onAgain: () => void;
  /** Where the coins take off. Defaults to the Total value on the screen itself. */
  flyFrom?: RefObject<HTMLElement | null>;
  /** Called once after the last coin landed (or at once with reduced motion or no coins),
   *  for follow-ups such as the rank-up animation. */
  onCoinsLanded?: (award: GameAward) => void;
}

export type RowKind = "base" | "best" | "rp" | "promo" | "total";

export interface ResultRow {
  key: string;
  kind: RowKind;
  label: string;
  /** Coins for coin rows, rank points for the RP row; a promotion row holds its reward coins,
   *  which are not part of the total (they fly in on the rank-up overlay's Collect). */
  amount: number;
  /** The rank a promotion row reached (shown as its badge). */
  rank?: { tier: number; division: number | null };
}
