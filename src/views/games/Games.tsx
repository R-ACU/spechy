// Games tab: a hub of small games with pixel-art covers. Picking one grows its cover into
// the play area with a short pixel progress bar (about half a second, no flashes), while
// the game module loads lazily; Back or Escape returns to the hub. A game added in an update is
// revealed once when the hub first lists it: veiled card, fanfare, cover dissolving in, a small
// pop and pixel confetti (no flashes), then a "New" badge until it is played.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowLeft, Gamepad2, Keyboard, Mic, MousePointerClick, Sparkles, Store, Trophy, UserRound, type LucideIcon } from "lucide-react";
import { useStore } from "../../lib/store";
import type { GameAward } from "../../lib/ipc";
import { awardGame, holdBalance, loadEconomy } from "../../lib/economy";
import { checkWeeklyPayout, onPendingPayout, payoutMessage, takePendingPayouts } from "../../lib/payout";
import { setThemePreview } from "../../themes/preview";
import { flyCoins } from "./economy/flyCoins";
import { bestText, GAMES, isNewGame, markPlayed, markRevealed, needsReveal, readAllBests, type GameInfo, type GameModule, type RoundResult, type SoundControl } from "./catalog";
import { paintCover } from "./covers";
import { dissolveIn, playFanfare } from "./reveal";
import { CoinChip } from "./economy/Coin";
import ResultsCard from "./economy/ResultsCard";
import { configureSfx } from "./economy/sfx";
import SoundMenu from "./SoundMenu";
import GameTitle from "./GameTitle";
import "./games.css";
import "./economy/economy.css";

const Leaderboard = lazy(() => import("./leaderboard/Leaderboard"));
const Shop = lazy(() => import("./shop/Shop"));
const Profile = lazy(() => import("./profile/Profile"));

/** Top navigation inside Games. Coins, shop and leaderboard live only here. */
type Tab = "play" | "leaderboard" | "shop" | "profile";
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "play", label: "Play", icon: Gamepad2 },
  { id: "leaderboard", label: "Leaderboard", icon: Trophy },
  { id: "shop", label: "Shop", icon: Store },
  { id: "profile", label: "Profile", icon: UserRound },
];

function GamesNav({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  // Hover is tracked per tab in script: a CSS :hover can stay stuck on a tab the pointer left
  // while the layout changed under it (tab switch), so only the pointer events decide.
  const [hot, setHot] = useState<Tab | null>(null);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    onTab(next.id);
    (e.currentTarget.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="g-tabs" role="tablist" aria-label="Games" onKeyDown={onKey} onPointerLeave={() => setHot(null)}>
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-tab={id}
          aria-selected={tab === id}
          tabIndex={tab === id ? 0 : -1}
          className={`g-tab ${tab === id ? "on" : ""} ${hot === id ? "hot" : ""}`}
          onPointerEnter={(e) => setHot(e.pointerType === "mouse" ? id : null)}
          onPointerLeave={() => setHot((h) => (h === id ? null : h))}
          onPointerCancel={() => setHot(null)}
          onMouseDown={(e) => e.preventDefault()} // a click must not leave :focus on the tab
          onClick={() => onTab(id)}
        >
          <Icon size={17} strokeWidth={2} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** Space and Enter on the results card must not reach the game listeners (Voice Snake listens on window). */
function stopGameKeys(e: ReactKeyboardEvent) {
  if (e.key === " " || e.key === "Enter") e.stopPropagation();
}

interface Box { x: number; y: number; w: number; h: number }
type Mode = { kind: "hub" } | { kind: "play"; id: GameInfo["id"]; from: Box | null };

const SEGMENTS = 10;
const GROW_MS = 460;
const FADE_MS = 200;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Viewport box; the overlay is position: fixed, so scrolling the hub cannot shift it. */
function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function Cover({ id, className = "" }: { id: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) paintCover(ref.current, id, GAMES.find((g) => g.id === id)?.cover); }, [id]);
  return <canvas ref={ref} className={`gm-cover ${className}`} aria-hidden="true" />;
}

const CONTROL_ICON: Record<string, LucideIcon> = { tower: MousePointerClick, snake: Mic };
const REVEAL_DELAY_MS = 900;
const DISSOLVE_MS = 1300;

/** The veiled cover of a game that is about to be revealed; dissolves the real cover in on `go`. */
function RevealCover({ id, go, onDone }: { id: string; go: boolean; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!go || !ref.current) return;
    const src = document.createElement("canvas");
    paintCover(src, id, GAMES.find((g) => g.id === id)?.cover);
    return dissolveIn(ref.current, src, DISSOLVE_MS, () => done.current());
  }, [go, id]);
  return (
    <div className="gm-veil">
      <canvas ref={ref} className="gm-cover gm-veil-canvas" aria-hidden="true" />
      {!go && (
        <span className="gm-veil-label">
          <Sparkles size={18} strokeWidth={2} aria-hidden="true" />
          New game
        </span>
      )}
    </div>
  );
}

