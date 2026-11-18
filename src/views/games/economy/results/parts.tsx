// Pieces every results screen shares: the rows (with a per-game bullet), the daily cap note
// and the two actions. Each screen styles them through its own root class.
import type { ReactNode, RefObject } from "react";
import { RotateCcw } from "lucide-react";
import { fmtCoins } from "../../../../lib/economy";
import { RankBadge } from "../../rank/RankBadge";
import { Coin } from "../Coin";
import type { ResultRow, ResultsProps } from "./types";

export function Rows({ rows, shown, totalRef, bullet }: {
  rows: ResultRow[];
  shown: number;
  totalRef: RefObject<HTMLElement | null>;
  bullet?: (row: ResultRow, i: number) => ReactNode;
}) {
  return (
    <div className="gr-rows">
      {rows.map((r, i) => (
        <div key={r.key} className={`gr-row gr-row-${r.kind} ${i < shown ? "on" : ""}`}>
          <span className="gr-row-label">
            {bullet && <span className="gr-bullet" aria-hidden="true">{bullet(r, i)}</span>}
            {r.label}
          </span>
          <b>
            {r.kind === "rp" ? (
              <span className="gr-rp">+{fmtCoins(r.amount)} RP</span>
            ) : r.kind === "promo" && r.rank ? (
              <RankBadge tier={r.rank.tier} division={r.rank.division} size={22} label="" />
            ) : r.kind === "total" ? (
              <><Coin size={22} /><span ref={totalRef as RefObject<HTMLSpanElement>}>+{fmtCoins(r.amount)}</span></>
            ) : (
              <><Coin />+{fmtCoins(r.amount)}</>
            )}
          </b>
        </div>
      ))}
    </div>
  );
}

export function CapNote({ award }: { award: ResultsProps["award"] }) {
  if (!award.dailyCapHit) return null;
  return <p className="gr-note">Daily game coin limit reached ({award.state.today.gameCoinCap}). Rank points still count.</p>;
}

export function Actions({ floating, onBack, onAgain, againRef }: {
  floating?: boolean; onBack: () => void; onAgain: () => void; againRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="gr-actions">
      <button type="button" className="btn btn-secondary btn-sm gr-btn-2" onClick={onBack}>{floating ? "Done" : "Back to games"}</button>
      <button ref={againRef} type="button" className="btn btn-primary btn-sm gr-btn-1" onClick={onAgain}>
        <RotateCcw size={15} aria-hidden="true" />
        Play again
      </button>
    </div>
  );
}

export const kicker = (award: ResultsProps["award"]) => (award.quit ? "You left" : "Game over");
