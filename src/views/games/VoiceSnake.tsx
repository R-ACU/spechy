// Voice Snake: steer by saying up, down, left or right (offline Vosk engine in snake.rs and
// vosk.rs, downloaded once on first use) or with the arrow keys. The recognizer only knows
// the four directions, so the right panel shows the directions it heard as a running row of
// chips, never free text. Hitting a wall or your own tail ends the round. The snake glides
// between cells (drawn every frame from the last two board states) instead of jumping.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ear, Keyboard, Mic, Play, X, type LucideIcon } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readBest, SNAKE_BEST_KEY, type GameProps } from "./catalog";
import "./voice.css";

type Dir = "up" | "down" | "left" | "right";
type Phase = "ready" | "count" | "play" | "paused" | "over";
type Voice =
  | { state: "off" }
  | { state: "starting" }
  | { state: "downloading"; progress: number; mb: number; unpacking: boolean }
  | { state: "on" }
  | { state: "error"; message: string }
  | { state: "unavailable"; message: string };
type SnakeMsg = { session: string } & (
  | { kind: "ready"; cultures: string[]; feed: boolean }
  | { kind: "level"; value: number }
  | { kind: "partial"; text: string }
  | { kind: "heard"; command: Dir; confidence: number; word: string }
  | { kind: "rejected" }
  | { kind: "signal"; problem: string }
  | { kind: "download"; stage: string; progress: number; label: string; mb: number }
  | { kind: "error"; code: string; detail: string }
  | { kind: "closed" }
);
interface Chip { id: number; dir: Dir }
interface Last { id: number; dir: Dir | null }
type Cell = [number, number];
interface Board { body: Cell[]; prev: Cell[]; tickAt: number; dir: Dir; queue: Dir[]; food: Cell; points: number; ms: number; dead: boolean; cause: "wall" | "tail" | null }

const N = 16;
const START_MS = 680;
const MIN_MS = 300;
const STEP_MS = 18;
const COUNT_MS = 650;
const MAX_CHIPS = 36;
const VEC: Record<Dir, Cell> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPP: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
const ICON: Record<Dir, LucideIcon> = { up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight };
const LABEL: Record<Dir, string> = { up: "Up", down: "Down", left: "Left", right: "Right" };
const KEYS: Record<string, Dir> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right",
};
const isDir = (s: string): s is Dir => s === "up" || s === "down" || s === "left" || s === "right";
const ERRORS: Record<string, string> = {
  "download-failed": "The voice model could not be downloaded. Check your internet connection and try again. Arrow keys work meanwhile.",
  "unsupported-platform": "Voice control is not available on this system. Arrow keys work everywhere.",
  "engine-failed": "The speech engine could not start. Arrow keys work meanwhile.",
  "no-mic": "No microphone found. Check the default input device in your sound settings.",
  "mic-busy": "The microphone is busy or blocked. Close other apps that use it and try again.",
};
const SIGNALS: Record<string, string> = {
  NoSignal: "The microphone sends no sound. Check that it is not muted.",
};

