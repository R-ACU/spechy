// The casino opening of a title box. Presentation only: the roll happened in the backend
// (economy_open_box) before the show starts, and the show just builds suspense around it.
//   1. charge: the parcel rattles harder while a local glow climbs through the rarity colours up
//      to the real rarity and stops there (never above it, no rarity word before the reveal).
//   2. open: the parcel tears (bag) or flips its flaps (boxes), a beam and rays in that colour.
//   3. reel: one deceleration curve that ends exactly on the winning card; nothing moves after it
//      first comes to rest. The bait is only the neighbours: a legendary right before the win
//      (the reel crawls past it just before it stops) and a high card right after it. Ticks rise
//      in pitch while the reel slows, a heartbeat slows down.
//   4. celebrate in proportion to the rarity; duplicates fly their refund to the coin chip.
// Click anywhere outside the buttons to skip. Reduced motion shows the result directly.
// No full-screen flash anywhere: the overlay only blurs, all light stays local to the parcel or card.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Sparkles } from "lucide-react";
import type { BoxId, BoxOpening as Opening, TitleRarity } from "../../../lib/ipc";
import { economySnapshot, equipItem, fmtCoins, holdBalance, openBox, setEconomyState } from "../../../lib/economy";
import { useStore } from "../../../lib/store";
import { Coin } from "../economy/Coin";
import { flyCoins } from "../economy/flyCoins";
import { configureSfx } from "../economy/sfx";
import { openParcel, parcelHtml, PARCEL_TRIM } from "./parcels";
import { openSfx as sfx } from "./openSfx";
import { BOX_INFO, pickTitle, RARITIES, RARITY_NAME, REFUND, rollShown } from "./titles";

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Props {
  boxId: BoxId;
  onClose: () => void;
  /** Open the same box again (the parent remounts the overlay). */
  onAgain: () => void;
}

interface Done { opening: Opening }

