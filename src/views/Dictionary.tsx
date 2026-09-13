import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowUpDown, Info, Pencil, RefreshCw, Search, Sparkles, Star, Trash2, X } from "lucide-react";
import { api, type DictionaryEntry } from "../lib/ipc";
import { t, useStore } from "../lib/store";
import { MOCK, mockDictionary, safe } from "../lib/fallback";
import { Button, Dialog, IconButton, Menu, Tabs, Toggle } from "../components/ui";

type Tab = "all" | "personal" | "starred";
type Sort = "newest" | "alphabetical" | "most-used";

const SORTS: { id: Sort; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "alphabetical", label: "Alphabetical" },
  { id: "most-used", label: "Most used" },
];

function EntryDialog({ entry, onClose, onSave }: {
  entry: DictionaryEntry | null;
  onClose: () => void;
  onSave: (word: string, misspelling: string) => void;
}) {
  const [fix, setFix] = useState(Boolean(entry?.misspelling));
  const [word, setWord] = useState(entry?.word ?? "");
  const [misspelling, setMisspelling] = useState(entry?.misspelling ?? "");
  const valid = word.trim().length > 0 && (!fix || misspelling.trim().length > 0);

  const submit = () => { if (valid) onSave(word.trim(), fix ? misspelling.trim() : ""); };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };

  return (
    <Dialog title={entry ? "Edit vocabulary" : "Add to vocabulary"} onClose={onClose} width={500}>
      <div className="dialog-row">
        <span className="row-label">Correct a misspelling <Info size={14} className="faint" aria-label="Map a word Spechy hears wrong to the spelling you want" /></span>
        <Toggle on={fix} onChange={setFix} />
      </div>
      {fix ? (
        <div className="fix-row" onKeyDown={onKey}>
          <input className="input" autoFocus placeholder="Misspelling" value={misspelling} onChange={(e) => setMisspelling(e.target.value)} />
          <ArrowRight size={18} className="faint fix-arrow" />
          <input className="input" placeholder="Correct spelling" value={word} onChange={(e) => setWord(e.target.value)} />
        </div>
      ) : (
        <div className="fix-row single" onKeyDown={onKey}>
          <input className="input" autoFocus placeholder="Word" value={word} onChange={(e) => setWord(e.target.value)} />
        </div>
      )}
      <div className="dialog-actions">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={!valid}>{entry ? "Save word" : "Add word"}</Button>
      </div>
    </Dialog>
  );
}

export default function Dictionary() {
  const { settings, toast } = useStore();
  const lang = settings.appLanguage;
  const [items, setItems] = useState<DictionaryEntry[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [sortOpen, setSortOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ open: boolean; entry: DictionaryEntry | null }>({ open: false, entry: null });

  const reload = useCallback(async () => {
    setItems(await safe(() => api.listDictionary(), MOCK ? mockDictionary : []));
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const shown = useMemo(() => {
    let list = items;
    if (tab === "personal") list = list.filter((e) => !e.autoLearned);
    if (tab === "starred") list = list.filter((e) => e.starred);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((e) => e.word.toLowerCase().includes(q) || e.misspelling.toLowerCase().includes(q));
    const sorted = [...list];
    if (sort === "newest") sorted.sort((a, b) => b.createdAt - a.createdAt);
    if (sort === "alphabetical") sorted.sort((a, b) => a.word.localeCompare(b.word));
    if (sort === "most-used") sorted.sort((a, b) => b.uses - a.uses);
    return sorted;
  }, [items, tab, query, sort]);

  const save = async (word: string, misspelling: string) => {
    const editing = dialog.entry;
    setDialog({ open: false, entry: null });
    try {
      if (editing) {
        const saved = await api.updateDictionary({ ...editing, word, misspelling });
        setItems((l) => l.map((x) => (x.id === saved.id ? saved : x)));
      } else {
        const added = await api.addDictionary(word, misspelling);
        setItems((l) => [added, ...l]);
      }
      toast({ kind: "success", message: editing ? "Word updated" : "Word added" });
    } catch {
      toast({ kind: "error", message: "Could not save the word" });
    }
  };

  const remove = (e: DictionaryEntry) => {
    setItems((l) => l.filter((x) => x.id !== e.id));
    api.deleteDictionary(e.id).catch(() => {});
  };

  const star = (e: DictionaryEntry) => {
    const next = { ...e, starred: !e.starred };
    setItems((l) => l.map((x) => (x.id === e.id ? next : x)));
    api.updateDictionary(next).catch(() => {});
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("Dictionary", lang)}</h1>
        <Button onClick={() => setDialog({ open: true, entry: null })}>{t("Add new", lang)}</Button>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[{ id: "all", label: t("All", lang) }, { id: "personal", label: t("Personal", lang) }, { id: "starred", label: "Starred" }]}
        tools={
          <>
            {searchOpen && (
              <div className="search-field inline">
                <Search size={16} className="search-icon" />
                <input className="input search-input" autoFocus placeholder={t("Search", lang)} value={query} onChange={(e) => setQuery(e.target.value)} />
                <IconButton label="Clear search" onClick={() => { setQuery(""); setSearchOpen(false); }}><X size={15} /></IconButton>
              </div>
            )}
            {!searchOpen && <IconButton label={t("Search", lang)} onClick={() => setSearchOpen(true)}><Search size={18} /></IconButton>}
            <div className="menu-anchor">
              <IconButton label="Sort" onClick={() => setSortOpen((v) => !v)}><ArrowUpDown size={18} /></IconButton>
              <Menu open={sortOpen} onClose={() => setSortOpen(false)}>
                {SORTS.map((s) => (
                  <button key={s.id} className={s.id === sort ? "menu-item selected" : "menu-item"} onClick={() => { setSort(s.id); setSortOpen(false); }}>{s.label}</button>
                ))}
              </Menu>
            </div>
            <IconButton label="Reload" onClick={() => void reload()}><RefreshCw size={18} /></IconButton>
          </>
        }
      />

      <div className="list-card">
        {shown.length === 0 && <div className="empty">No words yet. Add one with the button above.</div>}
        {shown.map((e) => (
          <div key={e.id} className="list-row">
            <div className="list-text">
              {e.misspelling ? (
                <span className="pair"><span className="faint-strong">{e.misspelling}</span><ArrowRight size={16} className="pair-arrow" /><span>{e.word}</span></span>
              ) : (
                <span>{e.word}</span>
              )}
              {e.autoLearned && <Sparkles size={15} className="learned" aria-label="Learned automatically" />}
            </div>
            <div className="row-actions">
              <IconButton label={t("Edit", lang)} onClick={() => setDialog({ open: true, entry: e })}><Pencil size={17} /></IconButton>
              <IconButton label={t("Delete", lang)} onClick={() => remove(e)}><Trash2 size={17} /></IconButton>
              <IconButton label={e.starred ? "Unstar" : "Star"} className={e.starred ? "on" : ""} onClick={() => star(e)}>
                <Star size={17} fill={e.starred ? "currentColor" : "none"} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>

      {dialog.open && (
        <EntryDialog
          key={dialog.entry?.id ?? "new"}
          entry={dialog.entry}
          onClose={() => setDialog({ open: false, entry: null })}
          onSave={save}
        />
      )}
    </div>
  );
}
