// Games tab: a hub of small games with pixel-art covers. Picking one grows its cover into
// the play area with a short pixel progress bar (about half a second, no flashes), while
// the game module loads lazily; Back or Escape returns to the hub.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Keyboard, Mic, MousePointerClick, Trophy } from "lucide-react";
import { GAMES, readBest, type GameInfo, type GameModule } from "./catalog";
import { paintCover } from "./covers";
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
  useEffect(() => { if (ref.current) paintCover(ref.current, id); }, [id]);
  return <canvas ref={ref} className={`gm-cover ${className}`} aria-hidden="true" />;
}

const CONTROL_ICON = { tower: MousePointerClick, snake: Mic } as const;

function BestLabel({ best }: { best: number }) {
  return (
    <span className="gm-best">
      <Trophy size={14} strokeWidth={2} aria-hidden="true" />
      {best > 0 ? `Best ${best}` : "No best yet"}
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
  const [mode, setMode] = useState<Mode>({ kind: "hub" });
  const [mod, setMod] = useState<GameModule | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [best, setBest] = useState<Record<string, number>>(() => Object.fromEntries(GAMES.map((g) => [g.id, readBest(g.bestKey)])));
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
    setMod(null);
    setLoadError(false);
    setOverlay(!!from);
    setMode({ kind: "play", id: game.id, from });
    game.load().then((m) => setMod(() => m), () => setLoadError(true));
  }, []);

  const back = useCallback(() => {
    setMode({ kind: "hub" });
    setMod(null);
    setOverlay(false);
    setBest(Object.fromEntries(GAMES.map((g) => [g.id, readBest(g.bestKey)])));
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

  const onBest = useCallback((value: number) => {
    const id = lastId.current;
    if (id) setBest((b) => ({ ...b, [id]: Math.max(b[id] ?? 0, value) }));
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
          <BestLabel best={best[game.id] ?? 0} />
        </header>
        <div ref={stageRef} className={`gm-stage ${overlay ? "" : "gm-stage-fade"}`}>
          {loadError ? (
            <div className="gm-stage-msg">
              <p>This game could not be loaded.</p>
              <button className="btn btn-secondary btn-sm" onClick={() => open(game)}>Try again</button>
            </div>
          ) : Game ? <Game onBest={onBest} /> : null}
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
    <section ref={rootRef} className="page gm-root">
      <div className="page-head gm-head">
        <div>
          <h1 className="page-title">Games</h1>
          <p className="gm-sub">Small breaks between dictations.</p>
        </div>
      </div>
      <div className="gm-grid">
        {GAMES.map((game, i) => {
          const Icon = CONTROL_ICON[game.id] ?? Keyboard;
          return (
            <button
              key={game.id}
              ref={(el) => { cardRefs.current[game.id] = el; }}
              className="gm-card"
              style={{ animationDelay: `${i * 50}ms` }}
              onClick={() => open(game)}
              onPointerEnter={() => { void game.load().catch(() => {}); }}
              onFocus={() => { void game.load().catch(() => {}); }}
            >
              <div className="gm-cover-wrap" ref={(el) => { coverRefs.current[game.id] = el; }}>
                <Cover id={game.id} />
              </div>
              <div className="gm-card-body">
                <span className="gm-card-title">{game.title}</span>
                <span className="gm-card-line">{game.tagline}</span>
                <span className="gm-card-meta">
                  <BestLabel best={best[game.id] ?? 0} />
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
