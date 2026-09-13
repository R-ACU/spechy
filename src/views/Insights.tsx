import { useEffect, useMemo, useState } from "react";
import { Bot, Code2, FileText, Infinity as InfinityIcon, Info, Mail, MessageCircle, Monitor, TrendingUp } from "lucide-react";
import { api, events, type AppCategory, type Stats } from "../lib/ipc";
import { useStore } from "../lib/store";
import { Tabs } from "../components/ui";
import { DeviceBar, Gauge, Heatmap, PercentBar, ShareStamp, TagCloud } from "../components/charts";

const EMPTY_STATS: Stats = {
  totalWords: 0, totalDictations: 0, wpm: 0, streakDays: 0, longestStreak: 0,
  fixes: 0, dictionaryFixes: 0, wordsThisMonth: 0, wordsPrevMonth: 0,
  perDay: [], perApp: [], topWords: [], appsUsed: 0,
};

const CATEGORIES: { id: AppCategory; label: string; icon: React.ReactNode }[] = [
  { id: "ai", label: "AI PROMPTS", icon: <Bot size={18} /> },
  { id: "coding", label: "CODING", icon: <Code2 size={18} /> },
  { id: "messages", label: "PERSONAL MESSAGES", icon: <MessageCircle size={18} /> },
  { id: "documents", label: "DOCUMENTS", icon: <FileText size={18} /> },
  { id: "email", label: "EMAILS", icon: <Mail size={18} /> },
  { id: "other", label: "OTHER", icon: <InfinityIcon size={18} /> },
];

const WORDS_PER_BOOK = 90000;

