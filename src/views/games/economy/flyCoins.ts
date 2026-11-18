// Coins fly from a point straight into the coin of the balance chip (top right of the Games
// page, or of the game header while playing). Short and snappy: each coin follows a shallow
// quadratic curve whose control point sits only a little above the straight line and never
// above the chip, and it ends exactly on the chip's coin icon (same centre, same size). The
// target is measured at launch and again every frame, so a layout shift cannot strand a coin.
// Every arrival adds its share to the shown balance, bumps the chip and clinks.
// Reduced motion: no flight, the amount lands at once.
import { addShown } from "../../../lib/economy";
import { sfx } from "./sfx";

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface Flight {
  done: Promise<void>;
  /** Stop the flight and land whatever is still in the air. */
  cancel: () => void;
}

/** The coin icon inside the visible balance chip (there can be a hidden one in the hub). */
export function chipCoin(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>("[data-coin-chip] .coin");
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

const START_SIZE = 18;
const STAGGER_MS = 55;
/** Flight time grows a little with distance, but stays short. */
const duration = (dist: number) => Math.round(Math.min(620, Math.max(380, 300 + dist * 0.38)));
/** Fast out of the card, then a firm arrival: ease-in-out with a quicker start. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) * 0.85 + t * 0.15;

export function flyCoins(from: DOMRect, amount: number, count = Math.min(14, Math.max(4, Math.round(amount / 4)))): Flight {
  const target = chipCoin();
  const n = Math.max(1, Math.min(count, amount));
  if (amount <= 0) return { done: Promise.resolve(), cancel: () => {} };
  if (!target || reducedMotion()) {
    addShown(amount);
    sfx.coin(0);
    return { done: Promise.resolve(), cancel: () => {} };
  }

  let rect = target.getBoundingClientRect();
  const fx = from.left + from.width / 2, fy = from.top + from.height / 2;
  let given = 0, landed = 0, raf = 0, finished = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  interface C { el: HTMLElement; sx: number; sy: number; bend: number; delay: number; dur: number; landed: boolean }
  const coins: C[] = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement("span");
    el.className = "coin coin-fly";
    el.innerHTML = "<b>S</b>";
    el.style.opacity = "0";
    document.body.appendChild(el);
    // Start in a small cluster on the total; spread is tight so the paths stay parallel.
    const sx = fx + (Math.random() - 0.5) * 26, sy = fy + (Math.random() - 0.5) * 10;
    const dist = Math.hypot(rect.left + rect.width / 2 - sx, rect.top + rect.height / 2 - sy);
    coins.push({ el, sx, sy, bend: 0.06 + Math.random() * 0.06, delay: i * STAGGER_MS, dur: duration(dist), landed: false });
  }

  const land = (i: number) => {
    const share = i === n - 1 ? amount - given : Math.floor(amount / n);
    given += share;
    landed += 1;
    addShown(share);
    sfx.coin(i);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    coins.forEach((c) => c.el.remove());
    resolveDone();
  };

  sfx.whoosh();
  const t0 = performance.now();
  const frame = (now: number) => {
    // Follow the chip if the layout shifted (window resize, header reflow).
    if (target.isConnected) {
      const r = target.getBoundingClientRect();
      if (r.width > 0) rect = r;
    }
    const tx = rect.left + rect.width / 2, ty = rect.top + rect.height / 2, size = rect.width;
    let alive = 0;
    coins.forEach((c, i) => {
      if (c.landed) return;
      const t = (now - t0 - c.delay) / c.dur;
      if (t < 0) { alive++; return; }
      if (t >= 1) {
        c.landed = true;
        c.el.remove();
        land(i);
        return;
      }
      alive++;
      // Control point: midpoint pushed a little to the upper side of the line, never above the chip.
      const dx = tx - c.sx, dy = ty - c.sy, len = Math.hypot(dx, dy) || 1;
      let nx = dy / len, ny = -dx / len;
      if (ny > 0) { nx = -nx; ny = -ny; }
      const off = Math.min(46, len * c.bend);
      const cx = (c.sx + tx) / 2 + nx * off;
      const cy = Math.max(ty, (c.sy + ty) / 2 + ny * off);
      const e = ease(t), u = 1 - e;
      const x = u * u * c.sx + 2 * u * e * cx + e * e * tx;
      const y = u * u * c.sy + 2 * u * e * cy + e * e * ty;
      const s = START_SIZE + (size - START_SIZE) * e;
      const pop = t < 0.12 ? t / 0.12 : 1;
      c.el.style.setProperty("--s", `${s.toFixed(2)}px`);
      c.el.style.opacity = String(pop);
      c.el.style.transform = `translate(${(x - s / 2).toFixed(2)}px, ${(y - s / 2).toFixed(2)}px) scale(${(0.6 + 0.4 * pop).toFixed(3)})`;
    });
    if (alive === 0) finish();
    else raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  const cancel = () => {
    if (finished) return;
    if (landed < n) addShown(amount - given);
    given = amount;
    landed = n;
    finish();
  };
  return { done, cancel };
}
