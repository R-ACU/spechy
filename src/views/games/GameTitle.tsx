// Per-game title typography: Pixel Tower (Silkscreen, pastel letters), Comet Keeper
// (Silkscreen, orange/yellow plus icy blue), Voice Snake (Pixelify Sans, mint with a food dot).
// Fonts are bundled locally (@fontsource, OFL), so the titles work offline.
import "@fontsource/silkscreen/700.css";
import "@fontsource/pixelify-sans/600.css";
import "./gameTitle.css";

export type GameTitleId = "tower" | "snake" | "comet";

const NAMES: Record<GameTitleId, string> = { tower: "Pixel Tower", snake: "Voice Snake", comet: "Comet Keeper" };

const COLORS: Record<"tower" | "comet", string[]> = {
  tower: ["#c4e86a", "#7fd98a", "#8ee6c0", "#6fdcec", "#7fbdf2", "#9aa4ee", "#b99cee", "#f0a0c8"],
  comet: ["#f0a060", "#f8d860", "#f0a060", "#f8d860", "#f0a060", "#7fd0f0", "#dff4ff", "#7fd0f0", "#dff4ff", "#7fd0f0", "#dff4ff"],
};

export default function GameTitle({ game, size = "card", className = "" }: { game: GameTitleId; size?: "tab" | "card" | "header"; className?: string }) {
  const name = NAMES[game];
  let k = 0;
  const letters = [...name].map((ch, i) => {
    if (ch === " ") return " ";
    if (game === "snake") return <i key={i}>{ch}</i>;
    const color = COLORS[game][game === "tower" ? Math.floor((k++ * 8) / 10) : k++];
    return <i key={i} style={{ color }}>{ch}</i>;
  });
  return (
    <span className={`gt gt-${game} ${className}`} data-size={size} role="img" aria-label={name}>
      <span aria-hidden="true">
        {letters}
        {game === "snake" && <i className="dot" />}
      </span>
    </span>
  );
}

export { GameTitle };
