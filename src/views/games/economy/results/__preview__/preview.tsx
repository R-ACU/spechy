// TESTCODE (2026-11-18): dev-only harness for the per-game results screens: a mock game header with the coin chip at
// the top right, a stage, and one screen with a mock award. URL parameters:
//   skin=1 (equip the game's skin)  game=tower|snake|comet  mode=best|normal|quit  theme=light|dark  trace=1 (draw coin paths)
// window.__trace holds the sampled coin positions and the chip centre after a flight.
import { StrictMode, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { EconomyState, GameAward, GameId } from "../../../../../lib/ipc";
import { setEconomyState } from "../../../../../lib/economy";
import { CoinChip } from "../../Coin";
import { resultsScreenFor } from "../index";
import "../../../../../styles.css";
import "../../economy.css";

const q = new URLSearchParams(location.search);
const game = (q.get("game") ?? "tower") as GameId;
const mode = q.get("mode") ?? "normal";
document.documentElement.dataset.theme = q.get("theme") === "light" ? "light" : "dark";

const BALANCE = 1240;
const state = (balance: number) => ({ balance, unlimited: false, devTools: true, today: { gameCoinCap: 300 }, equipped: q.get("skin") ? { [`${game}-skin`]: `${game}-${{ tower: "sunset", snake: "neon", comet: "ice" }[game]}` } : {} }) as unknown as EconomyState;
setEconomyState(state(BALANCE));

function mockAward(): GameAward {
  const best = mode === "best", quit = mode === "quit";
  const score = { tower: 42, snake: 27, comet: 88 }[game] ?? 10;
  const coins = quit ? 4 : 10, bestBonus = best ? 25 : 0, rp = quit ? 6 : 18;
  const total = coins + bestBonus;
  return {
    game, score: quit ? Math.round(score / 3) : score, newBest: best, quit,
    baseCoins: coins, coins, bestBonus, total, rp, dailyCapHit: false, bestCapHit: false,
    rankBefore: {} as GameAward["rankBefore"], promotions: [], state: state(BALANCE + total),
  };
}

const TRACE = q.get("trace") === "1";
const trace: { x: number; y: number }[] = [];
(window as unknown as { __trace: unknown }).__trace = { points: trace, chip: null };
if (TRACE) {
  const cv = document.createElement("canvas");
  cv.width = innerWidth; cv.height = innerHeight;
  cv.style.cssText = "position:fixed;inset:0;z-index:399;pointer-events:none";
  document.body.appendChild(cv);
  const g = cv.getContext("2d")!;
  const tick = () => {
    document.querySelectorAll<HTMLElement>(".coin-fly").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (Number(el.style.opacity) < 0.5) return;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      trace.push({ x, y });
      g.fillStyle = "rgba(255, 80, 120, .55)";
      g.fillRect(x - 1, y - 1, 2, 2);
    });
    const c = document.querySelector("[data-coin-chip] .coin")?.getBoundingClientRect();
    if (c) (window as unknown as { __trace: { chip: unknown } }).__trace.chip = { x: c.left + c.width / 2, y: c.top + c.height / 2, top: c.top };
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const head: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 22px" };

function Preview() {
  const [run, setRun] = useState(0);
  const [award] = useState(mockAward);
  (window as unknown as { __replay: () => void }).__replay = () => setRun((n) => n + 1);
  const Screen = resultsScreenFor(game)!;
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font)" }}>
      <header style={head}>
        <span style={{ fontSize: 14, color: "var(--text-2)" }}>Games / {game} ({mode})</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--text-3)" }}>Best 57</span>
          <CoinChip />
        </div>
      </header>
      <div style={{ position: "relative", margin: "0 22px", height: 640, borderRadius: 16, background: "var(--surface-2)", display: "grid", placeItems: "center" }}>
        <Screen
          key={run}
          award={award}
          best={57}
          floating={award.quit}
          onBack={() => {}}
          onAgain={() => setRun((n) => n + 1)}
          onCoinsLanded={() => { document.body.dataset.landed = String(run + 1); }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
