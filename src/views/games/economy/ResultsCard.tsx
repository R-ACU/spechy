// Results after a round (or after leaving one): score, new best, rows for coins, best bonus,
// rank points and promotions, then the total flies into the coin chip. The chip is held at
// the old balance until the last coin landed. No backdrop: the card is its own surface.
// Promotions: their coins stay held back; once the round coins have landed the rank-up overlay
// opens and its Collect flies them in.
import { useEffect, useRef, useState } from "react";
import { Award, RotateCcw } from "lucide-react";
import type { GameAward } from "../../../lib/ipc";
import { economySnapshot, fmtCoins, holdBalance, rankLabel, setEconomyState } from "../../../lib/economy";
import { useStore } from "../../../lib/store";
import { RankBadge } from "../rank/RankBadge";
import { ensureRankHost, markRankSeen, setRankSound, showRankUp } from "../rank/rankHost";
import { Coin } from "./Coin";
import { flyCoins, type Flight } from "./flyCoins";
import { sfx } from "./sfx";
import { resultsScreenFor, type ResultsProps } from "./results";

// The rank-up watcher (promotions from dictation rewards) lives as long as the Games page is loaded.
ensureRankHost();

/** Awards whose promotions went to the overlay, and cards currently showing an award
 *  (StrictMode mounts effects twice; a promotion must open exactly one overlay). */
const handed = new WeakSet<GameAward>();
const mounted = new WeakMap<GameAward, number>();

const UNIT: Record<string, [string, string]> = {
  tower: ["floor", "floors"],
  snake: ["point", "points"],
  comet: ["point", "points"],
};

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Row { key: string; label: string; value: React.ReactNode; className?: string }