export default function BoxOpening({ boxId, onClose, onAgain }: Props) {
  const { toast, settings } = useStore();
  const info = BOX_INFO.find((b) => b.id === boxId)!;
  const rootRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<() => void>(() => {});
  const [live, setLive] = useState(true);
  const [done, setDone] = useState<Done | null>(null);
  const [actions, setActions] = useState(false);
  const closing = useRef(false);
  // One backend roll per mount, even when React runs the effect twice (StrictMode in dev).
  const roll = useRef<Promise<Opening> | null>(null);

  useEffect(() => {
    const root = rootRef.current!;
    const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const reduce = reducedMotion();
    root.focus({ preventScroll: true });
    const gx = { skip: reduce, live: !reduce, wakers: [] as (() => void)[], dead: false };
    const rc = (r: TitleRarity) => getComputedStyle(root).getPropertyValue(`--rarity-${r}`).trim() || "#999999";
    const wait = (ms: number) => new Promise<void>((res) => {
      if (gx.skip || gx.dead) return res();
      const wake = () => { clearTimeout(t); gx.wakers = gx.wakers.filter((f) => f !== wake); res(); };
      const t = window.setTimeout(wake, ms);
      gx.wakers.push(wake);
    });
    const A = (el: Element, kf: Keyframe[], o: KeyframeAnimationOptions) =>
      el.animate(kf, gx.skip ? { ...o, duration: 1, delay: 0, iterations: 1 } : o);
    const finished = (a: Animation) => a.finished.then(() => {}, () => {});
    const pulse = (el: Element, c: string, iterations = 2, dur = 800) => A(el, [
      { boxShadow: `0 0 0 2px ${c}, 0 0 0 10px color-mix(in srgb, ${c} 18%, transparent), 0 0 0 22px color-mix(in srgb, ${c} 7%, transparent)` },
      { boxShadow: `0 0 0 2px ${c}, 0 0 0 16px color-mix(in srgb, ${c} 23%, transparent), 0 0 34px 18px color-mix(in srgb, ${c} 19%, transparent)` },
      { boxShadow: `0 0 0 2px ${c}, 0 0 0 10px color-mix(in srgb, ${c} 18%, transparent), 0 0 0 22px color-mix(in srgb, ${c} 7%, transparent)` },
    ], { duration: dur, iterations, easing: "ease-in-out" });

    const parts = $(".gx-parts");
    const burst = (x: number, y: number, color: string, n: number, gold: boolean) => {
      if (reduce) return;
      for (let i = 0; i < n; i++) {
        const p = document.createElement("i");
        parts.appendChild(p);
        p.style.left = `${x}px`;
        p.style.top = `${y}px`;
        p.style.background = gold && i % 3 === 0 ? "#fff1c9" : color;
        const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * (gold ? 380 : 240), s = 0.6 + Math.random() * 1.1;
        p.animate([
          { transform: `translate(-50%,-50%) scale(${s})`, opacity: 1 },
          { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + 90}px)) rotate(${Math.random() * 540}deg) scale(${s * 0.3})`, opacity: 0 },
        ], { duration: 1000 + Math.random() * 700, easing: "cubic-bezier(.15,.75,.35,1)", fill: "forwards" }).onfinish = () => p.remove();
      }
    };
    /* gold confetti for a legendary: falls through the reel area only, never across the whole window */
    const confetti = (rect: DOMRect, n: number) => {
      if (reduce) return;
      const cols = ["#ffc46b", "#ffe2a3", "#f2a93b", "#fff1c9"];
      for (let i = 0; i < n; i++) {
        const p = document.createElement("i");
        parts.appendChild(p);
        p.style.left = `${rect.left + Math.random() * rect.width}px`;
        p.style.top = `${rect.top - 70 - Math.random() * 90}px`;
        p.style.background = cols[i % 4];
        p.style.width = "6px";
        p.style.height = "10px";
        const fall = rect.height + 200 + Math.random() * 140, sway = (Math.random() - 0.5) * 120, rot = (Math.random() - 0.5) * 900;
        p.animate([
          { transform: "translate(-50%,-50%) rotate(0deg)", opacity: 0 },
          { transform: `translate(calc(-50% + ${sway * 0.2}px), ${fall * 0.12}px) rotate(${rot * 0.15}deg)`, opacity: 1, offset: 0.12 },
          { transform: `translate(calc(-50% + ${sway}px), ${fall}px) rotate(${rot}deg)`, opacity: 0 },
        ], { duration: 1900 + Math.random() * 900, delay: Math.random() * 500, easing: "cubic-bezier(.3,.4,.6,1)", fill: "forwards" }).onfinish = () => p.remove();
      }
    };

    skipRef.current = () => {
      if (!gx.live || gx.skip) return;
      gx.skip = true;
      setLive(false);
      gx.wakers.slice().forEach((f) => f());
      root.getAnimations({ subtree: true }).forEach((a) => {
        if (a.effect?.getTiming().iterations !== Infinity) { try { a.finish(); } catch { /* not finishable */ } }
      });
    };

    const run = async () => {
      configureSfx(settings.sounds !== false, 0.8);
      let opening: Opening;
      try {
        roll.current ??= openBox(boxId);
        opening = await roll.current;
      } catch (e) {
        if (gx.dead) return;
        toast({ kind: "error", message: String(e).replace(/^Error:\s*/, "") });
        holdBalance(null);
        onClose();
        return;
      }
      if (gx.dead) return;
      // The chip shows the balance after paying; a duplicate refund flies in at the end.
      holdBalance(opening.state.balance - opening.refund - economySnapshot().reserve);

      const rar = opening.rarity, title = opening.title;
      const R = Math.random, ri = RARITIES.indexOf(rar);
      // The glow climbs grey, blue, purple, gold, but only up to the real rarity, and rests there.
      const steps: number[] = [];
      for (let i = 0; i <= ri; i++) steps.push(i);

      // 1. charge (1.6 s)
      const wrap = $(".gx-boxwrap"), pkg = wrap.querySelector<HTMLElement>(".pkg")!;
      const pips = Array.from(root.querySelectorAll<HTMLElement>(".gx-pips i"));
      const SHAKE = 1600;
      if (!gx.skip) sfx.rattle(SHAKE / 1000);
      A(pkg, [0, -1, 1, -2, 2, -3, 3, -4, 4, -6, 6, -3, 0].map((r, i) => ({ transform: `rotate(${r}deg) translateY(${-i * 0.5}px) scale(${1 + i * 0.006})` })), { duration: SHAKE, easing: "ease-in" });
      requestAnimationFrame(() => wrap.classList.add("glow"));
      const per = Math.min(280, (SHAKE - 450) / Math.max(1, steps.length - 1));
      for (let k = 0; k < steps.length && !gx.skip; k++) {
        const s = steps[k];
        wrap.style.setProperty("--gc", `var(--rarity-${RARITIES[s]})`);
        wrap.classList.toggle("hot", s === 3);
        pips.forEach((p, j) => p.classList.toggle("on", j <= s));
        sfx.climb(s);
        if (s === 3) sfx.tease();
        await wait(k === steps.length - 1 ? SHAKE - per * (steps.length - 1) : per);
      }
      // 2. open (0.9 s)
      if (!gx.skip) {
        sfx.pop();
        A($(".gx-beam"), [{ opacity: 0, transform: "scaleY(.2)" }, { opacity: 0.3 + ri * 0.1, transform: "scaleY(1)" }, { opacity: 0, transform: "scaleY(1.1)" }], { duration: 900, easing: "ease-out" });
        A($(".gx-rays"), [{ opacity: 0 }, { opacity: 0.5 + ri * 0.17 }, { opacity: 0 }], { duration: 1000 });
        const cr = pkg.getBoundingClientRect();
        burst(cr.left + cr.width / 2, cr.top + cr.height * 0.3, PARCEL_TRIM[boxId], 14 + ri * 12, ri === 3);
        await Promise.race([openParcel(pkg, boxId, { shake: false }), wait(800)]);
        await wait(180);
        if (!gx.skip) sfx.whoosh();
      }
      await finished(A(wrap, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.3)", opacity: 0 }], { duration: 240, easing: "ease-in", fill: "forwards" }));
      if (gx.dead) return;
      wrap.getAnimations().forEach((a) => a.cancel());
      wrap.style.display = "none";

      // 3. the reel (about 4 to 5 s)
      const N = 60, WIN = 52;
      const has = (r: TitleRarity) => info.odds.some(([x]) => x === r);
      // A different title of rarity r than the win (a bait card never shows the won title).
      const L = (r: TitleRarity) => { let t = pickTitle(r); for (let k = 0; k < 6 && t === title; k++) t = pickTitle(r); return { r, t }; };
      const hot = (): TitleRarity => { const x = R(); const r: TitleRarity = x < 0.35 ? "rare" : x < 0.75 ? "epic" : "legendary"; return has(r) ? r : "rare"; };
      const cards = Array.from({ length: N }, (_, i) => L(i >= WIN - 9 && i <= WIN + 4 && R() < 0.5 ? hot() : rollShown(info.odds)));
      cards[WIN] = { r: rar, t: title };
      // Bait through the neighbours only: the reel crawls past a legendary right before the win,
      // and the card after the win is high too, so the stop always reads as "so close".
      cards[WIN - 1] = L("legendary");
      cards[WIN + 1] = L(R() < 0.5 ? "legendary" : "epic");
      cards[WIN - 2] = L(R() < 0.6 ? "epic" : "legendary");
      const track = $(".gx-track"), reel = $(".gx-reel"), marker = $(".gx-marker");
      track.replaceChildren(...cards.map((c) => {
        const el = document.createElement("div");
        el.className = "gx-card";
        el.style.setProperty("--rc", `var(--rarity-${c.r})`);
        const tt = document.createElement("span"); tt.className = "tt"; tt.textContent = c.t;
        const rr = document.createElement("span"); rr.className = "rr"; rr.textContent = RARITY_NAME[c.r];
        el.append(tt, rr);
        return el;
      }));
      reel.style.display = "block";
      A(reel, [{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 260 });
      const pitch = 178, reelW = reel.clientWidth || 920;
      const xAt = (idx: number, off: number) => -(10 + idx * pitch + 84 - reelW / 2 + off);
      // Rest in the left part of the winning card: the marker has only just left the legendary.
      const stop = xAt(WIN, -64 + R() * 52);
      let running = true, lastIdx = -1, lastM = 0, lastT = performance.now(), beating = false;
      const t0 = lastT;
      const heartbeat = async () => { let gap = 420; while (running && !gx.skip && !gx.dead) { sfx.heartbeat(); await wait(gap); gap = Math.min(950, gap * 1.17); } };
      const loop = (now: number) => {
        if (!running || gx.dead) return;
        const m = new DOMMatrix(getComputedStyle(track).transform).m41, v = Math.abs(m - lastM) / Math.max(1, now - lastT);
        lastM = m;
        lastT = now;
        const idx = Math.floor((reelW / 2 - m - 10) / pitch);
        if (idx !== lastIdx) {
          lastIdx = idx;
          if (!gx.skip) {
            sfx.tick(1 + Math.max(0, 1 - v / 1.4) * 1.2);
            A(marker, [{ transform: "scaleX(2.5)" }, { transform: "scaleX(1)" }], { duration: 120 });
          }
        }
        if (!beating && !gx.skip && now - t0 > 1400 && v < 0.5) { beating = true; void heartbeat(); }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      // The only move of the reel: one curve that ends on the result. The final transform is
      // written as a plain style, so nothing (not even a cancelled animation) can move it later.
      const spin = A(track, [{ transform: "translateX(0)" }, { transform: `translateX(${stop}px)` }], { duration: 4200, easing: "cubic-bezier(.06,.72,.1,1)", fill: "forwards" });
      await finished(spin);
      track.style.transform = `translateX(${stop}px)`;
      spin.cancel();
      track.dataset.rest = "1";
      running = false;
      if (gx.dead) return;

      // 4. land and celebrate in proportion to the rarity
      const win = track.children[WIN] as HTMLElement;
      win.classList.add("win");
      A(marker, [{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: "forwards" });
      gx.live = false;
      setLive(false);
      const wr = win.getBoundingClientRect();
      sfx.reveal(rar);
      if (ri >= 2) sfx.fanfare(rar);
      burst(wr.left + wr.width / 2, wr.top + wr.height / 2, rc(rar), [10, 24, 46, 80][ri], ri === 3);
      if (ri >= 2 && !reduce) pulse(win, rc(rar), ri === 3 ? 3 : 2, 900);
      if (ri === 3) confetti(reel.getBoundingClientRect(), 70);
      await wait([150, 260, 360, 450][ri]);
      if (gx.dead) return;
      setDone({ opening });
    };
    void run();
    return () => {
      gx.dead = true;
      gx.wakers.slice().forEach((f) => f());
      // Really gone (tab switch mid show, not a StrictMode re-run): publish the result and free the chip.
      window.setTimeout(() => {
        if (root.isConnected || closing.current) return;
        closing.current = true;
        void roll.current?.then((o) => setEconomyState(o.state), () => {}).finally(() => holdBalance(null));
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After the result is shown: fly a duplicate refund home, then offer the buttons.
  useEffect(() => {
    if (!done) return;
    let alive = true;
    const go = async () => {
      if (!done.opening.isNew && done.opening.refund > 0) {
        await new Promise((r) => setTimeout(r, reducedMotion() ? 0 : 300));
        const note = rootRef.current?.querySelector(".gx-note");
        if (note && alive) await flyCoins(note.getBoundingClientRect(), done.opening.refund, 8).done;
      }
      if (alive) setActions(true);
    };
    void go();
    return () => { alive = false; };
  }, [done]);

  const finish = async (then?: () => void) => {
    if (closing.current) return;
    closing.current = true;
    if (done) setEconomyState(done.opening.state);
    holdBalance(null);
    const el = rootRef.current;
    if (el && !reducedMotion()) await el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" }).finished.catch(() => {});
    (then ?? onClose)();
  };

  const equip = async () => {
    if (!done) return;
    try {
      await equipItem("title", done.opening.title);
      toast({ kind: "success", message: `${done.opening.title} equipped` });
    } catch (e) {
      toast({ kind: "error", message: String(e).replace(/^Error:\s*/, "") });
    }
    void finish();
  };

  const st = done?.opening.state;
  const box = st?.boxes.find((b) => b.id === boxId);
  const canAgain = !!box && (box.keys > 0 || st!.unlimited || st!.balance >= box.price);
  const rar = done?.opening.rarity;

  return (
    <div
      ref={rootRef}
      className={`gx ${live ? "live" : ""}`}
      data-box={boxId}
      role="dialog"
      aria-modal="true"
      aria-label={`Opening the ${info.name}`}
      onClick={(e) => { if (!(e.target as Element).closest("button")) skipRef.current(); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && done) void finish();
        else if ((e.key === " " || e.key === "Enter") && !(e.target as Element).closest("button")) skipRef.current();
      }}
      tabIndex={-1}
    >
      <div className="gx-top">{info.tier} box: {info.name}</div>
      <div className="gx-boxwrap">
        <div className="gx-glow" />
        <div className="gx-rays">{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 20}deg)` }} />)}</div>
        <div className="gx-beam" />
        <div className="gx-pkg" dangerouslySetInnerHTML={{ __html: parcelHtml(boxId, 170) }} />
        <div className="gx-pips">{RARITIES.map((r) => <i key={r} style={{ "--pc": `var(--rarity-${r})` } as CSSProperties} />)}</div>
      </div>
      <div className="gx-reel">
        <div className="gx-track" />
        <div className="gx-shade l" />
        <div className="gx-shade r" />
        <div className="gx-marker" />
      </div>
      <div className={`gx-result ${done ? "on" : ""}`} style={rar ? ({ "--rc": `var(--rarity-${rar})` } as CSSProperties) : undefined} aria-live="polite">
        {done && (
          <>
            <div className="gx-rar">
              {RARITY_NAME[done.opening.rarity]} title
              {done.opening.pityHit && <span className="up"> guaranteed</span>}
            </div>
            <div className="gx-title">{done.opening.title}</div>
            <div className="gx-note">
              {done.opening.isNew
                ? <><Sparkles size={14} aria-hidden="true" />New title for your collection</>
                : <>Duplicate, <Coin size={14} /> {fmtCoins(done.opening.refund || REFUND[done.opening.rarity])} back</>}
            </div>
          </>
        )}
      </div>
      <div className={`gx-actions ${actions ? "on" : ""}`}>
        {actions && done && (
          <>
            {done.opening.isNew && (
              <button type="button" className="btn shop-btn shop-btn-ink" onClick={() => void equip()} autoFocus>
                <Check size={14} aria-hidden="true" />Equip title
              </button>
            )}
            <button type="button" className="btn shop-btn shop-btn-ghost" disabled={!canAgain} onClick={() => void finish(onAgain)}>
              {box && box.keys > 0 ? `Open another (${box.keys} free)` : <>Open another <Coin size={13} /> {fmtCoins(box?.price ?? 0)}</>}
            </button>
            <button type="button" className="btn shop-btn shop-btn-ghost" onClick={() => void finish()} autoFocus={!done.opening.isNew}>Done</button>
          </>
        )}
      </div>
      <div className={`gx-skip ${live && !done ? "on" : ""}`}>Click to skip</div>
      <div className="gx-parts" aria-hidden="true" />
    </div>
  );
}
