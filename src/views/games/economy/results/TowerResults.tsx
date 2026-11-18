// Pixel Tower game over: the game's pastel sky in hard bands, a crisp ink frame, pixel score
// and a little stack of iso blocks that drops in block by block (a gold block on top for a
// new best), with two pixel clouds drifting by. Game art: fixed colours are allowed here.
import { useMemo } from "react";
import { Award } from "lucide-react";
import { fmtCoins } from "../../../../lib/economy";
import { towerSkinSwatches } from "../../pixelTower";
import { useEquippedSkin } from "../../shop/gameSkins";
import { PixelArt, type Paint } from "./PixelArt";
import { Actions, CapNote, kicker, Rows } from "./parts";
import { Title } from "./Title";
import { useResults } from "./useResults";
import type { ResultsProps } from "./types";
import "./results.css";

const INK = "#1b1530";
interface Block { top: string; rim: string; left: string; right: string }
const BLOCKS: Block[] = [
  { top: "#c4e86a", rim: "#e4f8a8", left: "#6a9a3a", right: "#8fc24a" },
  { top: "#6fdcec", rim: "#bff2f8", left: "#2f86a8", right: "#3fb0c8" },
  { top: "#b99cee", rim: "#e0d2fa", left: "#64569e", right: "#8a74c8" },
  { top: "#f0a0c8", rim: "#fad2e6", left: "#9a5a86", right: "#c878a4" },
];
const GOLD: Block = { top: "#ffd84a", rim: "#fff3b0", left: "#b9822a", right: "#e0a838" };

/** One iso block, 16 x 13 pixels: top diamond with a light rim, two shaded faces, ink base. */
function blockPaint(b: Block): Paint {
  return (_g, rect) => {
    for (let x = 0; x < 16; x++) {
      const m = Math.min(x, 15 - x);
      const edge = 4 + Math.floor(m / 2);
      rect(x, edge, 1, 6, x < 8 ? b.left : b.right);
      rect(x, edge + 6, 1, 1, INK);
    }
    for (let y = 0; y < 8; y++) {
      const hw = y < 4 ? 2 * (y + 1) : 2 * (8 - y);
      rect(8 - hw, y, hw * 2, 1, b.top);
    }
    for (let y = 0; y < 4; y++) rect(8 - 2 * (y + 1), y, 2, 1, b.rim);
  };
}
const GOLD_PAINT = blockPaint(GOLD);

const cloudPaint: Paint = (_g, rect) => {
  rect(3, 2, 6, 1, "#ffffff"); rect(2, 3, 12, 1, "#ffffff"); rect(9, 1, 4, 1, "#ffffff");
  rect(8, 2, 6, 1, "#ffffff"); rect(0, 4, 18, 2, "#ffffff"); rect(1, 6, 15, 1, "#f4eef8");
};

const sparkPaint: Paint = (_g, rect) => {
  rect(2, 0, 1, 5, "#ffd84a"); rect(0, 2, 5, 1, "#ffd84a"); rect(2, 2, 1, 1, "#ffffff");
};

export default function TowerResults(props: ResultsProps) {
  const { award, best, floating, onBack, onAgain } = props;
  const skin = useEquippedSkin("tower-skin");
  // The equipped skin recolours the stack with the game's own palette; none keeps the pastel blocks.
  const blocks = useMemo<Block[]>(() => (skin ? towerSkinSwatches(skin, BLOCKS.length, 0) : BLOCKS), [skin]);
  const paints = useMemo(() => blocks.map(blockPaint), [blocks]);
  const stack = award.newBest ? [...paints, GOLD_PAINT] : paints;
  const { rows, shown, totalRef, againRef } = useResults(props, 140 + stack.length * 110);
  return (
    <div className={`gr gr-tower ${floating ? "gr-floating" : ""}`} role="status" aria-live="polite">
      <div className="gr-tw-deco" aria-hidden="true">
        <PixelArt w={18} h={7} scale={3} paint={cloudPaint} className="gr-tw-cloud a" />
        <PixelArt w={18} h={7} scale={2} paint={cloudPaint} className="gr-tw-cloud b" />
        <div className="gr-tw-stack">
          {stack.map((p, i) => (
            <PixelArt key={i} w={16} h={13} scale={3} paint={p} className="gr-tw-block" style={{ bottom: i * 18, animationDelay: `${i * 110}ms`, zIndex: i }} />
          ))}
          {award.newBest && <>
            <PixelArt w={5} h={5} scale={3} paint={sparkPaint} className="gr-tw-spark s1" />
            <PixelArt w={5} h={5} scale={3} paint={sparkPaint} className="gr-tw-spark s2" />
          </>}
        </div>
      </div>
      <div className="gr-k">{kicker(award)}</div>
      <Title game="tower" />
      <div className="gr-score">{fmtCoins(award.score)}</div>
      {award.newBest ? (
        <span className="gr-best"><Award size={14} aria-hidden="true" />New best</span>
      ) : (
        <span className="gr-muted">Best {fmtCoins(best)}</span>
      )}
      <Rows rows={rows} shown={shown} totalRef={totalRef} bullet={(_r, i) => <i style={{ background: blocks[i % blocks.length].top }} />} />
      <CapNote award={award} />
      <Actions floating={floating} onBack={onBack} onAgain={onAgain} againRef={againRef} />
    </div>
  );
}