/** 2998 -> "3K", 240 -> "240". Keeps the badge short like the reference. */
function compactPercent(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

export default function Insights() {
  const { toast } = useStore();
  const [tab, setTab] = useState<"usage" | "voice">("usage");
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let dead = false;
    const load = () => {
      void api.getStats().then((value) => {
        if (!dead) { setStats(value); setLoadError(""); }
      }).catch((error) => { if (!dead) setLoadError(`Could not load insights: ${String(error)}`); });
    };
    load();
    let off: (() => void) | undefined;
    events.onHistoryAdded(() => load()).then((fn) => { if (dead) fn(); else off = fn; }).catch(() => {});
    return () => { dead = true; off?.(); };
  }, []);

  const byCategory = useMemo(() => {
    const map = new Map<AppCategory, number>();
    for (const c of CATEGORIES) map.set(c.id, 0);
    for (const a of stats.perApp) map.set(a.category, (map.get(a.category) ?? 0) + a.count);
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    const rows = CATEGORIES.map((c) => ({ ...c, count: map.get(c.id) ?? 0, share: total ? (map.get(c.id) ?? 0) / total : 0 }));
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }, [stats.perApp]);

  const monthDelta = useMemo(() => {
    if (!stats.wordsPrevMonth) return null;
    return Math.round(((stats.wordsThisMonth - stats.wordsPrevMonth) / stats.wordsPrevMonth) * 100);
  }, [stats.wordsThisMonth, stats.wordsPrevMonth]);

  const books = stats.totalWords / WORDS_PER_BOOK;
  const avgWords = stats.totalDictations ? Math.round(stats.totalWords / stats.totalDictations) : 0;

  const onShare = async () => {
    const text = `Spechy: ${stats.totalWords.toLocaleString("en-US")} words dictated, ${stats.wpm} words per minute, ${stats.streakDays} day streak.`;
    try { await api.copyToClipboard(text); toast({ kind: "success", message: "Summary copied to clipboard" }); }
    catch { toast({ kind: "info", message: text }); }
  };

  return (
    <div className="page">
      <div className="page-head ins-head">
        <h1 className="page-title">Insights</h1>
        <ShareStamp onClick={() => void onShare()} />
      </div>

      {loadError && <p role="alert" className="muted">{loadError}</p>}

      <Tabs
        value={tab}
        onChange={setTab}
        items={[{ id: "usage", label: "Your usage" }, { id: "voice", label: "Your voice" }]}
      />

      {tab === "usage" ? (
        <div className="ins-grid rise">
          <section className="card ins-card">
            <div className="ins-big">{stats.wpm.toLocaleString("en-US")}</div>
            <div className="ins-cap">
              Words per minute
              <Info size={13} className="faint" />
            </div>
            <Gauge wpm={stats.wpm} />
          </section>

          <section className="card ins-card">
            <div className="ins-big">{stats.fixes.toLocaleString("en-US")}</div>
            <div className="ins-cap">Word edits by Spechy</div>
            <div className="ins-rule" />
            <div className="ins-fix-row">
              <span>Estimated from original and final text</span>
              <Info size={14} className="faint" />
            </div>
            <div className="ins-fix-row">
              <span>{stats.dictionaryFixes.toLocaleString("en-US")} dictionary fixes</span>
              <Info size={14} className="faint" />
            </div>
          </section>

          <section className="card ins-card">
            <div className="ins-card-top">
              <div>
                <div className="ins-big">{stats.totalWords.toLocaleString("en-US")}</div>
                <div className="ins-cap">Total words dictated</div>
              </div>
              <span className="ins-pill">
                <TrendingUp size={13} />
                {monthDelta === null ? "No previous month to compare" : `${monthDelta >= 0 ? "+" : "-"}${compactPercent(Math.abs(monthDelta))}% vs last month`}
              </span>
            </div>
            <div className="ins-rule" />
            <p className="ins-books">
              {books >= 1
                ? `You've written ${Math.floor(books)} complete book${Math.floor(books) === 1 ? "" : "s"}!`
                : `${Math.round(books * 100)}% of a book (90,000 words)`}
            </p>
            <DeviceBar label="Desktop" icon={<Monitor size={14} />} />
          </section>

        </div>
      ) : null}

      {tab === "usage" ? (
        <div className="ins-grid-2 rise">
          <section className="card ins-card">
            <div className="ins-card-top">
              <h2 className="ins-h2">Desktop usage</h2>
              <span className="ins-meta">Total apps used | {stats.appsUsed}</span>
            </div>
            <div className="ins-cats">
              {byCategory.map((c, i) => (
                <div className="ins-cat" key={c.id}>
                  <span className="ins-cat-icon">{c.icon}</span>
                  <PercentBar share={c.share} strong={i === 0 && c.share > 0} />
                  <span className="ins-cat-label">{c.count.toLocaleString("en-US")} {c.label}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="card ins-card">
            <div className="ins-card-top">
              <h2 className="ins-h2">{stats.streakDays} day streak</h2>
              <span className="ins-meta">Longest streak | {stats.longestStreak} days</span>
            </div>
            <Heatmap perDay={stats.perDay} streakDays={stats.streakDays} />
          </section>
        </div>
      ) : (
        <div className="ins-voice rise">
          <p className="muted ins-voice-sum">
            {stats.totalDictations.toLocaleString("en-US")} dictations, {avgWords} words per dictation on average,
            {" "}{stats.totalWords.toLocaleString("en-US")} words in total.
          </p>
          <section className="card ins-card">
            <h2 className="ins-h2">Your most used words</h2>
            <TagCloud words={stats.topWords.slice(0, 40)} />
          </section>
          <section className="card ins-card">
            <h2 className="ins-h2">Top 30</h2>
            {stats.topWords.length === 0 ? (
              <div className="empty">Nothing dictated yet.</div>
            ) : (
              <ol className="ins-wordlist">
                {stats.topWords.slice(0, 30).map((w, i) => (
                  <li key={w.word}>
                    <span className="faint ins-rank">{i + 1}</span>
                    <span className="ins-word">{w.word}</span>
                    <span className="muted">{w.count.toLocaleString("en-US")}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