function fresh(): Board {
  const body: Cell[] = [[6, 8], [5, 8], [4, 8]];
  return { body, prev: body, tickAt: 0, dir: "right", queue: [], food: [11, 8], points: 0, ms: START_MS, dead: false, cause: null };
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export default function VoiceSnake({ onBest }: GameProps) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [count, setCount] = useState(3);
  const [points, setPoints] = useState(0);
  const [voice, setVoice] = useState<Voice>({ state: "off" });
  const [chips, setChips] = useState<Chip[]>([]);
  const [pending, setPending] = useState<Dir | null>(null);
  const [last, setLast] = useState<Last | null>(null);
  const [level, setLevel] = useState(0);
  const [hint, setHint] = useState("");
  const [size, setSize] = useState(320);
  const sizeRef = useRef(320);
  const voiceRef = useRef<Voice>({ state: "off" });
  const onMsg = useRef<(m: SnakeMsg) => void>(() => {});

  const board = useRef<Board>(fresh());
  const phaseRef = useRef<Phase>("ready");
  const session = useRef("");
  const timers = useRef<number[]>([]);
  const tickTimer = useRef(0);
  const hintTimer = useRef(0);
  const chipId = useRef(0);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const chipsEnd = useRef<HTMLDivElement>(null);
  const bestRef = useRef(onBest);
  bestRef.current = onBest;

  const setPhaseBoth = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);
  const setVoiceBoth = useCallback((v: Voice) => { voiceRef.current = v; setVoice(v); }, []);
  const later = useCallback((fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); }, []);
  const flash = useCallback((text: string) => {
    setHint(text);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(""), 2400);
  }, []);

  // ---------- drawing ----------
  // Board, apple and snake are redrawn every animation frame: the head and the tail are
  // interpolated between the last two board states, everything else sits on cell centres.
  const draw = useCallback((now: number = performance.now()) => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(sizeRef.current * dpr);
    if (cv.width !== px) { cv.width = px; cv.height = px; }
    const g = cv.getContext("2d");
    if (!g) return;
    const cell = px / N;
    const b = board.current;
    const col = {
      grid: token("--border-strong"), body: token("--teal-700"), edge: token("--teal-400"), shine: token("--teal-900"),
      head: token("--success"), apple: token("--warn"), leaf: token("--success"), eye: token("--on-solid"),
      pupil: token("--bg"), tongue: token("--danger"), dead: token("--danger"),
    };
    g.clearRect(0, 0, px, px);

    // grid dots
    g.fillStyle = col.grid;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      g.beginPath();
      g.arc((x + 0.5) * cell, (y + 0.5) * cell, 1.1 * dpr, 0, Math.PI * 2);
      g.fill();
    }

    // apple: round fruit with a leaf and a small highlight, gently breathing
    const pulse = 1 + 0.05 * Math.sin(now / 260);
    const ax = (b.food[0] + 0.5) * cell, ay = (b.food[1] + 0.55) * cell, ar = cell * 0.3 * pulse;
    g.fillStyle = col.apple;
    g.beginPath(); g.arc(ax, ay, ar, 0, Math.PI * 2); g.fill();
    g.fillStyle = col.leaf;
    g.beginPath(); g.ellipse(ax + ar * 0.35, ay - ar * 1.05, ar * 0.42, ar * 0.2, -0.6, 0, Math.PI * 2); g.fill();
    g.fillStyle = col.eye;
    g.globalAlpha = 0.55;
    g.beginPath(); g.arc(ax - ar * 0.35, ay - ar * 0.3, ar * 0.22, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;

    // snake path: interpolated head, exact cell centres, interpolated tail
    const playing = phaseRef.current === "play";
    const k = playing && b.tickAt ? Math.min(1, Math.max(0, (now - b.tickAt) / b.ms)) : 1;
    const centre = (p: Cell): [number, number] => [(p[0] + 0.5) * cell, (p[1] + 0.5) * cell];
    const mix = (p: Cell, q: Cell): [number, number] => [(p[0] + (q[0] - p[0]) * k + 0.5) * cell, (p[1] + (q[1] - p[1]) * k + 0.5) * cell];
    const pts: [number, number][] = [];
    const moved = b.prev !== b.body && b.prev.length > 0 && !b.dead;
    pts.push(moved ? mix(b.prev[0], b.body[0]) : centre(b.body[0]));
    for (let i = 1; i < b.body.length; i++) pts.push(centre(b.body[i]));
    if (moved && b.prev.length === b.body.length) pts.push(mix(b.prev[b.prev.length - 1], b.body[b.body.length - 1]));

    const n = pts.length;
    const width = (i: number) => cell * (0.76 - 0.26 * (i / Math.max(1, n - 1)));
    g.lineCap = "round";
    g.lineJoin = "round";
    // tail to head: a darker edge stroke, the body, then a thin shine line along the back
    const passes: [string, number, number][] = [[col.edge, 2.4 * dpr, 1], [col.body, 0, 1], [col.shine, 0, 0.2]];
    for (const [colour, extra, scale] of passes) {
      g.strokeStyle = colour;
      for (let i = n - 1; i > 0; i--) {
        g.lineWidth = width(i - 1) * scale + extra;
        g.beginPath();
        g.moveTo(pts[i][0], pts[i][1]);
        g.lineTo(pts[i - 1][0], pts[i - 1][1]);
        g.stroke();
      }
    }

    // head with eyes looking where it goes; the tongue flicks now and then; crossed eyes when dead
    const [hx, hy] = pts[0];
    const [dx, dy] = VEC[b.dir];
    const hr = cell * 0.45;
    g.fillStyle = b.dead ? col.dead : col.head;
    g.beginPath(); g.arc(hx, hy, hr, 0, Math.PI * 2); g.fill();
    if (!b.dead && playing && Math.floor(now / 160) % 9 === 0) {
      g.strokeStyle = col.tongue;
      g.lineWidth = 1.6 * dpr;
      g.beginPath();
      g.moveTo(hx + dx * hr, hy + dy * hr);
      g.lineTo(hx + dx * hr * 1.6, hy + dy * hr * 1.6);
      g.stroke();
    }
    const sx = -dy, sy = dx;
    for (const side of [-1, 1]) {
      const ex = hx + dx * hr * 0.3 + sx * hr * 0.45 * side, ey = hy + dy * hr * 0.3 + sy * hr * 0.45 * side;
      if (b.dead) {
        const e = hr * 0.2;
        g.strokeStyle = col.pupil;
        g.lineWidth = 1.6 * dpr;
        g.beginPath(); g.moveTo(ex - e, ey - e); g.lineTo(ex + e, ey + e); g.moveTo(ex + e, ey - e); g.lineTo(ex - e, ey + e); g.stroke();
        continue;
      }
      g.fillStyle = col.eye;
      g.beginPath(); g.arc(ex, ey, hr * 0.26, 0, Math.PI * 2); g.fill();
      g.fillStyle = col.pupil;
      g.beginPath(); g.arc(ex + dx * hr * 0.1, ey + dy * hr * 0.1, hr * 0.13, 0, Math.PI * 2); g.fill();
    }
  }, []);

  // Draw every frame while mounted (the board is tiny), so motion and the apple stay smooth.
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => { draw(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const s = Math.max(N * 10, Math.floor(Math.min(el.clientWidth, el.clientHeight) / N) * N);
      sizeRef.current = s;
      setSize(s);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  // ---------- game ----------
  const stopTick = () => window.clearTimeout(tickTimer.current);

  const tick = useCallback(() => {
    if (phaseRef.current !== "play") return;
    const b = board.current;
    const next = b.queue.shift();
    if (next && next !== OPP[b.dir]) b.dir = next;
    const [dx, dy] = VEC[b.dir];
    const head: Cell = [b.body[0][0] + dx, b.body[0][1] + dy];
    const eats = head[0] === b.food[0] && head[1] === b.food[1];
    const trail = eats ? b.body : b.body.slice(0, -1);
    const wall = head[0] < 0 || head[0] >= N || head[1] < 0 || head[1] >= N;
    if (wall || trail.some((c) => c[0] === head[0] && c[1] === head[1])) {
      b.prev = b.body;
      b.dead = true;
      b.cause = wall ? "wall" : "tail";
      setPhaseBoth("over");
      return;
    }
    b.prev = b.body;
    b.body = [head, ...trail];
    b.tickAt = performance.now();
    if (eats) {
      b.points += 1;
      b.ms = Math.max(MIN_MS, b.ms - STEP_MS);
      const free: Cell[] = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!b.body.some((c) => c[0] === x && c[1] === y)) free.push([x, y]);
      if (free.length) b.food = free[Math.floor(Math.random() * free.length)];
      setPoints(b.points);
      if (b.points > readBest(SNAKE_BEST_KEY)) {
        try { localStorage.setItem(SNAKE_BEST_KEY, String(b.points)); } catch { /* storage blocked */ }
        bestRef.current(b.points);
      }
    }
    tickTimer.current = window.setTimeout(tick, b.ms);
  }, [setPhaseBoth]);

  const begin = useCallback(() => {
    stopTick();
    board.current = fresh();
    setPoints(0);
    setCount(3);
    setPhaseBoth("count");
    later(() => setCount(2), COUNT_MS);
    later(() => setCount(1), COUNT_MS * 2);
    later(() => { setPhaseBoth("play"); tickTimer.current = window.setTimeout(tick, board.current.ms); }, COUNT_MS * 3);
  }, [later, setPhaseBoth, tick]);

  const pause = useCallback(() => {
    if (phaseRef.current !== "play") return;
    stopTick();
    setPhaseBoth("paused");
  }, [setPhaseBoth]);

  const resume = useCallback(() => {
    if (phaseRef.current !== "paused") return;
    setPhaseBoth("play");
    tickTimer.current = window.setTimeout(tick, board.current.ms);
  }, [setPhaseBoth, tick]);

  const steer = useCallback((d: Dir) => {
    const b = board.current;
    const lastDir = b.queue.length ? b.queue[b.queue.length - 1] : b.dir;
    if (d === lastDir || d === OPP[lastDir]) return false;
    if (b.queue.length < 2) b.queue.push(d);
    return true;
  }, []);

  // ---------- voice ----------
  const stopVoice = useCallback(() => {
    const id = session.current;
    session.current = "";
    if (id && isTauri()) void invoke("snake_stop", { session: id }).catch(() => {});
  }, []);

  const cancelVoice = useCallback(() => {
    stopVoice();
    setLevel(0);
    setVoiceBoth({ state: "off" });
  }, [setVoiceBoth, stopVoice]);

  const startVoice = useCallback(async () => {
    if (!isTauri()) {
      setVoiceBoth({ state: "unavailable", message: "Voice control works in the Spechy desktop app. Arrow keys work here." });
      return false;
    }
    stopVoice();
    const id = crypto.randomUUID();
    session.current = id;
    setVoiceBoth({ state: "starting" });
    try {
      await invoke("snake_start", { session: id });
      return true;
    } catch (e) {
      const msg = String(e);
      if (session.current !== id) return false;
      session.current = "";
      setVoiceBoth(msg.includes("unsupported")
        ? { state: "unavailable", message: ERRORS["unsupported-platform"] }
        : { state: "error", message: `Voice control could not start. ${msg.replace(/^failed:\s*/, "")}` });
      return false;
    }
  }, [setVoiceBoth, stopVoice]);

  onMsg.current = (m: SnakeMsg) => {
    if (!m || m.session !== session.current) return;
    switch (m.kind) {
      case "download":
        setVoiceBoth({ state: "downloading", progress: Math.min(1, Math.max(0, m.progress)), mb: m.mb, unpacking: m.stage === "unpack" });
        break;
      case "ready":
        setVoiceBoth({ state: "on" });
        if (phaseRef.current === "ready") begin();
        break;
      case "level": setLevel(m.value); break;
      case "partial": setPending(isDir(m.text) ? m.text : null); break;
      case "heard": {
        if (!isDir(m.command)) break;
        const p = phaseRef.current;
        if (p === "play" || p === "count") steer(m.command);
        setPending(null);
        setLast({ id: Date.now(), dir: m.command });
        chipId.current += 1;
        const chip = { id: chipId.current, dir: m.command };
        setChips((cs) => [...cs, chip].slice(-MAX_CHIPS));
        break;
      }
      case "rejected": setLast({ id: Date.now(), dir: null }); break;
      case "signal": if (SIGNALS[m.problem]) flash(SIGNALS[m.problem]); break;
      case "error":
        session.current = "";
        setLevel(0);
        setPending(null);
        setVoiceBoth({ state: "error", message: ERRORS[m.code] ?? `Voice control stopped. ${m.detail}`.trim() });
        break;
      case "closed":
        session.current = "";
        setLevel(0);
        setPending(null);
        if (voiceRef.current.state !== "error") setVoiceBoth({ state: "error", message: "Voice control stopped. Press Listen again to turn it back on." });
        break;
    }
  };

  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let dead = false;
    void listen<SnakeMsg>("snake-input", ({ payload }) => onMsg.current(payload))
      .then((f) => { if (dead) f(); else off = f; })
      .catch(() => {});
    return () => { dead = true; off?.(); };
  }, []);

  // Leaving the game: stop the listener (and a running download) and every timer.
  useEffect(() => () => {
    stopVoice();
    stopTick();
    timers.current.forEach((t) => window.clearTimeout(t));
    window.clearTimeout(hintTimer.current);
  }, [stopVoice]);

  useEffect(() => { chipsEnd.current?.scrollIntoView({ block: "end" }); }, [chips, pending]);

  // ---------- keys ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const d = KEYS[e.code];
      if (d) {
        e.preventDefault();
        if (phaseRef.current === "play" || phaseRef.current === "count") steer(d);
      } else if ((e.code === "Space" || e.code === "Enter") && !e.repeat) {
        e.preventDefault();
        const p = phaseRef.current;
        if (p === "ready" || p === "over") begin();
        else if (p === "play") pause();
        else if (p === "paused") resume();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [begin, pause, resume, steer]);

  // ---------- view ----------
  const best = Math.max(readBest(SNAKE_BEST_KEY), points);
  const listening = voice.state === "on";
  const busy = voice.state === "starting" || voice.state === "downloading";
  const status = (() => {
    if (hint) return { text: hint, err: false };
    if (voice.state === "error" || voice.state === "unavailable") return { text: voice.message, err: voice.state === "error" };
    if (voice.state === "starting") return { text: "Starting voice control...", err: false };
    if (listening) return { text: "Listening. Say up, down, left or right.", err: false };
    return { text: "", err: false };
  })();
  const LastIcon = last?.dir ? ICON[last.dir] : Ear;
  const PendingIcon = pending ? ICON[pending] : null;

  const download = voice.state === "downloading" ? (
    <div className="vs-dl" role="group" aria-label="Voice model download">
      <span className="vs-dl-title">
        {voice.unpacking ? "Unpacking the voice model..." : `Downloading the voice model, ${voice.mb} MB, only once`}
      </span>
      <span className="vs-dl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(voice.progress * 100)}>
        <span className="vs-dl-fill" style={{ transform: `scaleX(${voice.progress})` }} />
      </span>
      <span className="vs-dl-meta">
        <span>{Math.round(voice.progress * 100)} %</span>
        <button className="btn btn-secondary btn-sm" onClick={cancelVoice}><X size={14} aria-hidden="true" /> Cancel</button>
      </span>
    </div>
  ) : null;

  return (
    <div className="vs">
      <div className="vs-main">
        <div className="vs-score">
          <span><strong>{points}</strong>points</span>
          <span>Best {best}</span>
        </div>
        <div className="vs-board-wrap" ref={wrap}>
          <div className="vs-board-box" style={{ width: size, height: size }}>
          <canvas ref={canvas} className="vs-board" style={{ width: size, height: size }} aria-label="Snake board" />
          {phase === "count" && (
            <div className="vs-over clear"><span key={count} className="vs-count">{count}</span></div>
          )}
          {phase === "ready" && (
            <div className="vs-over">
              <span className="vs-over-title">Voice Snake</span>
              <span className="vs-over-line">Say up, down, left or right. Avoid the walls and your own tail.</span>
              {download ?? (
                <div className="vs-actions">
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { void startVoice().then((ok) => { if (!ok) begin(); }); }}>
                    <Mic size={15} aria-hidden="true" /> Play with voice
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={begin}>
                    <Keyboard size={15} aria-hidden="true" /> Play with keys
                  </button>
                </div>
              )}
            </div>
          )}
          {phase === "paused" && (
            <div className="vs-over">
              <span className="vs-over-title">Paused</span>
              <span className="vs-over-line">Press Space to go on.</span>
            </div>
          )}
          {phase === "over" && (
            <div className="vs-over">
              <span className="vs-over-title">{points} {points === 1 ? "point" : "points"}</span>
              <span className="vs-over-line">{points > 0 && points >= best ? "New personal best." : board.current.cause === "wall" ? "You hit the wall." : "You bit your own tail."} Press Space to play again.</span>
              {download ?? (
                <div className="vs-actions">
                  <button className="btn btn-primary btn-sm" onClick={begin}><Play size={15} aria-hidden="true" /> Play again</button>
                  {!listening && !busy && (
                    <button className="btn btn-secondary btn-sm" onClick={() => { void startVoice(); }}>
                      <Mic size={15} aria-hidden="true" /> Listen again
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
        </div>
        <div className={`vs-status ${status.err ? "err" : ""}`} role="status">{status.text}</div>
      </div>

      <aside className="vs-side" aria-label="What was heard">
        <div key={last?.id ?? 0} className={`vs-last ${last ? "pulse" : ""}`}>
          <span className={`vs-last-icon ${last?.dir ? "" : "idle"}`}><LastIcon size={20} strokeWidth={2.2} aria-hidden="true" /></span>
          <span className="vs-last-text">
            <span className="vs-last-title">{last?.dir ? LABEL[last.dir] : last ? "Did not catch that" : "Waiting for a direction"}</span>
            <span className="vs-last-sub">{last?.dir ? "Heard" : last ? "Say up, down, left or right" : listening ? "Say up, down, left or right" : "Play with voice to steer by speaking"}</span>
          </span>
        </div>
        <div className="vs-meter" aria-hidden="true">
          <Mic size={14} />
          <span className="vs-meter-bar"><span className="vs-meter-fill" style={{ transform: `scaleX(${listening ? level / 100 : 0})` }} /></span>
        </div>
        <span className="vs-feed-label">Heard</span>
        <div className="vs-feed" aria-live="polite">
          {chips.length === 0 && !pending ? (
            <p className="vs-feed-empty">Every direction you say shows up here.</p>
          ) : (
            <div className="vs-chips">
              {chips.map((c, i) => {
                const Icon = ICON[c.dir];
                return (
                  <span key={c.id} className={`vs-chip ${i === chips.length - 1 ? "newest" : ""} ${i < chips.length - 12 ? "old" : ""}`}>
                    <Icon size={13} strokeWidth={2.4} aria-hidden="true" />{c.dir}
                  </span>
                );
              })}
              {pending && PendingIcon && (
                <span className="vs-chip pending" aria-hidden="true">
                  <PendingIcon size={13} strokeWidth={2.4} />{pending}
                </span>
              )}
              <div ref={chipsEnd} />
            </div>
          )}
        </div>
        <div className="vs-hint"><kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd> or WASD steer, <kbd>Space</kbd> pauses.</div>
      </aside>
    </div>
  );
}
