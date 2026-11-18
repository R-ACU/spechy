// Not-joined view of the Leaderboard tab: mostly a picture. Left the player's avatar in a frame
// of their rank colour, right a wireframe server stack under the turning official Cloudflare
// logo (ServerRack), a dashed wire in between. Next to it one headline, the display name, Join
// and an info toggle with the details. Joining plays packets along the wire while the boxes
// light up bottom to top and the logo spins faster, then a success sweep and a check; a failed
// join drops the packets, blinks the lights red and shows a short error. Nothing here talks to a server before Join: the
// avatar is the local picture (getMyAvatar), and status comes from the parent.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Check, CloudOff, Info, MicOff, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useStore } from "../../../lib/store";
import * as client from "../../../lib/leaderboard";
import type { LeaderboardStatus } from "../../../lib/leaderboard";
import { RankBadge } from "../rank/RankBadge";
import { tierColor } from "../rank/rankArt";
import { configureSfx } from "../economy/sfx";
import { joinSfx } from "./joinSfx";
import ServerRack from "./ServerRack";

type Phase = "idle" | "sending" | "success" | "failed";

const NAME_MIN = 3, NAME_MAX = 20;
const PACKETS = 4;
const PACKET_MS = 1200;
const PACKET_GAP = PACKET_MS / PACKETS;
const MIN_SEND_MS = 1600;
const SUCCESS_HOLD_MS = 1300;
const LEAVE_MS = 280;
const FAIL_HOLD_MS = 1500;
const PROFILE_NAME_KEY = "spechy.profile.name";

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const charLen = (s: string) => [...s].length;

function startName(status: LeaderboardStatus, fallback: string): string {
  if (status.displayName) return status.displayName;
  let local: string | null = null;
  try { local = localStorage.getItem(PROFILE_NAME_KEY); } catch { /* storage blocked */ }
  const n = (local ?? fallback ?? "").trim();
  return charLen(n) >= NAME_MIN && charLen(n) <= NAME_MAX ? n : "";
}

function shortError(e: unknown): string {
  const code = (e as { code?: string } | undefined)?.code;
  if (code === "not_configured") return "The leaderboard server is not set up yet.";
  if (code === "network") return "Could not reach the server. Try again later.";
  return client.leaderboardErrorMessage(e);
}

