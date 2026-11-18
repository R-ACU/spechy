// Rank rules the page needs for display: rewards per tier (mirrors the promotion rewards in
// src-tauri/src/economy.rs, which stays the single source of truth), the ladder order, and the
// "last rank the player saw" that lets a promotion from a dictation reward play its animation
// later (on the next visit to Games).
import type { BoxId, EarnRates, Promotion, RankState } from "../../../lib/ipc";
import { CHAMPION_TIER, RANK_TIER_NAMES } from "./rankArt";

export const RP_PER_DIVISION = 100;

export interface TierReward { coins: number; box: BoxId | null; title: string | null }

/** Box and title per tier (index 0 Bronze is the start and pays nothing). Coins come from the backend (`EarnRates.tierCoins`). */
const TIER_EXTRAS: readonly { box: BoxId | null; title: string | null }[] = [
  { box: null, title: null },
  { box: "basic", title: null },
  { box: "premium", title: null },
  { box: "premium", title: null },
  { box: "mythic", title: null },
  { box: "mythic", title: null },
  { box: null, title: "Champion" },
];

/** Reward for reaching a tier, with the coins the backend pays (boost included). */
export const tierReward = (tier: number, rates: EarnRates): TierReward => ({ coins: rates.tierCoins[tier] ?? 0, ...TIER_EXTRAS[tier] });

export const BOX_NAMES: Record<BoxId, string> = { basic: "Basic box", premium: "Premium box", mythic: "Mythic box" };

export interface RankPos { tier: number; division: number | null }

/** Position on the ladder: Bronze I = 0, Bronze II = 1, ..., Champion = 18. */
export const rankStep = (r: RankPos) => Math.min(CHAMPION_TIER, r.tier) * 3 + (r.tier >= CHAMPION_TIER ? 0 : r.division ?? 0);

/** The promotions between two ladder positions, in order (what the backend paid on the way). */
export function promotionsBetween(from: RankPos, to: RankPos, rates: EarnRates): Promotion[] {
  const out: Promotion[] = [];
  let tier = from.tier, div = from.tier >= CHAMPION_TIER ? 0 : from.division ?? 0;
  const end = rankStep(to);
  while (tier * 3 + div < end && tier < CHAMPION_TIER) {
    if (div < 2) {
      div += 1;
      out.push({ kind: "division", tier, tierName: RANK_TIER_NAMES[tier], division: div, coins: rates.divisionCoins, boxKey: null, title: null });
    } else {
      tier += 1;
      div = 0;
      const r = tierReward(tier, rates);
      out.push({ kind: "tier", tier, tierName: RANK_TIER_NAMES[tier], division: tier >= CHAMPION_TIER ? null : 0, coins: r.coins, boxKey: r.box, title: r.title });
    }
  }
  return out;
}

// ---------------------------------------------------------------- last seen rank

const SEEN_KEY = "spechy.rank.seen";

export function readSeenRank(): RankPos | null {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null");
    if (v && typeof v.tier === "number") return { tier: v.tier, division: typeof v.division === "number" ? v.division : null };
  } catch { /* nothing stored */ }
  return null;
}

export function writeSeenRank(r: RankPos) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ tier: r.tier, division: r.division })); } catch { /* storage blocked */ }
}

export const posOf = (r: RankState): RankPos => ({ tier: r.tier, division: r.division });