/** Pixel confetti over a card, colours from the theme tokens. Removes itself. */
function confetti(card: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const css = getComputedStyle(document.documentElement);
  const colours = ["--accent", "--success", "--warn", "--text"].map((v) => css.getPropertyValue(v).trim()).filter(Boolean);
  const layer = document.createElement("div");
  layer.className = "gm-confetti";
  card.appendChild(layer);
  const w = card.clientWidth;
  for (let i = 0; i < 34; i++) {
    const p = document.createElement("span");
    const size = 4 + Math.round(Math.random() * 3);
    p.style.cssText = `width:${size}px;height:${size}px;left:${Math.round(w * (0.15 + Math.random() * 0.7))}px;top:${Math.round(40 + Math.random() * 60)}px;background:${colours[i % colours.length]}`;
    layer.appendChild(p);
    const dx = (Math.random() - 0.5) * 220, up = 60 + Math.random() * 90, fall = 160 + Math.random() * 140;
    p.animate(
      [
        { transform: "translate(0, 0)", opacity: 1 },
        { transform: `translate(${dx * 0.5}px, ${-up}px)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${dx}px, ${fall}px)`, opacity: 0 },
      ],
      { duration: 1300 + Math.random() * 600, easing: "cubic-bezier(0.2, 0.7, 0.4, 1)", fill: "forwards" },
    );
  }
  window.setTimeout(() => layer.remove(), 2200);
}

function BestLabel({ text }: { text: string }) {
  return (
    <span className="gm-best">
      <Trophy size={14} strokeWidth={2} aria-hidden="true" />
      {text}
    </span>
  );
}

/** The cover that grows from its card into the play area, then fades onto the game. */
function EnterOverlay({ id, from, stage, loaded, onDone }: {
  id: string; from: Box; stage: HTMLElement; loaded: boolean; onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [grown, setGrown] = useState(false);
  const [filled, setFilled] = useState(1);
  const done = useRef(onDone);
  done.current = onDone;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const to = boxOf(stage);
    Object.assign(el.style, { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px` });
    const anim = el.animate(
      [
        { left: `${from.x}px`, top: `${from.y}px`, width: `${from.w}px`, height: `${from.h}px`, borderRadius: "12px" },
        { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px`, borderRadius: "16px" },
      ],
      { duration: GROW_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "both" },
    );
    anim.finished.then(() => setGrown(true), () => {});
    return () => anim.cancel();
  }, [from, stage]);

  // The bar steps up while the cover grows and holds one segment back until the module is in.
  useEffect(() => {
    const t = window.setInterval(() => setFilled((n) => Math.min(loaded ? SEGMENTS : SEGMENTS - 1, n + 1)), GROW_MS / SEGMENTS);
    return () => window.clearInterval(t);
  }, [loaded]);

  useEffect(() => {
    if (!grown || !loaded || filled < SEGMENTS) return;
    const el = ref.current;
    if (!el) return;
    const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, delay: 60, easing: "ease-out", fill: "forwards" });
    fade.finished.then(() => done.current(), () => {});
    return () => fade.cancel();
  }, [grown, loaded, filled]);

  return (
    <div ref={ref} className="gm-enter" aria-hidden="true">
      <Cover id={id} className="gm-enter-cover" />
      <div className="gm-progress">
        {Array.from({ length: SEGMENTS }, (_, i) => <span key={i} className={i < filled ? "on" : ""} />)}
      </div>
    </div>
  );
}

