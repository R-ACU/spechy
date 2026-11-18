// Pure SVG / CSS chart pieces for the Insights view. No chart library.
// Styles live in src/views/insights.css (prefix "iv-").
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DayStat } from "../lib/ipc";

// -------------------------------------------------------------------- meter

/** Horizontal 0 to max meter with a tiny scale. No population ranking, just the scale. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const filled = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="iv-meter" role="img" aria-label={label}>
      <div className="iv-meter-track">
        <div className="iv-meter-fill" style={{ width: `${filled}%` }} />
      </div>
      <div className="iv-meter-scale">
        <span>0</span>
        <span>{max / 2}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- share bar

/** Thin proportional bar for one row of a breakdown. */
export function ShareBar({ share, strong }: { share: number; strong?: boolean }) {
  const width = share > 0 ? Math.max(1.5, share * 100) : 0;
  return (
    <div className="iv-bar">
      <div className={`iv-bar-fill${strong ? " strong" : ""}`} style={{ width: `${width}%` }} />
    </div>
  );
}

// -------------------------------------------------------------------- heatmap

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TOTAL_WEEKS = 53;
const MIN_CELL = 13; // px, smallest square before a week is dropped
const GAP = 4;
const DAY_COL = 30;

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Cell { date: Date; iso: string; words: number; level: number; streak: boolean; future: boolean }

/** Contribution grid: columns are weeks, rows Sun..Sat. Shows as many weeks as fit the width. */
export function Heatmap({ perDay, streakDays }: { perDay: DayStat[]; streakDays: number }) {
  const [offset, setOffset] = useState(0); // weeks scrolled back from the end
  const [visible, setVisible] = useState(20);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      if (!w) return;
      const n = Math.floor((w - DAY_COL) / (MIN_CELL + GAP));
      setVisible(Math.max(8, Math.min(TOTAL_WEEKS, n)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    if (!perDay.some((day) => day.date === isoDate(today) && day.count > 0)) streakStart.setDate(streakStart.getDate() - 1);
    const streakEnd = new Date(streakStart);
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
        col.push({ date: d, iso, words, level, streak: streakDays > 0 && d >= streakStart && d <= streakEnd, future: d > today });
      }
      out.push(col);
    }
    return out;
  }, [perDay, streakDays]);

  const maxOffset = Math.max(0, weeks.length - visible);
  const off = Math.min(offset, maxOffset);
  const start = weeks.length - visible - off;
  const view = weeks.slice(start, start + visible);

  // A month label sits above the first week whose Sunday falls in that month.
  // The first column only gets a label if the next one is at least 3 weeks away.
  const months: { col: number; label: string }[] = [];
  view.forEach((col, i) => {
    const m = col[0].date.getMonth();
    if (i === 0 || view[i - 1][0].date.getMonth() !== m) months.push({ col: i, label: MONTHS[m] });
  });
  if (months.length > 1 && months[0].col === 0 && months[1].col < 3) months.shift();

  const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const range = view.length ? `${fmtDay(view[0][0].date)} to ${fmtDay(view[view.length - 1][6].date)}` : "";

  return (
    <div className="iv-hm">
      <div
        ref={wrap}
        className="iv-hm-grid"
        style={{ gridTemplateColumns: `${DAY_COL - GAP}px repeat(${visible}, minmax(0, 1fr))` }}
        role="img"
        aria-label={`Words per day, ${range}`}
      >
        {months.map((m) => (
          <span key={`m${m.col}`} className="iv-hm-month" style={{ gridColumn: m.col + 2, gridRow: 1 }}>{m.label}</span>
        ))}
        {DAY_LABELS.map((d, i) => (
          <span key={`d${i}`} className="iv-hm-day" style={{ gridColumn: 1, gridRow: i + 2 }}>{d}</span>
        ))}
        {view.map((col, ci) => col.map((c, di) => (
          <i
            key={c.iso}
            className={`iv-hm-cell l${c.level}${c.streak ? " streak" : ""}${c.future ? " future" : ""}`}
            style={{ gridColumn: ci + 2, gridRow: di + 2 }}
            title={c.future ? undefined : `${fmtDay(c.date)}: ${c.words.toLocaleString("en-US")} words`}
          />
        )))}
      </div>

      <div className="iv-hm-foot">
        <span className="iv-hm-legend">
          Less
          <i className="iv-hm-cell l0" />
          <i className="iv-hm-cell l1" />
          <i className="iv-hm-cell l2" />
          <i className="iv-hm-cell l3" />
          <i className="iv-hm-cell l4" />
          More
        </span>
        <span className="iv-hm-legend">
          <i className="iv-hm-cell l0 streak" />
          Current streak
        </span>
        <span className="iv-hm-nav">
          <button
            type="button"
            className="iv-hm-arrow"
            aria-label="Earlier weeks"
            title="Earlier weeks"
            disabled={off >= maxOffset}
            onClick={() => setOffset(Math.min(maxOffset, off + 4))}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="iv-hm-arrow"
            aria-label="Later weeks"
            title="Later weeks"
            disabled={off <= 0}
            onClick={() => setOffset(Math.max(0, off - 4))}
          >
            <ChevronRight size={16} />
          </button>
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
  const t = (c: number) => (max === min ? 1 : Math.sqrt((c - min) / (max - min)));
  // Shuffle deterministically so the biggest words do not all pile up at the start.
  const ordered = [...words].sort((a, b) => (a.word.length * 7 + a.count) % 5 - (b.word.length * 7 + b.count) % 5);
  return (
    <div className="iv-cloud">
      {ordered.map((w) => {
        const k = t(w.count);
        return (
          <span
            key={w.word}
            className={k > 0.66 ? "lg" : k > 0.33 ? "md" : "sm"}
            style={{ fontSize: Math.round(13 + k * 17) }}
            title={`${w.count.toLocaleString("en-US")} times`}
          >
            {w.word}
          </span>
        );
      })}
    </div>
  );
}
