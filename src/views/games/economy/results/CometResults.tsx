// Comet Keeper game over: navy starfield with a warm halo, a comet that streaks in and breaks
// on the icy shield of the little lantern, and the lantern's face reacting to the round
// (beaming on a new best, calm after a normal round, sleepy after leaving). Score in warm
// gold, rank points in icy blue. Game art: fixed colours are allowed here.
import type { CSSProperties } from "react";
import { Award } from "lucide-react";
import { fmtCoins } from "../../../../lib/economy";
import { cometSkinLook } from "../../cometKeeper/engine";
import { useEquippedSkin } from "../../shop/gameSkins";
import { PixelArt, type Paint } from "./PixelArt";
import { Actions, CapNote, kicker, Rows } from "./parts";
import { Title } from "./Title";
import { useResults } from "./useResults";
import type { ResultsProps } from "./types";
import "./results.css";

const CORE = { body: "#ffd27a", shade: "#f0a050", light: "#fff3c4", line: "#3a2148", cheek: "#ff9a8a" };
const SHIELD = { main: "#6fdcff", edge: "#d4f8ff", inner: "#2f8fc4" };
type Mood = "happy" | "calm" | "sleepy";

function disc(rect: (x: number, y: number, w: number, h: number, c: string) => void, cx: number, cy: number, r: number, c: string) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    const dy = y + 0.5 - cy;
    if (dy * dy > r * r) continue;
    const half = Math.sqrt(r * r - dy * dy);
    const x0 = Math.round(cx - half), x1 = Math.round(cx + half);
    if (x1 > x0) rect(x0, y, x1 - x0, 1, c);
  }
}

/** The lantern core with its face and the shield arc on the upper left, 30 x 30. */
function lanternPaint(mood: Mood): Paint {
  return (_g, rect) => {
    // shield: a broken arc facing the incoming comet (upper left)
    for (let a = Math.PI * 0.95; a <= Math.PI * 1.62; a += 0.035) {
      const x = 16 + Math.cos(a) * 13.5, y = 17 + Math.sin(a) * 13.5;
      rect(Math.floor(x), Math.floor(y), 2, 2, SHIELD.main);
      rect(Math.floor(16 + Math.cos(a) * 15), Math.floor(17 + Math.sin(a) * 15), 1, 1, SHIELD.edge);
      rect(Math.floor(16 + Math.cos(a) * 12), Math.floor(17 + Math.sin(a) * 12), 1, 1, SHIELD.inner);
    }
    disc(rect, 16, 17, 9.5, CORE.line);
    disc(rect, 16, 17, 8.5, CORE.shade);
    disc(rect, 15.2, 16.2, 7.6, CORE.body);
    rect(11, 11, 3, 1, CORE.light); rect(10, 12, 2, 2, CORE.light);
    // face
    const L = CORE.line;
    if (mood === "happy") {
      rect(12, 16, 1, 1, L); rect(13, 15, 1, 1, L); rect(14, 16, 1, 1, L);
      rect(17, 16, 1, 1, L); rect(18, 15, 1, 1, L); rect(19, 16, 1, 1, L);
      rect(13, 19, 6, 1, L); rect(14, 20, 4, 1, L); rect(15, 20, 2, 1, CORE.cheek);
    } else if (mood === "calm") {
      rect(13, 15, 1, 2, L); rect(18, 15, 1, 2, L);
      rect(14, 19, 1, 1, L); rect(15, 20, 2, 1, L); rect(17, 19, 1, 1, L);
    } else {
      rect(12, 16, 3, 1, L); rect(17, 16, 3, 1, L);
      rect(15, 20, 2, 1, L);
    }
    rect(11, 18, 2, 1, CORE.cheek); rect(19, 18, 2, 1, CORE.cheek);
  };
}
const PAINTS: Record<Mood, Paint> = { happy: lanternPaint("happy"), calm: lanternPaint("calm"), sleepy: lanternPaint("sleepy") };

/** Pixel starfield across the whole card, deterministic. */
const STARS: { x: number; y: number; big: boolean; dim: boolean }[] = (() => {
  let s = 0x5eed;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 4294967296; };
  return Array.from({ length: 46 }, () => ({ x: rnd() * 100, y: rnd() * 100, big: rnd() < 0.18, dim: rnd() < 0.55 }));
})();

export default function CometResults(props: ResultsProps) {
  const { award, best, floating, onBack, onAgain } = props;
  const { rows, shown, totalRef, againRef } = useResults(props, 560);
  const ice = useEquippedSkin("comet-skin") === "ice";
  const rgb = (c: number) => `rgb(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255})`;
  const iceVars = ice ? (() => {
    const st = cometSkinLook("ice").styles.normal;
    return { "--cm-t1": rgb(st.trail[2]), "--cm-t2": rgb(st.trail[1]), "--cm-t3": rgb(st.trail[0]), "--cm-head": rgb(st.head), "--cm-core": rgb(st.core) } as CSSProperties;
  })() : undefined;
  const mood: Mood = award.newBest ? "happy" : award.quit ? "sleepy" : "calm";
  return (
    <div style={iceVars} className={`gr gr-comet ${ice ? "gr-skin-ice" : ""} ${floating ? "gr-floating" : ""} ${award.newBest ? "gr-best-on" : ""}`} role="status" aria-live="polite">
      <div className="gr-cm-stars" aria-hidden="true">
        {STARS.map((st, i) => (
          <i key={i} className={`${st.big ? "big" : ""} ${st.dim ? "dim" : ""}`} style={{ left: `${st.x}%`, top: `${st.y}%`, animationDelay: `${(i % 7) * 0.45}s` }} />
        ))}
      </div>
      <div className="gr-cm-comet" aria-hidden="true"><span className="trail" /><span className="head" /></div>
      <div className="gr-cm-lantern" aria-hidden="true">
        <span className="gr-cm-sparks"><i /><i /><i /><i /></span>
        <PixelArt w={30} h={30} scale={3} paint={PAINTS[mood]} />
      </div>
      <div className="gr-k">{kicker(award)}</div>
      <Title game="comet" />
      <div className="gr-score">{fmtCoins(award.score)}</div>
      {award.newBest ? (
        <span className="gr-best"><Award size={14} aria-hidden="true" />New best</span>
      ) : (
        <span className="gr-muted">Best {fmtCoins(best)}</span>
      )}
      <Rows rows={rows} shown={shown} totalRef={totalRef} bullet={(r) => <i className={r.kind === "rp" ? "ice" : ""} />} />
      <CapNote award={award} />
      <Actions floating={floating} onBack={onBack} onAgain={onAgain} againRef={againRef} />
    </div>
  );
}
