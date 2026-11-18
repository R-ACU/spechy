// Games tab: a hub of small games with pixel-art covers. Picking one grows its cover into
// the play area with a short pixel progress bar (about half a second, no flashes), while
// the game module loads lazily; Back or Escape returns to the hub. A game added in an update is
// revealed once when the hub first lists it: veiled card, fanfare, cover dissolving in, a small
// pop and pixel confetti (no flashes), then a "New" badge until it is played.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Keyboard, Mic, MousePointerClick, Sparkles, Trophy, type LucideIcon } from "lucide-react";
import { useStore } from "../../lib/store";
import { bestText, GAMES, isNewGame, markPlayed, markRevealed, needsReveal, readAllBests, type GameInfo, type GameModule } from "./catalog";
import { paintCover } from "./covers";
import { dissolveIn, playFanfare } from "./reveal";
import "./games.css";

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

export default function Games() {
  const { settings } = useStore();
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
    setOverlay(!!from);
    setMode({ kind: "play", id: game.id, from });
    game.load().then((m) => setMod(() => m), () => setLoadError(true));
  }, []);

  const back = useCallback(() => {
    setMode({ kind: "hub" });
    setMod(null);
    setOverlay(false);
    setBest(readAllBests());
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

  // Reveal veiled games one after another while the hub is shown.
  useEffect(() => {
    if (mode.kind !== "hub" || revealing || veiled.length === 0) return;
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
  }, [mode.kind, revealing, veiled, settings.sounds]);

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
          <h1 className="gm-play-title">{game.title}</h1>
          <BestLabel text={bestText(game, best, headerKey)} />
        </header>
        <div ref={stageRef} className={`gm-stage ${overlay ? "" : "gm-stage-fade"}`}>
          {loadError ? (
            <div className="gm-stage-msg">
              <p>This game could not be loaded.</p>
              <button className="btn btn-secondary btn-sm" onClick={() => open(game)}>Try again</button>
            </div>
          ) : Game ? <Game onBest={onBest} onBestKey={setHeaderKey} /> : null}
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
      </div>
      <div className="gm-grid">
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
                <span className="gm-card-title">{hidden ? "New game" : game.title}</span>
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
      </div>
    </section>
  );
}
