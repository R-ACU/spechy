// Shared logic of the per-game results screens: the rows (same as ResultsCard) and the
// sequence: hold the chip at the old balance, reveal the rows one by one with ticks, then fly
// the total into the chip and release it. Each screen only decides how it looks.
// The total is the round's coins only. Promotion coins stay off the chip; `onCoinsLanded`
// hands them to the rank-up overlay (ResultsCard), whose Collect flies them in.
import { useEffect, useMemo, useRef, useState } from "react";
import { economySnapshot, holdBalance, rankLabel, setEconomyState, fmtCoins } from "../../../../lib/economy";
import { flyCoins, type Flight } from "../flyCoins";
import { sfx } from "../sfx";
import type { ResultRow, ResultsProps } from "./types";

const UNIT: Record<string, [string, string]> = {
  tower: ["floor", "floors"],
  snake: ["point", "points"],
  comet: ["point", "points"],
};

export function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function buildRows(award: ResultsProps["award"]): ResultRow[] {
  const unit = UNIT[award.game] ?? ["point", "points"];
  const rows: ResultRow[] = [
    { key: "base", kind: "base", label: `${fmtCoins(award.score)} ${award.score === 1 ? unit[0] : unit[1]}`, amount: award.coins },
  ];
  if (award.newBest) rows.push({ key: "best", kind: "best", label: award.bestCapHit ? "New best (3 bonuses a day)" : "New best", amount: award.bestBonus });
  rows.push({ key: "rp", kind: "rp", label: "Rank points", amount: award.rp });
  for (const [i, p] of award.promotions.entries()) {
    rows.push({
      key: `promo${i}`, kind: "promo", label: `${p.kind === "tier" ? "Promoted to" : "Division up,"} ${rankLabel(p)}`,
      amount: p.coins, rank: { tier: p.tier, division: p.tier >= 6 ? null : p.division },
    });
  }
  rows.push({ key: "total", kind: "total", label: "Total", amount: award.total });
  return rows;
}

/** Runs the results sequence. `introMs` waits for the screen's own entrance first. */
export function useResults(props: ResultsProps, introMs: number) {
  const { award, flyFrom, onCoinsLanded } = props;
  const rows = useMemo(() => buildRows(award), [award]);
  const totalRef = useRef<HTMLElement>(null);
  const againRef = useRef<HTMLButtonElement>(null);
  const landedCb = useRef(onCoinsLanded);
  landedCb.current = onCoinsLanded;
  const [shown, setShown] = useState(0);
  const [landed, setLanded] = useState(false);

  useEffect(() => {
    const amount = rows[rows.length - 1].amount;
    const promoCoins = award.promotions.reduce((n, p) => n + p.coins, 0);
    // Publish the new state but keep the chip at the old balance until the coins landed;
    // promotion coins stay off it until the rank-up overlay is collected.
    const held = award.state.balance - amount - promoCoins - economySnapshot().reserve;
    holdBalance(held);
    setEconomyState(award.state);
    let flight: Flight | null = null;
    let alive = true, done = false;
    const timers: number[] = [];
    const wait = (ms: number) => new Promise<void>((r) => { timers.push(window.setTimeout(r, reducedMotion() ? 0 : ms)); });
    (async () => {
      sfx.end();
      if (award.newBest) sfx.best();
      await wait(introMs);
      for (let i = 1; i <= rows.length; i++) {
        await wait(170);
        if (!alive) return;
        setShown(i);
        if (rows[i - 1].kind === "promo") sfx.promo(); else sfx.tick();
      }
      await wait(350);
      if (!alive) return;
      const from = (flyFrom?.current ?? totalRef.current)?.getBoundingClientRect();
      if (from && amount > 0) {
        flight = flyCoins(from, amount);
        await flight.done;
      }
      if (!alive) return;
      done = true;
      setLanded(true);
      // First the rank-up reserves the promotion coins, then the chip is released.
      landedCb.current?.(award);
      holdBalance(promoCoins > 0 && !landedCb.current ? held + amount : null);
    })();
    againRef.current?.focus({ preventScroll: true });
    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
      flight?.cancel();
      // Left early: the round coins land at once, promotion coins stay held for the overlay
      // (ResultsCard opens it right after; it reserves them and Collect flies them).
      if (!done) holdBalance(promoCoins > 0 ? held + amount : null);
    };
    // The award object is the identity of one results screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [award]);

  return { rows, shown, landed, totalRef, againRef };
}
