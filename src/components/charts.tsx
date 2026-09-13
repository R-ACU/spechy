// Pure SVG / CSS chart pieces for the Insights view. No chart library.
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Share2 } from "lucide-react";
import type { DayStat } from "../lib/ipc";

// ---------------------------------------------------------------- percentile

/** Rough "top x%" of speakers for a given words-per-minute value. */
export function topPercent(wpm: number): number {
  const pts: [number, number][] = [
    [0, 50],
    [60, 50],
    [100, 10],
    [130, 1],
    [160, 0.4],
    [220, 0.1],
  ];
  if (wpm <= pts[1][0]) return 50;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (wpm <= x1) {
      const t = (wpm - x0) / (x1 - x0);
      // interpolate on a log scale so the curve stays smooth between anchors
      return Math.exp(Math.log(y0) + t * (Math.log(y1) - Math.log(y0)));
    }
  }
  return 0.1;
}

export function topPercentLabel(wpm: number): string {
  const p = topPercent(wpm);
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${p.toFixed(0)}%`;
  return `${p.toFixed(1)}%`;
}

// -------------------------------------------------------------------- gauge

/** Half circle gauge with the "Top x%" caption inside. */
export function Gauge({ wpm }: { wpm: number }) {
  const cx = 92;
  const cy = 88;
  const r = 62;
  const d = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const filled = Math.max(8, Math.min(97, (wpm / 190) * 100));
  return (
    <svg viewBox="0 0 184 98" className="ins-gauge" role="img" aria-label={`Top ${topPercentLabel(wpm)}`}>
      <path d={d} fill="none" stroke="var(--teal-200)" strokeWidth={18} strokeLinecap="round" />
      <path
        d={d}
        fill="none"
        stroke="var(--teal-900)"
        strokeWidth={18}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${filled} 100`}
        className="ins-gauge-arc"
      />
      <text x={cx} y={cy - 32} textAnchor="middle" className="ins-gauge-cap">Top</text>
      <text x={cx} y={cy - 6} textAnchor="middle" className="ins-gauge-val">{topPercentLabel(wpm)}</text>
    </svg>
  );
}

// -------------------------------------------------------------- share stamp

/** Round stamp button with a slowly rotating "SHARE" text ring. */
export function ShareStamp({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="ins-stamp" onClick={onClick} aria-label="Share" title="Share">
      <svg viewBox="0 0 76 76" className="ins-stamp-ring" aria-hidden="true">
        <defs>
          <path id="spechy-stamp-ring" fill="none" d="M 38 38 m -27 0 a 27 27 0 1 1 54 0 a 27 27 0 1 1 -54 0" />
        </defs>
        <text className="ins-stamp-text">
          <textPath href="#spechy-stamp-ring" startOffset="0">
            SHARE &middot; SHARE &middot; SHARE &middot;
          </textPath>
        </text>
      </svg>
      <Share2 size={17} strokeWidth={2} />
    </button>
  );
}

// ---------------------------------------------------------------- bar pieces

/** Proportional teal bar with the percentage inside it. */
export function PercentBar({ share, strong }: { share: number; strong?: boolean }) {
  const pct = Math.round(share * 100);
  const width = Math.max(9, share * 100);
  return (
    <div className="ins-bar-track">
      <div className={`ins-bar-fill ${strong ? "strong" : ""}`} style={{ width: `${width}%` }}>
        <span>{pct}%</span>
      </div>
    </div>
  );
}

