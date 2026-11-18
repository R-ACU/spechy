// Voice Snake game over: dark teal board with the game's dotted grid, the chrome microphone
// with sound waves from the cover, apples as row bullets, and a snake that slithers along a
// grid path under the score to eat an apple (golden on a new best). Game art: fixed colours.
import { useState, type CSSProperties } from "react";
import { Award } from "lucide-react";
import { fmtCoins } from "../../../../lib/economy";
import { NEON_SNAKE, useEquippedSkin } from "../../shop/gameSkins";
import { PixelArt, type Paint } from "./PixelArt";
import { Actions, CapNote, kicker, Rows } from "./parts";
import { Title } from "./Title";
import { reducedMotion, useResults } from "./useResults";
import type { ResultsProps } from "./types";
import "./results.css";

const METAL = ["#22302d", "#3e504b", "#62786f", "#93a8a0", "#c6d3ce", "#eef3ef"];
const INK = "#071311";

/** Retro studio microphone, 14 x 24: grille capsule, ring, neck, stand foot. */
const micPaint: Paint = (_g, rect) => {
  const rows: [number, number][] = [[4, 6], [3, 8], [2, 10], [2, 10], [2, 10], [2, 10], [2, 10], [2, 10], [2, 10], [3, 8], [4, 6]];
  rows.forEach(([x, w], y) => {
    rect(x, y + 1, w, 1, METAL[3]);
    rect(x, y + 1, 1, 1, METAL[1]);
    rect(x + w - 1, y + 1, 1, 1, METAL[1]);
    if (y > 0 && y < 10) rect(x + 1, y + 1, 1, 1, METAL[5]);
  });
  for (let y = 3; y < 10; y += 2) for (let x = 5; x < 11; x += 2) rect(x, y, 1, 1, METAL[1]);
  rect(1, 12, 12, 2, METAL[4]); rect(1, 13, 12, 1, METAL[2]); rect(2, 12, 3, 1, METAL[5]);
  rect(6, 14, 2, 6, METAL[2]); rect(6, 14, 1, 6, METAL[4]);
  rect(3, 20, 8, 2, METAL[3]); rect(2, 22, 10, 1, METAL[1]); rect(2, 23, 10, 1, INK);
};

// The slither path: grid steps like the board, ending at the apple.
const PATH = "M 8 18 H 70 V 8 H 128 V 22 H 196 V 12 H 262";
const PATH_LEN = 62 + 10 + 58 + 14 + 68 + 10 + 66;

export default function SnakeResults(props: ResultsProps) {
  const { award, best, floating, onBack, onAgain } = props;
  const { rows, shown, totalRef, againRef } = useResults(props, 620);
  const [still] = useState(reducedMotion);
  const neon = useEquippedSkin("snake-skin") === "neon";
  const skinVars = neon ? ({
    "--sn-body": NEON_SNAKE.body, "--sn-shine": NEON_SNAKE.shine, "--sn-head": NEON_SNAKE.head, "--sn-eye": NEON_SNAKE.pupil,
    "--sn-apple": NEON_SNAKE.apple, "--sn-leaf": NEON_SNAKE.leaf, "--sn-glow": NEON_SNAKE.glow,
  } as CSSProperties) : undefined;
  return (
    <div className={`gr gr-snake ${neon ? "gr-skin-neon" : ""} ${floating ? "gr-floating" : ""} ${award.newBest ? "gr-best-on" : ""}`} style={skinVars} role="status" aria-live="polite">
      <div className="gr-sn-mic" aria-hidden="true">
        <span className="gr-sn-wave w1" /><span className="gr-sn-wave w2" /><span className="gr-sn-wave w3" />
        <PixelArt w={14} h={24} scale={3} paint={micPaint} />
      </div>
      <div className="gr-k">{kicker(award)}</div>
      <Title game="snake" />
      <div className="gr-score">{fmtCoins(award.score)}</div>
      {award.newBest ? (
        <span className="gr-best"><Award size={14} aria-hidden="true" />New best</span>
      ) : (
        <span className="gr-muted">Best {fmtCoins(best)}</span>
      )}
      <svg className="gr-sn-path" viewBox="0 0 290 30" aria-hidden="true" style={{ "--len": PATH_LEN } as CSSProperties}>
        <g className="gr-sn-apple">
          <circle cx="274" cy="13" r="6" />
          <ellipse className="leaf" cx="277.5" cy="5.5" rx="3.2" ry="1.6" transform="rotate(-30 277.5 5.5)" />
        </g>
        <path className="gr-sn-body" d={PATH} pathLength={PATH_LEN} />
        <path className="gr-sn-shine" d={PATH} pathLength={PATH_LEN} />
        <g className="gr-sn-head" transform={still ? "translate(262 12)" : undefined}>
          {!still && <animateMotion path={PATH} begin="0.12s" dur="0.9s" fill="freeze" rotate="auto" />}
          <circle r="7" />
          <circle className="eye" cx="2.5" cy="-2.5" r="1.6" />
          <circle className="eye" cx="2.5" cy="2.5" r="1.6" />
        </g>
      </svg>
      <Rows rows={rows} shown={shown} totalRef={totalRef} bullet={(r) => <i className={r.kind === "best" || r.kind === "total" ? "gold" : ""} />} />
      <CapNote award={award} />
      <Actions floating={floating} onBack={onBack} onAgain={onAgain} againRef={againRef} />
    </div>
  );
}
