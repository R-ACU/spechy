// The Spechy coin (flat gold disc with a rim and an S, no gradient; colours are the --coin
// tokens) and the balance chip, which lives only on the Games page, top right.
import { useEffect, useRef, type CSSProperties } from "react";
import { Infinity as InfinityIcon } from "lucide-react";
import { displayedBalance, fmtCoins, useEconomy } from "../../../lib/economy";

export function Coin({ size = 16 }: { size?: number }) {
  return (
    <span className="coin" style={{ "--s": `${size}px` } as CSSProperties} aria-hidden="true">
      <b>S</b>
    </span>
  );
}

/** Balance chip. Shows the held balance while coins fly in, bumps on every arrival.
 *  With developer unlimited coins it shows the real number plus an "Unlimited" marker. */
export function CoinChip({ onClick }: { onClick?: () => void }) {
  const eco = useEconomy();
  const { state, bump } = eco;
  const ref = useRef<HTMLButtonElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const el = ref.current;
    if (!el || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) return;
    el.animate([{ transform: "scale(1)" }, { transform: "scale(1.08)", offset: 0.4 }, { transform: "scale(1)" }], { duration: 420, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }, [bump]);

  const value = displayedBalance(eco);
  const label = `${fmtCoins(value)} coins${state?.unlimited ? ", unlimited" : ""}`;
  return (
    <button ref={ref} type="button" className="coin-chip" data-coin-chip="" title="Your coins" aria-label={label} onClick={onClick}>
      <Coin size={22} />
      <span className="coin-chip-val">{state ? fmtCoins(value) : " "}</span>
      {import.meta.env.DEV && state?.unlimited && (
        <span className="coin-chip-unl" title="Developer: unlimited coins">
          <InfinityIcon size={13} strokeWidth={2.4} aria-hidden="true" />
          Unlimited
        </span>
      )}
    </button>
  );
}
