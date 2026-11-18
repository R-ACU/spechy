// The big rank-up moment: the old emblem shakes and breaks into four shards, a shockwave and a
// burst of diamonds, the new emblem spins in over slow rays, then the rewards rise and Collect
// flies the coins into the balance chip. Blurred backdrop without tint, no flashes; with reduced
// motion everything simply fades in.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Crown } from "lucide-react";
import type { Promotion } from "../../../lib/ipc";
import { fmtCoins, rankLabel } from "../../../lib/economy";
import { Coin } from "../economy/Coin";
import { parcelHtml } from "../shop/parcels";
import { RankBadge } from "./RankBadge";
import { tierColor } from "./rankArt";
import { BOX_NAMES, type RankPos } from "./rankRules";
import { rankSfx } from "./rankSfx";
import "../economy/economy.css";

export interface RankUpRequest {
  /** Rank before the first promotion. */
  from: RankPos;
  /** One or more promotions in order; the overlay shows the last one and the sum of the rewards. */
  promotions: Promotion[];
  sound: boolean;
  /** The promotion coins are reserved off the coin chip; Collect flies them in. */
  held?: boolean;
  /** Identity of one overlay. */
  id: number;
}

export interface RankUpCollect {
  /** Where the coin reward sat, for the coin flight (null when there was none on screen). */
  coinRect: DOMRect | null;
  coins: number;
}

const QUADS = [
  "polygon(0 0,52% 0,48% 52%,0 46%)",
  "polygon(52% 0,100% 0,100% 50%,48% 52%)",
  "polygon(0 46%,48% 52%,54% 100%,0 100%)",
  "polygon(48% 52%,100% 50%,100% 100%,54% 100%)",
];
const DIRS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const EMBLEM = 150;

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Sum of the rewards of several promotions. */
export function combineRewards(promotions: Promotion[]) {
  const boxes = new Map<string, number>();
  let coins = 0, title: string | null = null;
  for (const p of promotions) {
    coins += p.coins;
    if (p.boxKey) boxes.set(p.boxKey, (boxes.get(p.boxKey) ?? 0) + 1);
    if (p.title) title = p.title;
  }
  return { coins, boxes: [...boxes.entries()] as [keyof typeof BOX_NAMES, number][], title };
}

/** `onCollect` fires on the click (the coins take off from the reward while the overlay fades),
 *  `onClosed` once the overlay has faded out. */
