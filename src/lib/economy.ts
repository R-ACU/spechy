// Games economy on the page: one shared snapshot (state plus the balance the coin chip shows
// while coins are still flying), and the calls to the backend. In a plain browser (Vite
// without Tauri, dev only) the calls fall back to `economyMock.ts`, which plays the same
// rules in localStorage. The rules themselves live in src-tauri/src/economy.rs.
import { useSyncExternalStore } from "react";
import { api, economyDevApi, events, type BoxId, type EconomyState, type EquipSlot, type GameId } from "./ipc";

export interface EconomySnapshot {
  state: EconomyState | null;
  /** Balance shown while an animation holds the chip back; null shows the real one. */
  shown: number | null;
  /** Counter; every increase bumps the chip once. */
  bump: number;
  /** Coins already in the balance that wait for their own flight (rank-up rewards until Collect).
   *  The free chip shows `balance - reserve`, so a release never jumps over them. */
  reserve: number;
}

let snap: EconomySnapshot = { state: null, shown: null, bump: 0, reserve: 0 };
const subs = new Set<() => void>();

function emit(next: Partial<EconomySnapshot>) {
  snap = { ...snap, ...next };
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => { subs.delete(f); };
}

/** Plain listener, called synchronously inside every change (before React paints). */
export function subscribeEconomy(f: () => void): () => void {
  return subscribe(f);
}

/** The balance the chip shows right now. */
export function displayedBalance(s: EconomySnapshot = snap): number {
  return s.shown ?? (s.state?.balance ?? 0) - s.reserve;
}

/** Keep `delta` coins of the balance off the chip until their flight lands them (negative releases). */
export function reserveCoins(delta: number) {
  emit({ reserve: Math.max(0, snap.reserve + delta) });
}

export function useEconomy(): EconomySnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

export function economySnapshot(): EconomySnapshot {
  return snap;
}

export function setEconomyState(state: EconomyState) {
  emit({ state });
}

/** Freeze the chip at `value` (null releases it to the real balance). */
export function holdBalance(value: number | null) {
  emit({ shown: value });
}

/** One coin (or share) arrived at the chip: count up and bump. */
export function addShown(amount: number) {
  emit({ shown: displayedBalance() + amount, bump: snap.bump + 1 });
}

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Mock = typeof import("./economyMock");

async function call<T>(real: () => Promise<T>, mock: (m: Mock) => T): Promise<T> {
  if (import.meta.env.DEV && !inTauri()) {
    const m = await import("./economyMock");
    return mock(m);
  }
  return real();
}

let listening = false;

/** Load the state once (and follow backend changes such as dictation rewards). */
export async function loadEconomy(): Promise<EconomyState> {
  if (!listening && inTauri()) {
    listening = true;
    void events.onEconomyChanged((s) => emit({ state: s })).catch(() => { listening = false; });
  }
  const s = await call(() => api.economyState(), (m) => m.state());
  emit({ state: s });
  return s;
}

/** Award a finished (or left) round. Does not touch the snapshot: the results card
 *  holds the chip, flies the coins and then publishes `award.state` itself. */
export function awardGame(game: GameId, score: number, newBest: boolean, quit: boolean) {
  return call(() => api.economyAwardGame(game, score, newBest, quit), (m) => m.awardGame(game, score, newBest, quit));
}

export async function buyItem(itemId: string) {
  const s = await call(() => api.economyBuy(itemId), (m) => m.buy(itemId));
  emit({ state: s });
  return s;
}

/** Opens with a key if there is one, else pays. The caller publishes `opening.state` when its animation is done. */
export function openBox(boxId: BoxId) {
  return call(() => api.economyOpenBox(boxId), (m) => m.openBox(boxId));
}

export async function equipItem(slot: EquipSlot, itemId: string | null) {
  const s = await call(() => api.economyEquip(slot, itemId), (m) => m.equip(slot, itemId));
  emit({ state: s });
  return s;
}

/** Developer tools; null in a release bundle. */
export const economyDev = import.meta.env.DEV && economyDevApi
  ? {
      setUnlimited: async (on: boolean) => { const s = await call(() => economyDevApi!.setUnlimited(on), (m) => m.devSetUnlimited(on)); emit({ state: s }); return s; },
      addCoins: async (amount: number) => { const s = await call(() => economyDevApi!.addCoins(amount), (m) => m.devAddCoins(amount)); emit({ state: s }); return s; },
      rankUp: async () => { const r = await call(() => economyDevApi!.rankUp(), (m) => m.devRankUp()); emit({ state: r.state }); return r; },
      grantKeys: async (boxId: BoxId, count: number) => { const s = await call(() => economyDevApi!.grantKeys(boxId, count), (m) => m.devGrantKeys(boxId, count)); emit({ state: s }); return s; },
      reset: async () => { const s = await call(() => economyDevApi!.reset(), (m) => m.devReset()); emit({ state: s, shown: null, reserve: 0 }); return s; },
    }
  : null;

export const fmtCoins = (n: number) => Math.round(n).toLocaleString("en-US");

/** "Gold II", "Champion". */
export const rankLabel = (r: { tierName: string; division: number | null }) =>
  r.division == null ? r.tierName : `${r.tierName} ${["I", "II", "III"][r.division] ?? ""}`;
