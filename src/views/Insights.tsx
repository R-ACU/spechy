import { useEffect, useMemo, useState } from "react";
import { Bot, Code2, FileText, Info, Mail, MessageCircle, Minus, MoreHorizontal, Share2, TrendingDown, TrendingUp } from "lucide-react";
import { api, events, type AppCategory, type Stats } from "../lib/ipc";
import { safeCall } from "../lib/mock";
import { useStore } from "../lib/store";
import { Tabs } from "../components/ui";
import { Heatmap, Meter, ShareBar, TagCloud } from "../components/charts";
import "./insights.css";

const EMPTY_STATS: Stats = {
  totalWords: 0, totalDictations: 0, wpm: 0, streakDays: 0, longestStreak: 0,
  fixes: 0, dictionaryFixes: 0, wordsThisMonth: 0, wordsPrevMonth: 0,
  perDay: [], perApp: [], topWords: [], appsUsed: 0,
};

const CATEGORIES: { id: AppCategory; label: string; icon: React.ReactNode }[] = [
  { id: "ai", label: "AI prompts", icon: <Bot size={16} /> },
  { id: "coding", label: "Coding", icon: <Code2 size={16} /> },
  { id: "messages", label: "Personal messages", icon: <MessageCircle size={16} /> },
  { id: "documents", label: "Documents", icon: <FileText size={16} /> },
  { id: "email", label: "Emails", icon: <Mail size={16} /> },
  { id: "other", label: "Other", icon: <MoreHorizontal size={16} /> },
];

const WORDS_PER_BOOK = 90000;
const WPM_SCALE = 200;

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

function booksLine(total: number): string {
  if (total <= 0) return "No words dictated yet";
  const books = total / WORDS_PER_BOOK;
  if (books >= 1) return `About ${books >= 10 ? Math.round(books) : books.toFixed(1)} books of 90,000 words`;
  return `${Math.max(1, Math.round(books * 100))}% of a 90,000 word book`;
}

function Delta({ now, prev }: { now: number; prev: number }) {
  if (!prev) {
    return (
      <span className="iv-delta flat" title="No words last month to compare with">
        <Minus size={13} /> No data last month
      </span>
    );
  }
  const pct = Math.round(((now - prev) / prev) * 100);
  const kind = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const Icon = kind === "up" ? TrendingUp : kind === "down" ? TrendingDown : Minus;
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return (
    <span className={`iv-delta ${kind}`} title="This month so far compared with all of last month">
      <Icon size={13} /> {sign}{fmt(Math.abs(pct))}%
    </span>
  );
}

function Tile({ label, value, hint, sub, children }: { label: string; value: string; hint?: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="card iv-tile">
      <div className="iv-label">
        {label}
        {hint && <span className="iv-hint" title={hint} aria-label={hint}><Info size={13} /></span>}
      </div>
      <div className="iv-num">{value}</div>
      <div className="iv-sub">{sub}</div>
      <div className="iv-tile-foot">{children}</div>
    </section>
  );
}

function Row({ label, value, hint, children }: { label: string; value: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="iv-row">
      <span className="iv-row-label">
        {label}
        {hint && <span className="iv-hint" title={hint} aria-label={hint}><Info size={12} /></span>}
      </span>
      <span className="iv-row-value">{children}{value}</span>
    </div>
  );
}

