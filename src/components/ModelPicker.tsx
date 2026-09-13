// Searchable model dropdown for the provider settings. Never a native <select>:
// a recommended group stays pinned on top, the full catalogue is loaded lazily from
// the backend (api.listModels, cached there for 10 minutes) and any id can be typed.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Pencil, RefreshCw } from "lucide-react";
import { api, type ModelInfo, type ModelSource } from "../lib/ipc";
import { MOCK, mockModels } from "../lib/fallback";

export interface Recommendation { id: string; note?: string }

type LoadState = "idle" | "loading" | "ready" | "error";

interface Row { id: string; name?: string; note?: string; audio?: boolean; free?: boolean }

export function ModelPicker({
  value,
  onChange,
  source,
  recommended = [],
  placeholder = "Pick a model",
  audioOnly = false,
}: {
  value: string;
  onChange: (id: string) => void;
  source: ModelSource;
  recommended?: Recommendation[];
  placeholder?: string;
  /** Sort audio capable models to the top of the catalogue (transcription pickers). */
  audioOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [focus, setFocus] = useState(0);
  const [custom, setCustom] = useState<string | null>(null);
  /** Menu flips above the button when the settings panel has no room below. */
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const close = () => { setOpen(false); setQuery(""); setCustom(null); setFocus(0); };

  const openMenu = () => {
    const box = ref.current?.getBoundingClientRect();
    setUp(!!box && box.bottom + 360 > window.innerHeight && box.top > 360);
    setOpen(true);
  };

  const load = async (refresh: boolean) => {
    setState("loading");
    setError("");
    try {
      const list = await api.listModels(source, refresh);
      setModels(list);
      setState("ready");
    } catch (e) {
      if (MOCK) {
        setModels(mockModels(source));
        setState("ready");
        return;
      }
      setError(String(e));
      setState("error");
    }
  };

  // Fetch once per opening as long as nothing has been loaded yet.
  useEffect(() => {
    if (open && state === "idle") void load(false);
    if (open) setTimeout(() => searchRef.current?.focus(), 0);
  }, [open]);

  // The catalogue belongs to one provider: forget it when the provider changes.
  useEffect(() => {
    setModels([]);
    setState("idle");
    setError("");
  }, [source]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const recommendedRows: Row[] = useMemo(() => {
    const known = new Map(models.map((m) => [m.id, m]));
    return recommended.map((r) => {
      const m = known.get(r.id);
      return { id: r.id, name: m?.name, note: r.note, audio: m?.audio, free: m?.free };
    });
  }, [recommended, models]);

  const allRows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    if (audioOnly) list = [...list].sort((a, b) => Number(b.audio) - Number(a.audio));
    return list.map((m) => ({ id: m.id, name: m.name, audio: m.audio, free: m.free }));
  }, [models, query, audioOnly]);

  const visibleRecommended = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recommendedRows.filter((r) => !q || r.id.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q));
  }, [recommendedRows, query]);

  const flat = useMemo(() => [...visibleRecommended, ...allRows], [visibleRecommended, allRows]);

  const pick = (id: string) => { onChange(id.trim()); close(); };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); openMenu(); }
      return;
    }
    // Stop here so the settings panel does not close along with the menu.
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setFocus((f) => Math.min(flat.length - 1, f + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocus((f) => Math.max(0, f - 1)); }
    else if (e.key === "Enter" && custom === null) {
      e.preventDefault();
      const row = flat[focus];
      if (row) pick(row.id);
    }
  };

  const rowNode = (row: Row, index: number) => (
    <div
      key={`${row.id}-${index}`}
      role="option"
      aria-selected={row.id === value}
      className={`mp-opt ${row.id === value ? "selected" : ""} ${index === focus ? "focus" : ""}`}
      onMouseEnter={() => setFocus(index)}
      onClick={() => pick(row.id)}
    >
      <span className="mp-opt-text">
        <span className="mp-id">{row.id}</span>
        {(row.note || (row.name && row.name !== row.id)) && <span className="mp-name">{row.note ?? row.name}</span>}
      </span>
      <span className="mp-badges">
        {row.free && <span className="mp-badge free">free</span>}
        {row.audio && <span className="mp-badge">audio</span>}
        {row.id === value && <Check size={14} />}
      </span>
    </div>
  );

  return (
    <div className="mp" ref={ref} onKeyDown={onKey}>
      <button type="button" className="mp-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => (open ? close() : openMenu())}>
        <span className="mp-btn-value">{value || <span className="faint">{placeholder}</span>}</span>
        <ChevronDown size={16} style={{ flex: "none", color: "var(--text-2)" }} />
      </button>

      {open && (
        <div className={`mp-menu ${up ? "up" : ""}`} role="listbox">
          <div className="mp-search">
            <input
              ref={searchRef}
              className="input"
              value={query}
              placeholder="Search models"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => { setQuery(e.target.value); setFocus(0); }}
            />
          </div>

          <div className="mp-list">
            {visibleRecommended.length > 0 && (
              <>
                <div className="section-label mp-group">Recommended</div>
                {visibleRecommended.map((r, i) => rowNode(r, i))}
              </>
            )}

            <div className="section-label mp-group">All models</div>
            {state === "loading" && <div className="mp-msg faint">Loading models...</div>}
            {state === "error" && <div className="mp-msg" style={{ color: "var(--danger)" }}>Could not load models: {error}</div>}
            {state === "ready" && allRows.length === 0 && <div className="mp-msg faint">No model matches that search.</div>}
            {allRows.map((r, i) => rowNode(r, visibleRecommended.length + i))}
          </div>

          <div className="mp-foot">
            {custom === null ? (
              <button type="button" className="mp-custom-btn" onClick={() => setCustom(value)}>
                <Pencil size={13} />
                Use a custom id
              </button>
            ) : (
              <input
                className="input mp-custom-input"
                autoFocus
                value={custom}
                placeholder="model id"
                spellCheck={false}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); if (custom.trim()) pick(custom); }
                  if (e.key === "Escape") { e.preventDefault(); setCustom(null); }
                }}
              />
            )}
            <button type="button" className="mp-refresh" onClick={() => void load(true)} disabled={state === "loading"}>
              <RefreshCw size={13} />
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
