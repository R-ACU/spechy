// A rank emblem in the "Schatzkammer" style. Pass a division (0..2) to show the I..III pips.
import { memo, type CSSProperties } from "react";
import { rankArt, RANK_TIER_NAMES } from "./rankArt";
import "./rank.css";

const DIV = ["I", "II", "III"];

export const RankBadge = memo(function RankBadge({ tier, division = null, size = 64, className = "", label }: {
  tier: number;
  division?: number | null;
  size?: number;
  className?: string;
  /** Accessible name; defaults to "Gold II". Pass "" to hide it from assistive tech. */
  label?: string;
}) {
  const name = label ?? `${RANK_TIER_NAMES[tier] ?? ""}${division != null && tier < 6 ? ` ${DIV[division] ?? ""}` : ""}`;
  return (
    <span
      className={`rank-badge ${className}`}
      style={{ "--rb": `${size}px` } as CSSProperties}
      role={name ? "img" : undefined}
      aria-label={name || undefined}
      aria-hidden={name ? undefined : true}
      dangerouslySetInnerHTML={{ __html: rankArt(tier, size, division) }}
    />
  );
});

export default RankBadge;