/** Fly the Monday payout from the payout card (Leaderboard tab) or the page title into the chip. */
function landPayouts(toast: ReturnType<typeof useStore>["toast"]) {
  const list = takePendingPayouts();
  if (list.length === 0) return;
  const total = list.reduce((n, p) => n + p.coins, 0);
  for (const p of list) if (!p.toasted) toast({ kind: "success", message: payoutMessage(p) });
  const from = document.querySelector(".rk-pay") ?? document.querySelector(".gm-root .page-title");
  if (!from) { holdBalance(null); return; }
  void flyCoins(from.getBoundingClientRect(), total, 12).done.then(() => holdBalance(null));
}

export default function Games() {
  const { settings, toast } = useStore();
  const [mode, setMode] = useState<Mode>({ kind: "hub" });
  // Games still waiting for their reveal (taken once when the hub opens), and the one revealing now.
  const [veiled, setVeiled] = useState<string[]>(() => GAMES.filter((g) => needsReveal(g.id)).map((g) => g.id));
  const [revealing, setRevealing] = useState<string | null>(null);
  const [, refreshBadges] = useState(0);
  const [mod, setMod] = useState<GameModule | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [overlay, setOverlay] = useState(false);
  // Records by storage key; a game with modes (Voice Snake) has one per mode.
  const [best, setBest] = useState<Record<string, number>>(readAllBests);
  /** The record the play header shows; null shows all records of the game. */
  const [headerKey, setHeaderKey] = useState<string | null>(null);
  /** Sound toggle published by the open game; null when it has none. */
  const [sound, setSound] = useState<SoundControl | null>(null);
  /** The last sound state the open game published; the reward sounds follow it. */
  const soundRef = useRef<SoundControl | null>(null);
  const [tab, setTab] = useState<Tab>("play");
  /** Results card of the last round; over the stage while playing, floating over the hub after leaving. */
  const [result, setResult] = useState<{ award: GameAward; best: number } | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const coverRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const lastId = useRef<string | null>(null);
  const [, forceStage] = useState(0);

  const open = useCallback((game: GameInfo) => {
    const cover = coverRefs.current[game.id];
    const from = cover && !prefersReducedMotion() ? boxOf(cover) : null;
    lastId.current = game.id;
    markPlayed(game.id);
    setMod(null);
    setLoadError(false);
    setHeaderKey(null);
    setSound(null);
    soundRef.current = null;
    setResult(null);
    setOverlay(!!from);
    setMode({ kind: "play", id: game.id, from });
    game.load().then((m) => setMod(() => m), () => setLoadError(true));
  }, []);

  const back = useCallback(() => {
    setMode({ kind: "hub" });
    setSound(null);
    setMod(null);
    setOverlay(false);
    setBest(readAllBests());
  }, []);

  const publishSound = useCallback((c: SoundControl | null) => {
    setSound(c);
    if (c) soundRef.current = c;
  }, []);

  useEffect(() => { void loadEconomy().catch(() => {}); }, []);

  // Monday payout: checked on every visit (one request a week at most, none before joining).
  // Coins fly in once the hub is on screen; payouts found at app start wait here.
  const hubShown = mode.kind === "hub";
  useEffect(() => { void checkWeeklyPayout(toast, false); }, [toast]);
  useEffect(() => {
    if (!hubShown) return;
    let t = window.setTimeout(() => landPayouts(toast), 350);
    const off = onPendingPayout(() => { window.clearTimeout(t); t = window.setTimeout(() => landPayouts(toast), 350); });
    return () => { off(); window.clearTimeout(t); };
  }, [hubShown, toast]);

  // A theme preview from the shop ends with the Shop tab and with the Games page.
  useEffect(() => { if (tab !== "shop") setThemePreview(null); }, [tab]);
  useEffect(() => () => setThemePreview(null), []);

  // A round ended or was left: award coins and RP, then show the results card. Runs also
  // while the game unmounts (leaving mid round), so it reads everything through refs.
  const onRoundEnd = useCallback((r: RoundResult) => {
    const game = GAMES.find((g) => g.id === lastId.current);
    if (!game) return;
    const snd = soundRef.current;
    configureSfx(settingsRef.current.sounds !== false && (snd ? snd.on : true), snd?.volume ?? 0.8);
    awardGame(game.id, r.score, r.newBest, r.quit).then(
      (award) => {
        const bests = readAllBests();
        const best = Math.max(r.score, ...game.bests.map((b) => bests[b.key] ?? 0));
        setResult({ award, best });
      },
      () => { /* no backend: the round still counts for the records */ },
    );
  }, []);

  const playAgain = useCallback(() => {
    setResult(null);
    const stage = stageRef.current;
    if (!stage) return;
    // Same as pressing Space in the game: tower, comet and snake all restart from game over.
    const panel = (stage.querySelector('[tabindex="0"]') as HTMLElement | null) ?? stage;
    panel.focus({ preventScroll: true });
    panel.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }));
  }, []);

  // Escape leaves a game, unless a dialog (Settings) is open on top.
  useEffect(() => {
    if (mode.kind !== "play") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode.kind, back]);

  // Back in the hub: focus the card of the game that was just left.
  useEffect(() => {
    if (mode.kind === "hub" && lastId.current) cardRefs.current[lastId.current]?.focus({ preventScroll: true });
  }, [mode.kind]);

  // The overlay needs the stage element, which exists only after the first play render.
  useLayoutEffect(() => { if (mode.kind === "play" && overlay) forceStage((n) => n + 1); }, [mode, overlay]);

  const onBest = useCallback((value: number, key?: string) => {
    const game = GAMES.find((g) => g.id === lastId.current);
    const slot = key ?? game?.bests[0]?.key;
    if (slot) setBest((b) => ({ ...b, [slot]: Math.max(b[slot] ?? 0, value) }));
  }, []);

  // A reveal needs its card on screen: switching to another tab mid reveal starts it over later.
  useEffect(() => { if (tab !== "play") setRevealing(null); }, [tab]);

  // Reveal veiled games one after another while the hub (Play tab) is shown.
  useEffect(() => {
    if (mode.kind !== "hub" || tab !== "play" || revealing || veiled.length === 0) return;
    const id = veiled[0];
    if (prefersReducedMotion()) {
      markRevealed(id);
      setVeiled((v) => v.filter((x) => x !== id));
      return;
    }
    const t = window.setTimeout(() => {
      setRevealing(id);
      if (settings.sounds !== false) playFanfare();
    }, REVEAL_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [mode.kind, tab, revealing, veiled, settings.sounds]);

  const finishReveal = useCallback((id: string) => {
    markRevealed(id);
    const card = cardRefs.current[id];
    if (card && !prefersReducedMotion()) {
      card.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.035) translateY(-4px)", offset: 0.35 }, { transform: "scale(1)" }],
        { duration: 620, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      confetti(card);
    }
    setVeiled((v) => v.filter((x) => x !== id));
    setRevealing(null);
    refreshBadges((n) => n + 1);
  }, []);

  if (mode.kind === "play") {
    const game = GAMES.find((g) => g.id === mode.id)!;
    const Game = mod?.default;
    return (
      <section ref={rootRef} className="page gm-root gm-root-play">
        <header className="gm-play-head">
          <button className="btn btn-ghost btn-sm gm-back" onClick={back}>
            <ArrowLeft size={16} aria-hidden="true" />
            Games
          </button>
          <h1 className="gm-play-title"><GameTitle game={game.id} size="header" /></h1>
          <div className="gm-head-end">
            <BestLabel text={bestText(game, best, headerKey)} />
            {sound && <SoundMenu control={sound} />}
            <span className="gm-head-sep" aria-hidden="true" />
            <CoinChip />
          </div>
        </header>
        <div ref={stageRef} className={`gm-stage ${overlay ? "" : "gm-stage-fade"}`}>
          {loadError ? (
            <div className="gm-stage-msg">
              <p>This game could not be loaded.</p>
              <button className="btn btn-secondary btn-sm" onClick={() => open(game)}>Try again</button>
            </div>
          ) : Game ? <Game onBest={onBest} onBestKey={setHeaderKey} onSound={publishSound} onRoundEnd={onRoundEnd} /> : null}
          {result && (
            <div className="sr-layer" onKeyDown={stopGameKeys}>
              <ResultsCard
                award={result.award}
                best={result.best}
                onBack={() => { setResult(null); back(); }}
                onAgain={playAgain}
              />
            </div>
          )}
        </div>
        {overlay && mode.from && stageRef.current && (
          <EnterOverlay
            id={game.id}
            from={mode.from}
            stage={stageRef.current}
            loaded={!!mod || loadError}
            onDone={() => setOverlay(false)}
          />
        )}
      </section>
    );
  }

  return (
    <section ref={rootRef} className="page gm-root" data-revealing={revealing ?? undefined}>
      <div className="page-head gm-head">
        <div>
          <h1 className="page-title">Games</h1>
          <p className="gm-sub">Small breaks between dictations.</p>
        </div>
        <CoinChip onClick={() => { setTab("shop"); setResult(null); }} />
      </div>
      <GamesNav tab={tab} onTab={(t) => { setTab(t); setResult(null); }} />
      {result && (
        <div className="sr-float-layer" onKeyDown={stopGameKeys}>
          <ResultsCard
            award={result.award}
            best={result.best}
            floating
            onBack={() => setResult(null)}
            onAgain={() => {
              const g = GAMES.find((x) => x.id === result.award.game);
              setResult(null);
              if (g) open(g);
            }}
          />
        </div>
      )}
      {tab !== "play" && (
        <Suspense fallback={null}>
          {tab === "leaderboard" && <Leaderboard />}
          {tab === "shop" && <Shop />}
          {tab === "profile" && <Profile />}
        </Suspense>
      )}
      {tab === "play" && <div className="gm-grid">
        {GAMES.map((game, i) => {
          const Icon = CONTROL_ICON[game.id] ?? Keyboard;
          const hidden = veiled.includes(game.id);
          const showNew = !hidden && isNewGame(game.id);
          return (
            <button
              key={game.id}
              ref={(el) => { cardRefs.current[game.id] = el; }}
              className={`gm-card ${hidden ? "gm-card-veiled" : ""}`}
              style={{ animationDelay: `${i * 50}ms` }}
              disabled={hidden}
              onClick={() => open(game)}
              onPointerEnter={() => { void game.load().catch(() => {}); }}
              onFocus={() => { void game.load().catch(() => {}); }}
            >
              <div className="gm-cover-wrap" ref={(el) => { coverRefs.current[game.id] = el; }}>
                {hidden ? (
                  <RevealCover id={game.id} go={revealing === game.id} onDone={() => finishReveal(game.id)} />
                ) : (
                  <Cover id={game.id} />
                )}
                {showNew && <span className="gm-new">New</span>}
              </div>
              <div className="gm-card-body">
                <span className="gm-card-title">{hidden ? "New game" : <GameTitle game={game.id} size="card" />}</span>
                <span className="gm-card-line">{hidden ? "Something new just arrived." : game.tagline}</span>
                <span className="gm-card-meta">
                  <BestLabel text={bestText(game, best)} />
                  <span className="gm-controls">
                    <Icon size={14} strokeWidth={2} aria-hidden="true" />
                    {game.controls}
                  </span>
                </span>
              </div>
            </button>
          );
        })}
      </div>}
    </section>
  );
}