export default function JoinView({ status, tier, comingSoon, onStart, onSettled }: {
  status: LeaderboardStatus;
  tier: number;
  /** Release build without a configured server: picture only, no form. */
  comingSoon: boolean;
  /** The join animation starts; keep this view mounted even when the status flips to joined. */
  onStart: () => void;
  /** The animation is over (joined true: hand over to the list). */
  onSettled: (joined: boolean) => void;
}) {
  const { settings } = useStore();
  const [name, setName] = useState(() => startName(status, settings.userName ?? ""));
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const [out, setOut] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const packets = useRef<(HTMLSpanElement | null)[]>([]);
  const anims = useRef<Animation[]>([]);
  const timers = useRef<number[]>([]);
  const alive = useRef(true);

  const trimmed = name.trim();
  const len = charLen(trimmed);
  const valid = len >= NAME_MIN && len <= NAME_MAX;
  const busy = phase === "sending" || phase === "success";

  // Local picture only (no request), same as the rank card in Profile.
  useEffect(() => {
    let live = true;
    void client.getMyAvatar().then((u) => { if (live) { setAvatar(u); setAvatarBroken(false); } }, () => {});
    return () => { live = false; };
  }, []);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => { clearTimeout(t); clearInterval(t); });
    timers.current = [];
  }, []);
  const stopPackets = useCallback(() => {
    anims.current.forEach((a) => a.cancel());
    anims.current = [];
    packets.current.forEach((p) => p?.classList.remove("bad"));
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimers(); stopPackets(); };
  }, [clearTimers, stopPackets]);

  const startPackets = () => {
    stopPackets();
    anims.current = packets.current.flatMap((el, i) => el ? [el.animate([
      { left: "0%", opacity: 0, transform: "translate(-50%, -50%) scale(.5)" },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.12 },
      { opacity: 1, transform: "translate(-50%, -50%) scale(1)", offset: 0.86 },
      { left: "100%", opacity: 0, transform: "translate(-50%, -50%) scale(.4)" },
    ], { duration: PACKET_MS, delay: i * PACKET_GAP, iterations: Infinity, easing: "cubic-bezier(.45, 0, .55, 1)" })] : []);
    let n = 0;
    timers.current.push(window.setTimeout(() => {
      joinSfx.packet(n++);
      timers.current.push(window.setInterval(() => joinSfx.packet(n++), PACKET_GAP));
    }, PACKET_MS * 0.9));
  };

  // Freeze every packet where it is, turn it red and let it fall off the wire.
  const dropPackets = () => {
    const drops: Animation[] = [];
    anims.current.forEach((a, i) => {
      const el = packets.current[i];
      if (!el) return;
      const cs = getComputedStyle(el);
      const left = cs.left, opacity = Number(cs.opacity);
      a.cancel();
      if (opacity < 0.05) return;
      el.classList.add("bad");
      drops.push(el.animate([
        { left, opacity, transform: "translate(-50%, -50%) rotate(0deg)" },
        { left, opacity, transform: "translate(-50%, -30%) rotate(8deg)", offset: 0.25 },
        { left, opacity: 0, transform: `translate(-50%, 140%) rotate(${i % 2 ? -50 : 55}deg)` },
      ], { duration: 650 + i * 70, easing: "cubic-bezier(.55, 0, .9, .5)", fill: "forwards" }));
    });
    anims.current = drops;
  };

  const join = async () => {
    if (!valid || busy || comingSoon) return;
    const rm = reducedMotion();
    setError(null);
    setPhase("sending");
    onStart();
    configureSfx(settings.sounds !== false, 0.8);
    if (!rm) startPackets();
    const t0 = performance.now();
    let failure: { e: unknown } | null = null;
    try {
      await client.join(trimmed);
    } catch (e) {
      failure = { e };
    }
    await sleep(Math.max(0, (rm ? 400 : MIN_SEND_MS) - (performance.now() - t0)));
    if (!alive.current) return;
    clearTimers();
    if (!failure) {
      stopPackets();
      setPhase("success");
      joinSfx.chime();
      timers.current.push(window.setTimeout(() => {
        setOut(true);
        timers.current.push(window.setTimeout(() => onSettled(true), rm ? 0 : LEAVE_MS));
      }, SUCCESS_HOLD_MS));
    } else {
      if (rm) stopPackets(); else dropPackets();
      setPhase("failed");
      setError(shortError(failure.e));
      joinSfx.fail();
      onSettled(false);
      timers.current.push(window.setTimeout(() => {
        stopPackets();
        setPhase((p) => (p === "failed" ? "idle" : p));
      }, FAIL_HOLD_MS));
    }
  };

  const initial = [...trimmed][0]?.toUpperCase();
  const scenePhase = comingSoon ? "soon" : phase;

  return (
    <section className={`lb-join rk-glass ${out ? "out" : ""}`} aria-label="Join the leaderboard">
      <div className="lb-scene" data-phase={scenePhase}>
        <div className="lb-me">
          <span className="lb-me-av" style={{ "--rc": tierColor(tier) } as CSSProperties}>
            {avatar && !avatarBroken ? (
              <img src={avatar} alt="" draggable={false} onError={() => setAvatarBroken(true)} />
            ) : initial ? (
              <span className="lb-me-initial">{initial}</span>
            ) : (
              <UserRound size={40} strokeWidth={1.6} aria-hidden="true" />
            )}
            <RankBadge tier={tier} division={null} size={30} className="lb-me-badge" />
          </span>
          <span className="lb-me-name">{trimmed || "You"}</span>
        </div>
        <div className="lb-wire" aria-hidden="true">
          {Array.from({ length: PACKETS }, (_, i) => (
            <span key={i} className="lb-packet" ref={(el) => { packets.current[i] = el; }} />
          ))}
        </div>
        <ServerRack phase={scenePhase} />
      </div>

      <div className="lb-join-ctl">
        <div className="lb-join-head">
          <h2 className="lb-join-title">
            {comingSoon ? "Leaderboard coming soon" : phase === "success" ? "You are on the board" : "Join the weekly leaderboard"}
          </h2>
          <button
            type="button"
            className={`lb-info-btn ${info ? "on" : ""}`}
            aria-label="What is shared"
            aria-expanded={info}
            aria-controls="lb-join-details"
            onClick={() => setInfo((v) => !v)}
          >
            <Info size={16} aria-hidden="true" />
          </button>
        </div>
        {comingSoon ? (
          <p className="lb-join-soon">Joining opens in a later update.</p>
        ) : (
          <form className="lb-join-form" onSubmit={(e) => { e.preventDefault(); void join(); }}>
            <div className="lb-join-row">
              <input
                id="lb-name"
                className="input"
                value={name}
                maxLength={NAME_MAX + 4}
                placeholder="Display name"
                aria-label="Display name"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-invalid={!!error || undefined}
                aria-describedby="lb-name-hint"
                onChange={(e) => { setName(e.target.value); setError(null); }}
              />
              <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
                {phase === "sending" ? "Joining" : phase === "success" ? <><Check size={16} aria-hidden="true" />Joined</> : "Join"}
              </button>
            </div>
            <div id="lb-name-hint" className={`lb-field-hint ${error ? "err" : ""}`} role={error ? "alert" : undefined}>
              {error ?? (phase === "success" ? "" : `${NAME_MIN} to ${NAME_MAX} characters`)}
            </div>
          </form>
        )}
      </div>

      <div id="lb-join-details" className={`lb-join-details ${info ? "open" : ""}`} hidden={!info}>
        <ul>
          <li><ShieldCheck size={15} aria-hidden="true" /><span>Shared: display name, title, rank, weekly points, word count and game bests.</span></li>
          <li><MicOff size={15} aria-hidden="true" /><span>Never your dictated text.</span></li>
          <li><CloudOff size={15} aria-hidden="true" /><span>Nothing is loaded before you join, not even other players' pictures.</span></li>
          <li><Trash2 size={15} aria-hidden="true" /><span>Leaving deletes everything on the server.</span></li>
        </ul>
      </div>
    </section>
  );
}
