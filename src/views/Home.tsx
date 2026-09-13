import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Flag, MoreVertical, Search, Trash2, Wand2, X } from "lucide-react";
import { api, events, type HistoryEntry, type Stats } from "../lib/ipc";
import { t, useStore } from "../lib/store";
import { MOCK, mockHistoryPage, mockStats, safe } from "../lib/fallback";
import { Button, Dialog, IconButton, Kbd, Menu, compactNumber, dayLabel, formatTime } from "../components/ui";

const PAGE = 50;

function copyText(text: string, ok: () => void) {
  api.copyToClipboard(text).catch(() => navigator.clipboard?.writeText(text).catch(() => {}));
  ok();
}

function Hotkey({ chord }: { chord: string }) {
  const parts = chord.split("+").filter(Boolean);
  return (
    <span className="kbd-row">
      {parts.map((p, i) => (
        <span key={p + i} className="kbd-part">
          {i > 0 && <span className="kbd-plus">+</span>}
          <Kbd>{p}</Kbd>
        </span>
      ))}
    </span>
  );
}

function Row({ entry, onChange, onDelete, onToast }: {
  entry: HistoryEntry;
  onChange: (e: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onToast: (m: string) => void;
}) {
  const { settings } = useStore();
  const [menu, setMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [raw, setRaw] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (el) setClamped(el.scrollHeight - el.clientHeight > 2);
  }, [entry.text]);

  const flag = () => {
    const next = !entry.flagged;
    onChange({ ...entry, flagged: next });
    api.setHistoryFlag(entry.id, next).catch(() => {});
  };

  const repolish = () => {
    setMenu(false);
    api.repolishHistory(entry.id)
      .then((e) => { onChange(e); onToast("Re-polished"); })
      .catch(() => onToast("Re-polish failed"));
  };

  const remove = () => {
    setMenu(false);
    api.deleteHistory(entry.id).then(() => onDelete(entry.id)).catch(() => onToast("Could not delete dictation"));
  };

  return (
    <div className="hist-row">
      <div className="hist-time">{formatTime(entry.createdAt, settings.appLanguage)}</div>
      <div className="hist-body">
        <div ref={textRef} className={expanded ? "hist-text" : "hist-text clamp"}>{entry.text}</div>
        {clamped && (
          <button className="link-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      <div className="hist-actions">
        <IconButton label="Copy" onClick={() => copyText(entry.text, () => onToast("Copied"))}><Copy size={17} /></IconButton>
        <IconButton label={entry.flagged ? "Unflag" : "Flag"} className={entry.flagged ? "on" : ""} onClick={flag}>
          <Flag size={17} fill={entry.flagged ? "currentColor" : "none"} />
        </IconButton>
        <div className="menu-anchor">
          <IconButton label="More" onClick={() => setMenu((v) => !v)}><MoreVertical size={17} /></IconButton>
          <Menu open={menu} onClose={() => setMenu(false)}>
            <button className="menu-item" onClick={() => { setMenu(false); setRaw(true); }}><Search size={15} />Show original transcript</button>
            <button className="menu-item" onClick={repolish}><Wand2 size={15} />Re-polish</button>
            <button className="menu-item" onClick={() => { setMenu(false); copyText(entry.text, () => onToast("Copied")); }}><Copy size={15} />Copy</button>
            <button className="menu-item danger" onClick={remove}><Trash2 size={15} />Delete</button>
          </Menu>
        </div>
      </div>
      {raw && (
        <Dialog title="Original transcript" onClose={() => setRaw(false)} width={560}>
          <div className="meta-row">
            <span>{entry.appTitle || entry.appName || "Unknown app"}</span>
            <span className="faint">{(entry.durationMs / 1000).toFixed(1)} s</span>
            <span className="faint">{entry.latencyMs} ms latency</span>
            <span className="faint">{entry.wordCount} words</span>
          </div>
          <div className="transcript-block">
            <div className="section-label">Raw</div>
            <p className="transcript-text">{entry.rawText || "(not stored)"}</p>
          </div>
          <div className="transcript-block">
            <div className="section-label">Polished</div>
            <p className="transcript-text">{entry.text}</p>
          </div>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => copyText(entry.rawText || entry.text, () => onToast("Copied"))}>Copy raw</Button>
            <Button onClick={() => setRaw(false)}>Close</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default function Home() {
  const { settings, toast } = useStore();
  const lang = settings.appLanguage;
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadStats = useCallback(() => {
    void safe(() => api.getStats(), MOCK ? mockStats : null).then((s) => { if (s) setStats(s); });
  }, []);

  const load = useCallback(async (offset: number, q: string) => {
    setLoading(true);
    const page = await safe(() => api.listHistory(PAGE, offset, q), MOCK ? mockHistoryPage : { entries: [], total: 0 });
    setTotal(page.total);
    setEntries((prev) => (offset === 0 ? page.entries : [...prev, ...page.entries]));
    setLoading(false);
  }, []);

  useEffect(() => {
    const h = window.setTimeout(() => { void load(0, query); }, query ? 200 : 0);
    return () => window.clearTimeout(h);
  }, [query, load]);

  useEffect(() => { loadStats(); }, [loadStats]);

  useEffect(() => {
    let un: (() => void) | undefined;
    events.onHistoryAdded((e) => {
      setEntries((prev) => [e, ...prev]);
      setTotal((n) => n + 1);
      loadStats();
    }).then((f) => { un = f; }).catch(() => {});
    return () => un?.();
  }, [loadStats]);

  const hasMore = entries.length < total;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver((es) => {
      if (es[0]?.isIntersecting) void load(entries.length, query);
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, entries.length, query, load]);

  const groups = useMemo(() => {
    const out: { label: string; rows: HistoryEntry[] }[] = [];
    for (const e of entries) {
      const label = dayLabel(e.createdAt, lang);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(e);
      else out.push({ label, rows: [e] });
    }
    return out;
  }, [entries, lang]);

  const onChange = (e: HistoryEntry) => { setEntries((prev) => prev.map((x) => (x.id === e.id ? e : x))); loadStats(); };
  const onDelete = (id: string) => { setEntries((prev) => prev.filter((x) => x.id !== id)); setTotal((n) => Math.max(0, n - 1)); loadStats(); };


  return (
    <div className="page home">
      <div className="page-head">
        <h1 className="page-title">{t("Welcome back", lang)}, {settings.userName || "there"}</h1>
        <div className="head-tools">
          {searchOpen ? (
            <div className="search-field">
              <Search size={16} className="search-icon" />
              <input className="input search-input" autoFocus placeholder={t("Search", lang)} value={query} onChange={(e) => setQuery(e.target.value)} />
              <IconButton label="Clear search" onClick={() => { setQuery(""); setSearchOpen(false); }}><X size={15} /></IconButton>
            </div>
          ) : (
            <IconButton label={t("Search", lang)} onClick={() => setSearchOpen(true)}><Search size={18} /></IconButton>
          )}
        </div>
      </div>

      <div className="home-grid">
        <div className="home-main">
          {entries.length === 0 && !loading && (
            <div className="empty-state">
              <p className="empty-lead">Hold <Hotkey chord={settings.hotkeys.pushToTalk} /> and speak.</p>
              <p className="faint">Your dictations show up here.</p>
            </div>
          )}
          {groups.map((g) => (
            <section key={g.label} className="day-group">
              <div className="section-label day-label">{g.label}</div>
              <div className="hist-card">
                {g.rows.map((e) => (
                  <Row key={e.id} entry={e} onChange={onChange} onDelete={onDelete} onToast={(m) => toast({ kind: "success", message: m })} />
                ))}
              </div>
            </section>
          ))}
          <div ref={sentinel} />
          {hasMore && (
            <div className="load-more">
              <Button variant="secondary" onClick={() => void load(entries.length, query)} disabled={loading}>
                {loading ? "Loading" : "Load more"}
              </Button>
            </div>
          )}
        </div>

        <aside className="home-side">
          <div className="side-card">
            <div className="stat-line"><span className="stat-num">{compactNumber(stats?.totalWords ?? 0)}</span><span className="stat-label">{t("total words", lang)}</span></div>
            <div className="stat-line"><span className="stat-num">{stats?.wpm ?? 0}</span><span className="stat-label">{t("wpm", lang)}</span></div>
            <div className="stat-line"><span className="stat-num">{stats?.streakDays ?? 0}</span><span className="stat-label">{t("day streak", lang)}</span></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
