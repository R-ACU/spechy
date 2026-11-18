// Monday payout on the page. The backend pays (once per ISO week, see economy.rs) when the player
// finished rank 1, 2 or 3 of last week's overall leaderboard; this module asks for it on app start
// and whenever the Games page opens, keeps the coin chip at the old balance and hands the payout
// to the Games page, which flies the coins into the chip. Not joined: no request at all.
import type { Toast, WeeklyPayout } from "./ipc";
import { displayedBalance, economySnapshot, holdBalance, setEconomyState } from "./economy";
import { claimWeeklyPayout } from "./leaderboard";

interface Pending extends WeeklyPayout { toasted: boolean }

let pending: Pending[] = [];
const subs = new Set<() => void>();
/** Weeks already handed to the page: concurrent callers share one backend answer, so the same
 *  payout can come back twice (app start and Games page, StrictMode); it flies and toasts once. */
const handled = new Set<string>();

export function payoutMessage(p: WeeklyPayout): string {
  return `Monday payout: +${p.coins} coins for rank ${p.rank} last week`;
}

/** Ask the backend for a due payout. `toastNow` shows the toast right away (the Games page is not
 *  open, so the coin flight comes later). */
export async function checkWeeklyPayout(toast: (t: Toast) => void, toastNow: boolean): Promise<void> {
  const p = await claimWeeklyPayout();
  if (!p || p.coins <= 0 || handled.has(p.week)) return;
  handled.add(p.week);
  const snap = economySnapshot();
  // The chip keeps the old balance until the flight lands the coins.
  holdBalance(snap.state ? displayedBalance(snap) : p.state.balance - p.coins);
  setEconomyState(p.state);
  if (toastNow) toast({ kind: "success", message: payoutMessage(p) });
  pending = [...pending, { ...p, toasted: toastNow }];
  subs.forEach((f) => f());
}

/** Payouts that were paid but not flown into the chip yet; the Games page takes them. */
export function takePendingPayouts(): Pending[] {
  const out = pending;
  pending = [];
  return out;
}

export function onPendingPayout(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}