function GenericResultsCard({ award, best, floating, onBack, onAgain }: {
  award: GameAward;
  /** Record after this round, for the "Best 57" line. */
  best: number;
  /** Shown over the hub after leaving mid round (no stage behind it). */
  floating?: boolean;
  onBack: () => void;
  onAgain: () => void;
}) {
  const { settings } = useStore();
  const soundOn = settings.sounds !== false;
  const totalRef = useRef<HTMLElement>(null);
  const againRef = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(0);
  const promoCoins = award.promotions.reduce((n, p) => n + p.coins, 0);
  const unit = UNIT[award.game] ?? ["point", "points"];

  const rows: Row[] = [
    { key: "base", label: `${fmtCoins(award.score)} ${award.score === 1 ? unit[0] : unit[1]}`, value: <><Coin />+{award.coins}</> },
  ];
  if (award.newBest) {
    rows.push({ key: "best", label: award.bestCapHit ? "New best (3 bonuses a day)" : "New best", value: <><Coin />+{award.bestBonus}</> });
  }
  rows.push({ key: "rp", label: "Rank points", value: <span className="sr-rp">+{award.rp} RP</span> });
  for (const [i, p] of award.promotions.entries()) {
    rows.push({
      key: `promo${i}`,
      label: `${p.kind === "tier" ? "Promoted to" : "Division up,"} ${rankLabel(p)}`,
      value: <RankBadge tier={p.tier} division={p.tier >= 6 ? null : p.division} size={22} label="" />,
      className: "sr-promo",
    });
  }
  rows.push({ key: "total", label: "Total", value: <><Coin size={22} /><span ref={totalRef}>+{fmtCoins(award.total)}</span></>, className: "total" });

  useEffect(() => {
    const amount = award.total;
    const promos = award.promotions;
    // Publish the new state but keep the chip at the old balance until the coins landed;
    // promotion coins stay held until the rank-up overlay is collected.
    if (promos.length) markRankSeen(award.state.rank);
    const held = award.state.balance - amount - promoCoins - economySnapshot().reserve;
    holdBalance(held);
    setEconomyState(award.state);
    let flight: Flight | null = null;
    let alive = true, done = false;
    mounted.set(award, (mounted.get(award) ?? 0) + 1);
    const rankUp = () => triggerRankUp(award, soundOn);
    const timers: number[] = [];
    const wait = (ms: number) => new Promise<void>((r) => { timers.push(window.setTimeout(r, reducedMotion() ? 0 : ms)); });
    (async () => {
      sfx.end();
      if (award.newBest) sfx.best();
      for (let i = 1; i <= rows.length; i++) {
        await wait(170);
        if (!alive) return;
        setShown(i);
        if (rows[i - 1]?.className === "sr-promo") sfx.promo(); else sfx.tick();
      }
      await wait(350);
      if (!alive) return;
      const from = totalRef.current?.getBoundingClientRect();
      if (from && amount > 0) {
        flight = flyCoins(from, amount);
        await flight.done;
      }
      if (!alive) return;
      done = true;
      // The rank-up reserves the promotion coins first, then the chip is free again.
      rankUp();
      holdBalance(null);
    })();
    againRef.current?.focus({ preventScroll: true });
    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
      flight?.cancel();
      mounted.set(award, (mounted.get(award) ?? 1) - 1);
      // Left before the coins landed: the promotion still gets its moment (unless the same
      // card mounts again right away, as under StrictMode).
      if (done) return;
      holdBalance(promos.length ? held + amount : null);
      if (promos.length) window.setTimeout(() => { if (!mounted.get(award)) rankUp(); }, 0);
    };
    // The award object is the identity of one results card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [award]);

  return (
    <div className={`sr-card ${floating ? "sr-floating" : ""}`} role="status" aria-live="polite">
      <div className="sr-k">{award.quit ? "You left" : "Game over"}</div>
      <div className="sr-score">{fmtCoins(award.score)}</div>
      {award.newBest ? (
        <span className="sr-best"><Award size={14} aria-hidden="true" />New best</span>
      ) : (
        <span className="sr-muted">Best {fmtCoins(best)}</span>
      )}
      <div className="sr-rows">
        {rows.map((r, i) => (
          <div key={r.key} className={`sr-row ${r.className ?? ""} ${i < shown ? "on" : ""}`}>
            <span>{r.label}</span>
            <b>{r.value}</b>
          </div>
        ))}
      </div>
      {award.dailyCapHit && <p className="sr-note">Daily game coin limit reached ({award.state.today.gameCoinCap}). Rank points still count.</p>}
      <div className="sr-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>{floating ? "Done" : "Back to games"}</button>
        <button ref={againRef} type="button" className="btn btn-primary btn-sm" onClick={onAgain}>
          <RotateCcw size={15} aria-hidden="true" />
          Play again
        </button>
      </div>
    </div>
  );
}

/** Opens the rank-up overlay for an award's promotions exactly once. */
function triggerRankUp(award: GameAward, sound: boolean) {
  if (award.promotions.length === 0 || handed.has(award)) return;
  handed.add(award);
  setRankSound(sound);
  showRankUp(award.promotions, { from: { tier: award.rankBefore.tier, division: award.rankBefore.division }, sound, holdCoins: true });
}

/** A per-game results screen plus the rank-up trigger. The screen flies the round coins only;
 *  the promotion coins stay reserved and fly in on the overlay's Collect. */
function PerGameResults({ Screen, props }: { Screen: NonNullable<ReturnType<typeof resultsScreenFor>>; props: ResultsProps }) {
  const { settings } = useStore();
  const sound = settings.sounds !== false;
  const { award } = props;
  // Before the screen publishes the new state: the watcher must not show these promotions too.
  useState(() => { if (award.promotions.length) markRankSeen(award.state.rank); return 0; });
  useEffect(() => {
    if (award.promotions.length === 0) return;
    mounted.set(award, (mounted.get(award) ?? 0) + 1);
    return () => {
      mounted.set(award, (mounted.get(award) ?? 1) - 1);
      // Left before the coins landed: the promotion still gets its moment (not on a StrictMode remount).
      window.setTimeout(() => { if (!mounted.get(award)) triggerRankUp(award, sound); }, 0);
    };
  }, [award, sound]);
  return (
    <Screen
      {...props}
      onCoinsLanded={(a) => { triggerRankUp(a, sound); props.onCoinsLanded?.(a); }}
    />
  );
}

export default function ResultsCard(props: Parameters<typeof GenericResultsCard>[0]) {
  const Screen = resultsScreenFor(props.award.game);
  return Screen ? <PerGameResults Screen={Screen} props={props} /> : <GenericResultsCard {...props} />;
}