/** Single full width bar; Spechy is desktop only, so the split is always 100%. */
export function DeviceBar({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <div className="ins-device-bar">
      <div className="ins-device-seg">
        {icon}
        <span>{label}</span>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- heatmap

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TOTAL_WEEKS = 53;
const VISIBLE_WEEKS = 20;

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Cell { date: Date; iso: string; words: number; level: number; streak: boolean; future: boolean }

/** GitHub style contribution grid: columns are weeks, rows Sun..Sat. */
export function Heatmap({ perDay, streakDays }: { perDay: DayStat[]; streakDays: number }) {
  const [offset, setOffset] = useState(0); // weeks scrolled back from the end

  const weeks = useMemo<Cell[][]>(() => {
    const byDay = new Map<string, number>();
    for (const d of perDay) byDay.set(d.date, (byDay.get(d.date) ?? 0) + d.words);

    const counts = [...byDay.values()].filter((v) => v > 0).sort((a, b) => a - b);
    const q = (f: number) => (counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * f))] : 1);
    const q1 = q(0.25);
    const q2 = q(0.5);
    const q3 = q(0.8);

    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay())); // Saturday of the current week

    const streakStart = new Date(today);
    streakStart.setDate(streakStart.getDate() - Math.max(0, streakDays - 1));

    const out: Cell[][] = [];
    for (let w = TOTAL_WEEKS - 1; w >= 0; w--) {
      const col: Cell[] = [];
      for (let day = 0; day < 7; day++) {
        const d = new Date(end);
        d.setDate(end.getDate() - w * 7 - (6 - day));
        const iso = isoDate(d);
        const words = byDay.get(iso) ?? 0;
        const level = words <= 0 ? 0 : words <= q1 ? 1 : words <= q2 ? 2 : words <= q3 ? 3 : 4;
        col.push({
          date: d,
          iso,
          words,
          level,
          streak: streakDays > 0 && d >= streakStart && d <= today,
          future: d > today,
        });
      }
      out.push(col);
    }
    return out;
  }, [perDay, streakDays]);

  const maxOffset = Math.max(0, weeks.length - VISIBLE_WEEKS);
  const start = Math.max(0, weeks.length - VISIBLE_WEEKS - offset);
  const view = weeks.slice(start, start + VISIBLE_WEEKS);

  const monthLabels = view.map((col, i) => {
    const first = col[0].date;
    const prev = i > 0 ? view[i - 1][0].date : null;
    if (!prev || prev.getMonth() !== first.getMonth()) return { i, label: MONTHS[first.getMonth()] };
    return null;
  }).filter(Boolean) as { i: number; label: string }[];

  return (
    <div className="ins-hm">
      <div className="ins-hm-nav">
        <button
          type="button"
          className="ins-hm-arrow"
          aria-label="Earlier weeks"
          disabled={offset >= maxOffset}
          onClick={() => setOffset((o) => Math.min(maxOffset, o + 4))}
        >
          <ChevronLeft size={16} />
        </button>
        <div className="ins-hm-months">
          {monthLabels.map((m) => (
            <span key={`${m.label}-${m.i}`} style={{ gridColumnStart: m.i + 1 }}>{m.label}</span>
          ))}
        </div>
        <button
          type="button"
          className="ins-hm-arrow"
          aria-label="Later weeks"
          disabled={offset <= 0}
          onClick={() => setOffset((o) => Math.max(0, o - 4))}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="ins-hm-body">
        <div className="ins-hm-days">
          {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="ins-hm-grid">
          {view.map((col, i) => (
            <div className="ins-hm-col" key={start + i}>
              {col.map((c) => (
                <div
                  key={c.iso}
                  className={`ins-hm-cell l${c.level} ${c.streak ? "streak" : ""} ${c.future ? "future" : ""}`}
                  title={`${c.iso}: ${c.words} words`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="ins-hm-legend">
        <span className="ins-hm-legend-left">
          More
          <i className="ins-hm-cell l4" />
          <i className="ins-hm-cell l3" />
          <i className="ins-hm-cell l2" />
          <i className="ins-hm-cell l1" />
          Less
        </span>
        <span className="ins-hm-legend-right">
          <i className="ins-hm-cell l0 streak" />
          Current streak
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tag cloud

export function TagCloud({ words }: { words: { word: string; count: number }[] }) {
  if (!words.length) return null;
  const max = Math.max(...words.map((w) => w.count));
  const min = Math.min(...words.map((w) => w.count));
  const size = (c: number) => {
    const t = max === min ? 1 : (c - min) / (max - min);
    return 13 + t * 22;
  };
  return (
    <div className="ins-cloud">
      {words.map((w) => (
        <span
          key={w.word}
          style={{ fontSize: size(w.count), opacity: 0.55 + 0.45 * (max === min ? 1 : (w.count - min) / (max - min)) }}
          title={`${w.count}`}
        >
          {w.word}
        </span>
      ))}
    </div>
  );
}