export default function Insights() {
  const { toast } = useStore();
  const [tab, setTab] = useState<"usage" | "voice">("usage");
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let dead = false;
    const load = async () => {
      let failure: unknown = null;
      const value = await safeCall<Stats | null>(
        () => api.getStats().catch((error: unknown) => { failure = error; throw error; }),
        "stats",
        null,
      );
      if (dead) return;
      if (value) { setStats(value); setLoadError(""); }
      else setLoadError(`Could not load insights: ${String(failure)}`);
    };
    void load();
    let off: (() => void) | undefined;
    try {
      events.onHistoryAdded(() => void load()).then((fn) => { if (dead) fn(); else off = fn; }).catch(() => {});
    } catch { /* no event bridge outside the app */ }
    return () => { dead = true; off?.(); };
  }, []);

  const byCategory = useMemo(() => {
    const map = new Map<AppCategory, number>();
    for (const c of CATEGORIES) map.set(c.id, 0);
    for (const a of stats.perApp) map.set(a.category, (map.get(a.category) ?? 0) + a.count);
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    const rows = CATEGORIES.map((c) => ({ ...c, count: map.get(c.id) ?? 0, share: total ? (map.get(c.id) ?? 0) / total : 0 }));
    rows.sort((a, b) => b.count - a.count);
    return { rows, total };
  }, [stats.perApp]);

  const avgWords = stats.totalDictations ? Math.round(stats.totalWords / stats.totalDictations) : 0;

  const onShare = async () => {
    const text = `Spechy: ${fmt(stats.totalWords)} words dictated, ${stats.wpm} words per minute, ${stats.streakDays} day streak.`;
    try { await api.copyToClipboard(text); toast({ kind: "success", message: "Summary copied to clipboard" }); }
    catch { toast({ kind: "info", message: text }); }
  };

  return (
    <div className="page">
      <div className="page-head iv-head">
        <h1 className="page-title">Insights</h1>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void onShare()} title="Copy a short summary">
          <Share2 size={15} /> Share
        </button>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[{ id: "usage", label: "Your usage" }, { id: "voice", label: "Your voice" }]}
      />

      {loadError && <p role="alert" className="iv-error">{loadError}</p>}

      <div className="iv">
        {tab === "usage" ? (
          <div className="iv-stack rise" key="usage">
            <div className="iv-tiles">
              <Tile label="Total words" value={fmt(stats.totalWords)} sub={booksLine(stats.totalWords)}>
                <Row label="This month" value={fmt(stats.wordsThisMonth)}>
                  <Delta now={stats.wordsThisMonth} prev={stats.wordsPrevMonth} />
                </Row>
                <Row label="Last month" value={fmt(stats.wordsPrevMonth)} />
              </Tile>

              <Tile
                label="Words per minute"
                value={fmt(stats.wpm)}
                hint="Average speaking pace of your recent dictations"
                sub={stats.wpm > 0 ? "Recent speaking pace" : "No recent dictations"}
              >
                <Meter value={stats.wpm} max={WPM_SCALE} label={`${stats.wpm} words per minute on a 0 to ${WPM_SCALE} scale`} />
              </Tile>

              <Tile
                label="Word edits by Spechy"
                value={fmt(stats.fixes)}
                hint="Estimated by comparing the original transcript with the final text"
                sub="From original versus final text"
              >
                <Row label="Dictionary fixes" value={fmt(stats.dictionaryFixes)} hint="Counted separately, not part of the word edits" />
                <Row label="Dictations" value={fmt(stats.totalDictations)} />
              </Tile>
            </div>

            <div className="iv-pair">
              <section className="card iv-card">
                <header className="iv-card-head">
                  <div>
                    <h2 className="iv-title">Where you dictate</h2>
                    <p className="iv-meta">Dictations by app type</p>
                  </div>
                  <span className="iv-chip">{plural(stats.appsUsed, "app")}</span>
                </header>
                {byCategory.total === 0 ? (
                  <div className="iv-empty">Dictate into any app and the split by app type shows up here.</div>
                ) : (
                  <ul className="iv-cats">
                    {byCategory.rows.map((c, i) => (
                      <li className={`iv-cat${c.count === 0 ? " zero" : ""}`} key={c.id}>
                        <span className="iv-cat-icon">{c.icon}</span>
                        <span className="iv-cat-label">{c.label}</span>
                        <span className="iv-cat-count">{fmt(c.count)}</span>
                        <span className="iv-cat-pct">{c.count === 0 ? "0%" : c.share < 0.01 ? "<1%" : `${Math.round(c.share * 100)}%`}</span>
                        <ShareBar share={c.share} strong={i === 0} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="card iv-card">
                <header className="iv-card-head">
                  <div>
                    <h2 className="iv-title">{fmt(stats.streakDays)} day streak</h2>
                    <p className="iv-meta">Longest streak {plural(stats.longestStreak, "day")}</p>
                  </div>
                </header>
                <Heatmap perDay={stats.perDay} streakDays={stats.streakDays} />
              </section>
            </div>
          </div>
        ) : (
          <div className="iv-stack rise" key="voice">
            <div className="iv-summary card">
              <div className="iv-summary-item">
                <span className="iv-summary-num">{fmt(stats.totalDictations)}</span>
                <span className="iv-label">Dictations</span>
              </div>
              <div className="iv-summary-item">
                <span className="iv-summary-num">{fmt(avgWords)}</span>
                <span className="iv-label">Words per dictation</span>
              </div>
              <div className="iv-summary-item">
                <span className="iv-summary-num">{fmt(stats.totalWords)}</span>
                <span className="iv-label">Words in total</span>
              </div>
            </div>

            <section className="card iv-card">
              <header className="iv-card-head">
                <div>
                  <h2 className="iv-title">Your most used words</h2>
                  <p className="iv-meta">Bigger means more often</p>
                </div>
              </header>
              {stats.topWords.length === 0
                ? <div className="iv-empty">Nothing dictated yet.</div>
                : <TagCloud words={stats.topWords.slice(0, 40)} />}
            </section>

            <section className="card iv-card">
              <header className="iv-card-head">
                <div>
                  <h2 className="iv-title">Top 30</h2>
                  <p className="iv-meta">Times used</p>
                </div>
              </header>
              {stats.topWords.length === 0 ? (
                <div className="iv-empty">Nothing dictated yet.</div>
              ) : (
                <ol className="iv-words">
                  {stats.topWords.slice(0, 30).map((w, i) => (
                    <li key={w.word}>
                      <span className="iv-rank">{i + 1}</span>
                      <span className="iv-word">{w.word}</span>
                      <span className="iv-count">{fmt(w.count)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
