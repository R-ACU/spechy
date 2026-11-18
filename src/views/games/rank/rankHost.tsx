// Shows the rank-up overlay from anywhere (results card, Settings > Developer) in its own small
// React root on <body>, and watches the shared economy state for promotions nobody showed yet
// (dictation rewards arrive via spechy://economy-changed). Those play while the Games page is
// open, or on the next visit; the last rank the player saw is kept in localStorage.
//
// Coins: the backend has already added promotion coins to the balance. They are reserved off the
// coin chip (reserveCoins) from the moment they are known, so the chip never shows them early, and
// Collect always flies them in from the overlay's coin reward. An overlay therefore only opens
// while a coin chip is on screen (the Games page or a game header); otherwise it waits.
import { createRoot, type Root } from "react-dom/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { EconomyState, Promotion, RankState } from "../../../lib/ipc";
import { economySnapshot, holdBalance, reserveCoins, subscribeEconomy } from "../../../lib/economy";
import { chipCoin, flyCoins } from "../economy/flyCoins";
import RankUpOverlay, { type RankUpCollect, type RankUpRequest } from "./RankUpOverlay";
import { posOf, promotionsBetween, rankStep, readSeenRank, writeSeenRank, type RankPos } from "./rankRules";
import { setRankSfxEnabled } from "./rankSfx";

// ---------------------------------------------------------------- queue

let queue: RankUpRequest[] = [];
const subs = new Set<() => void>();
const publish = (next: RankUpRequest[]) => { queue = next; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

let soundOn = true;
/** The app's sound setting, for overlays the watcher opens on its own. */
export function setRankSound(on: boolean) { soundOn = on; }

let holds = 0;
/** Pause the watcher while a caller changes the rank itself (it shows its own overlay). */
export function holdRankWatch(): () => void {
  holds += 1;
  let done = false;
  return () => { if (!done) { done = true; holds -= 1; } };
}

/** The player has seen this rank (its promotions are shown by the caller). */
export function markRankSeen(r: RankState | RankPos) {
  writeSeenRank({ tier: r.tier, division: r.division });
}

/** Rank right before a promotion. */
export function rankBefore(p: Promotion): RankPos {
  if (p.kind === "division") return { tier: p.tier, division: Math.max(0, (p.division ?? 1) - 1) };
  return { tier: Math.max(0, p.tier - 1), division: 2 };
}

let nextId = 0;

/** Requests that open only on the Games hub (promotions found by the watcher). */
const hubOnly = new WeakSet<RankUpRequest>();

/**
 * Queue a rank-up overlay. `holdCoins`: the promotion coins are in the balance already; they are
 * reserved off the chip right now and Collect flies them in. `hubOnly`: wait for the Games hub.
 */
export function showRankUp(promotions: Promotion[], opts: { from?: RankPos; sound?: boolean; holdCoins?: boolean; hubOnly?: boolean } = {}) {
  if (promotions.length === 0) return;
  ensureRankHost();
  const coins = promotions.reduce((n, p) => n + p.coins, 0);
  if (opts.holdCoins && coins > 0) reserveCoins(coins);
  setRankSfxEnabled(opts.sound ?? soundOn);
  const req: RankUpRequest = { id: ++nextId, from: opts.from ?? rankBefore(promotions[0]), promotions, sound: opts.sound ?? soundOn, held: !!opts.holdCoins };
  if (opts.hubOnly) hubOnly.add(req);
  publish([...queue, req]);
}

function closed(req: RankUpRequest) {
  publish(queue.filter((q) => q !== req));
}

function collected(req: RankUpRequest, c: RankUpCollect) {
  if (!req.held) return;
  const coins = req.promotions.reduce((n, p) => n + p.coins, 0);
  if (coins <= 0) return;
  const release = () => {
    // The flight has counted the coins onto the chip; now they leave the reserve. A hold that
    // equals the free value is dropped, so later balance changes show normally.
    reserveCoins(-coins);
    const s = economySnapshot();
    if (s.shown !== null && s.shown === (s.state?.balance ?? 0) - s.reserve) holdBalance(null);
  };
  // From the overlay's coin reward into the chip, coin by coin (count-up, bump, clink).
  const from = c.coinRect ?? new DOMRect(window.innerWidth / 2 - 20, window.innerHeight / 2 - 20, 40, 40);
  void flyCoins(from, coins, 16).done.then(release);
}

// ---------------------------------------------------------------- watcher

/** Games page open with the hub (not inside a running game)? */
const gamesHubOpen = () => !!document.querySelector(".gm-root:not(.gm-root-play)");

/** Runs synchronously inside every economy change, so promotion coins (dictation rewards) are
 *  reserved before the chip could paint them. The overlay itself waits for the Games hub. */
let lastChecked: EconomyState | null = null;

function check(eco: EconomyState | null | undefined) {
  const state = eco?.rank;
  // Only a new state counts: a results screen marks its rank seen before it publishes the
  // state, and a mere chip update in between must not read as a reset.
  if (!eco || !state || eco === lastChecked) return;
  lastChecked = eco;
  if (holds > 0) return;
  const cur = posOf(state);
  const seen = readSeenRank();
  if (!seen || rankStep(cur) < rankStep(seen)) {
    // First run, or a reset: nothing to celebrate.
    writeSeenRank(cur);
    return;
  }
  if (rankStep(cur) === rankStep(seen)) return;
  writeSeenRank(cur);
  showRankUp(promotionsBetween(seen, cur, eco.earnRates), { from: seen, holdCoins: true, hubOnly: true });
}

/** May this overlay open now? Collect needs a visible chip to fly into. */
const canShow = (req: RankUpRequest) => !!chipCoin() && (!hubOnly.has(req) || gamesHubOpen());
/** Overlays already on screen stay up until collected, whatever happens behind them. */
const opened = new WeakSet<RankUpRequest>();

function RankHost() {
  const items = useSyncExternalStore(subscribe, () => queue);
  const top = items[0];
  const [, recheck] = useState(0);
  const ok = !!top && (opened.has(top) || canShow(top));
  if (top && ok) opened.add(top);

  useEffect(() => {
    if (!top || ok) return;
    // Waiting for a chip (or the Games hub): look again now and then (cheap DOM check).
    const t = window.setInterval(() => { if (canShow(top)) recheck((n) => n + 1); }, 400);
    return () => window.clearInterval(t);
  }, [top, ok]);

  if (!top || !ok) return null;
  return <RankUpOverlay key={top.id} req={top} onCollect={(c) => collected(top, c)} onClosed={() => closed(top)} />;
}

// ---------------------------------------------------------------- mount

let root: Root | null = null;

/** Mount the host once (idempotent). Safe to call at module load. */
export function ensureRankHost() {
  if (root || typeof document === "undefined") return;
  document.getElementById("spechy-rank-host")?.remove(); // stale after a hot reload
  const el = document.createElement("div");
  el.id = "spechy-rank-host";
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(<RankHost />);
  subscribeEconomy(() => check(economySnapshot().state));
  check(economySnapshot().state);
}