export default function RankUpOverlay({ req, onCollect, onClosed }: { req: RankUpRequest; onCollect: (c: RankUpCollect) => void; onClosed: () => void }) {
  const to = req.promotions[req.promotions.length - 1];
  const kind = req.promotions.some((p) => p.kind === "tier") ? "tier" : "division";
  const rew = combineRewards(req.promotions);
  const rewardCount = (rew.coins > 0 ? 1 : 0) + rew.boxes.length + (rew.title ? 1 : 0);

  const rootRef = useRef<HTMLDivElement>(null);
  const oldRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const raysRef = useRef<HTMLDivElement>(null);
  const partsRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLDivElement>(null);
  const kickerRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLDivElement>(null);
  const rewardsRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const coinRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const closing = useRef(false);

  useEffect(() => {
    let alive = true;
    const timers: number[] = [];
    const anims: Animation[] = [];
    const reduce = reducedMotion();
    const wait = (ms: number) => new Promise<void>((r) => { timers.push(window.setTimeout(r, reduce ? 0 : ms)); });
    const A = (el: Element | null, k: Keyframe[], o: KeyframeAnimationOptions) => {
      if (!el) return;
      anims.push(el.animate(k, o));
    };
    const snd = req.sound;

    rootRef.current?.focus({ preventScroll: true });
    (async () => {
      A(rootRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 160 : 250, fill: "forwards" });
      if (reduce) {
        // No shards, burst or spin: the new emblem, the name and the rewards fade in.
        if (oldRef.current) oldRef.current.style.display = "none";
        A(newRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" });
        A(kickerRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" });
        A(nameRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" });
        rewardsRef.current?.querySelectorAll(".ru-rew").forEach((r) => A(r, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "forwards" }));
        if (snd) rankSfx.promo(kind === "tier");
        setReady(true);
        return;
      }
      await wait(450);
      if (!alive) return;
      if (snd) rankSfx.riser(kind === "tier" ? 1.05 : 0.8);
      A(oldRef.current, [0, -5, 5, -6, 6, -4, 4, 0].map((x) => ({ transform: `translateX(${x}px)` })), { duration: 520 });
      await wait(560);
      if (!alive) return;
      if (snd) { rankSfx.shatter(); rankSfx.impact(); }
      oldRef.current?.querySelectorAll(".ru-shard").forEach((s, i) => A(s,
        [{ transform: "none", opacity: 1 }, { transform: `translate(${DIRS[i][0] * 150}px, ${DIRS[i][1] * 110 + 60}px) rotate(${DIRS[i][0] * 38}deg)`, opacity: 0 }],
        { duration: 800, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" }));
      for (const d of [0, 160]) {
        A(ringRef.current, [{ transform: "scale(.3)", opacity: 0.9 }, { transform: "scale(2.8)", opacity: 0 }], { duration: 950, delay: d, easing: "cubic-bezier(.1,.7,.3,1)" });
      }
      const parts = partsRef.current;
      if (parts) {
        for (let i = 0; i < (kind === "tier" ? 46 : 22); i++) {
          const p = document.createElement("i");
          parts.appendChild(p);
          const a = Math.random() * Math.PI * 2, dist = 120 + Math.random() * 220, s = 0.5 + Math.random();
          A(p, [
            { transform: `translate(-50%,-50%) rotate(45deg) scale(${s})`, opacity: 1 },
            { transform: `translate(calc(-50% + ${Math.cos(a) * dist}px), calc(-50% + ${Math.sin(a) * dist + 60}px)) rotate(${200 + Math.random() * 300}deg) scale(${s * 0.4})`, opacity: 0 },
          ], { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.15,.75,.35,1)", fill: "forwards" });
        }
      }
      A(newRef.current, [
        { transform: "scale(.3) rotateY(540deg)", opacity: 0 },
        { transform: "scale(1.16) rotateY(0deg)", opacity: 1, offset: 0.75 },
        { transform: "scale(1) rotateY(0deg)", opacity: 1 },
      ], { duration: 1000, easing: "cubic-bezier(.2,.8,.25,1)", fill: "forwards" });
      A(raysRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 900, delay: 300, fill: "forwards" });
      if (snd) timers.push(window.setTimeout(() => rankSfx.promo(kind === "tier"), 250));
      await wait(700);
      if (!alive) return;
      A(kickerRef.current, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 350, fill: "forwards" });
      await wait(180);
      if (!alive) return;
      A(nameRef.current, [{ opacity: 0, letterSpacing: ".4em" }, { opacity: 1, letterSpacing: "-.02em" }], { duration: 600, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
      await wait(450);
      if (!alive) return;
      rewardsRef.current?.querySelectorAll(".ru-rew").forEach((r, i) => {
        if (snd) timers.push(window.setTimeout(() => rankSfx.reward(), i * 140));
        A(r, [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: 380, delay: i * 140, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
      });
      await wait(300 + rewardCount * 140);
      if (!alive) return;
      setReady(true);
    })();

    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
      anims.forEach((a) => a.cancel());
    };
    // One request is one overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  useEffect(() => {
    if (!ready) return;
    const b = btnRef.current;
    if (!b) return;
    if (!reducedMotion()) b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: "forwards" });
    else b.style.opacity = "1";
    b.focus({ preventScroll: true });
  }, [ready]);

  const collect = async () => {
    if (closing.current) return;
    closing.current = true;
    const coinEl = coinRef.current;
    const coinRect = coinEl?.getBoundingClientRect() ?? null;
    onCollect({ coinRect, coins: rew.coins });
    const root = rootRef.current;
    if (root && !reducedMotion()) {
      // The reward empties as its coins take off, then the overlay fades behind the flight.
      coinEl?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" });
      await root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, delay: 60, easing: "ease-out", fill: "forwards" }).finished.catch(() => {});
    }
    onClosed();
  };

  // Escape or Enter collects once the button is there; keys never reach the game behind.
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (ready) void collect();
    }
  };

  const c = tierColor(to.tier);
  const toDiv = to.tier >= 6 ? null : to.division;
  return (
    <div
      ref={rootRef}
      className="ru"
      role="dialog"
      aria-modal="true"
      aria-label={`${kind === "tier" ? "Promoted to" : "Division up,"} ${rankLabel(to)}`}
      style={{ "--c": c } as CSSProperties}
      onKeyDown={onKey}
      tabIndex={-1}
    >
      <div className="ru-stage" aria-hidden="true">
        <div ref={raysRef} className="ru-rays">
          {Array.from({ length: 16 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 22.5}deg)` }} />)}
        </div>
        <div ref={ringRef} className="ru-ring" />
        <div ref={oldRef} className="ru-old">
          {QUADS.map((q, i) => (
            <div key={i} className="ru-shard" style={{ clipPath: q }}>
              <RankBadge tier={req.from.tier} division={req.from.tier >= 6 ? null : req.from.division} size={EMBLEM} label="" />
            </div>
          ))}
        </div>
        <div ref={newRef} className="ru-new">
          <RankBadge tier={to.tier} division={toDiv} size={EMBLEM} label="" />
        </div>
        <div ref={partsRef} className="ru-parts" />
      </div>
      <div ref={kickerRef} className="ru-kicker">{kind === "tier" ? "Promoted" : "Division up"}</div>
      <div ref={nameRef} className="ru-name">{rankLabel(to)}</div>
      <div ref={rewardsRef} className="ru-rewards">
        {rew.coins > 0 && (
          <div ref={coinRef} className="ru-rew">
            <Coin size={26} />
            <div>{fmtCoins(rew.coins)}<small>coins</small></div>
          </div>
        )}
        {rew.boxes.map(([box, count]) => (
          <div key={box} className={`ru-rew ru-box-${box}`}>
            <span className="ru-parcel" aria-hidden="true" dangerouslySetInnerHTML={{ __html: parcelHtml(box, 40) }} />
            <div>{count > 1 ? `${count} x ` : ""}{BOX_NAMES[box]}<small>free to open</small></div>
          </div>
        ))}
        {rew.title && (
          <div className="ru-rew">
            <Crown size={22} className="ru-crown" aria-hidden="true" />
            <div><span className="rk-title r-rank">{rew.title}</span><small>title, equipped</small></div>
          </div>
        )}
      </div>
      <button ref={btnRef} type="button" className="btn btn-primary ru-btn" disabled={!ready} onClick={() => void collect()}>
        Collect
      </button>
    </div>
  );
}
