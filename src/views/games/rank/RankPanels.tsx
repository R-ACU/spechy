// Local rank panels of the Leaderboard tab: the player's rank card (emblem, division, RP bar),
// the Monday payout and the rank rewards ladder. They read only the local economy state, so
// they are always visible, joined or not.
import type { CSSProperties, ReactNode } from "react";
import type { EconomyState } from "../../../lib/ipc";
import { fmtCoins, rankLabel } from "../../../lib/economy";
import { titleRarity } from "../../../lib/titles";
import { Coin } from "../economy/Coin";
import { RankBadge } from "./RankBadge";
import { CHAMPION_TIER, RANK_TIER_NAMES, tierColor } from "./rankArt";
import { BOX_NAMES, RP_PER_DIVISION, tierReward } from "./rankRules";
import "./rank.css";

export function TitleTag({ title }: { title: string }) {
  const r = titleRarity(title) ?? "common";
  return <span className={`rk-title r-${r}`}>{title}</span>;
}

export function RankCard({ state, name, title, rankLine, nums }: {
  state: EconomyState;
  name: string;
  title?: string | null;
  /** E.g. "Rank #3 this week"; omitted when not on the leaderboard. */
  rankLine?: ReactNode;
  nums: { value: string; caption: string }[];
}) {
  const r = state.rank;
  const champion = r.tier >= CHAMPION_TIER;
  const pct = champion ? 100 : Math.max(0, Math.min(100, (r.rp / RP_PER_DIVISION) * 100));
  return (
    <div className="rk-glass rk-me">
      <RankBadge tier={r.tier} division={champion ? null : r.division} size={74} />
      <div className="rk-me-mid">
        <div className="rk-me-rank"><b>{rankLabel(r)}</b>{rankLine ? <> · {rankLine}</> : null}</div>
        <div className="rk-me-name">
          <span>{name}</span>
          {title && <TitleTag title={title} />}
        </div>
        <div className="rk-rp">
          <div className="rk-rp-bar" role="progressbar" aria-label="Rank points" aria-valuemin={0} aria-valuemax={RP_PER_DIVISION} aria-valuenow={champion ? RP_PER_DIVISION : r.rp}>
            <i style={{ width: `${pct}%`, "--rc": tierColor(r.tier) } as CSSProperties} />
          </div>
          <span>{champion ? `${fmtCoins(r.rp)} RP at Champion` : `${r.rp} / ${RP_PER_DIVISION} RP`}</span>
        </div>
      </div>
      <div className="rk-nums">
        {nums.map((n) => (
          <div key={n.caption}>
            <div className="rk-num">{n.value}</div>
            <div className="rk-cap">{n.caption}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Time until the weekly reset (Monday 00:00 UTC). */
export function weekEndsIn(now = Date.now()): string {
  const d = new Date(now);
  const daysToMonday = (8 - d.getUTCDay()) % 7 || 7;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMonday);
  const h = Math.max(0, Math.floor((end - now) / 3_600_000));
  const days = Math.floor(h / 24), hours = h % 24;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return days > 0 ? `Ends in ${part(days, "day")}, ${part(hours, "hour")}` : `Ends in ${part(Math.max(1, hours), "hour")}`;
}

export function PayoutCard({ joined, payout }: { joined: boolean; payout: number[] | undefined }) {
  return (
    <div className="rk-glass rk-pay">
      <div className="rk-pay-h"><Coin size={18} />Monday payout</div>
      {(payout ?? [0, 0, 0]).map((coins, i) => (
        <div key={i} className="rk-pay-row"><span>{`Rank ${i + 1}`}</span><b><Coin size={14} />{payout ? coins : ""}</b></div>
      ))}
      <div className="rk-pay-foot">{weekEndsIn()}{joined ? "" : ". Join the leaderboard to compete."}</div>
    </div>
  );
}

export function RankLadder({ state }: { state: EconomyState }) {
  const r = state.rank;
  return (
    <div className="rk-glass rk-ladder">
      <div className="rk-ladder-h">
        Rank rewards
        <span>Earn RP by dictating and beating your bests. Every division up pays {state.earnRates.divisionCoins} coins.</span>
      </div>
      <div className="rk-ladder-row">
        {RANK_TIER_NAMES.map((name, i) => {
          const rew = tierReward(i, state.earnRates);
          const cls = i === r.tier ? "cur" : i < r.tier ? "past" : "";
          return (
            <div key={name} className={`rk-lt ${cls}`} style={{ "--c": tierColor(i) } as CSSProperties} aria-current={i === r.tier ? "step" : undefined}>
              <RankBadge tier={i} division={i === r.tier && i < CHAMPION_TIER ? r.division : null} size={46} />
              <div className="rk-lt-name">{name}</div>
              <div className="rk-lt-rew">
                {i === 0 ? <span>Start</span> : (
                  <>
                    <b><Coin size={12} />{fmtCoins(rew.coins)}</b>
                    <span>{rew.box ? BOX_NAMES[rew.box] : rew.title ? `${rew.title} title` : ""}</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
