import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowUpDown, ClipboardPaste, Pencil, RefreshCw, Search, Trash2, X } from "lucide-react";
import { api, type Snippet } from "../lib/ipc";
import { t, useStore } from "../lib/store";
import { MOCK, mockSnippets, safe } from "../lib/fallback";
import { Button, Dialog, IconButton, Menu, Tabs } from "../components/ui";

type Tab = "all" | "personal";
type Sort = "newest" | "alphabetical" | "most-used";

const SORTS: { id: Sort; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "alphabetical", label: "Alphabetical" },
  { id: "most-used", label: "Most used" },
];

function SnippetDialog({ snippet, onClose, onSave }: {
  snippet: Snippet | null;
  onClose: () => void;
  onSave: (trigger: string, text: string) => void;
}) {
  const [trigger, setTrigger] = useState(snippet?.trigger ?? "");
  const [text, setText] = useState(snippet?.text ?? "");
  const valid = trigger.trim().length > 0 && text.trim().length > 0;
  const submit = () => { if (valid) onSave(trigger.trim(), text.trim()); };

  return (
    <Dialog title={snippet ? "Edit snippet" : "Add a snippet"} onClose={onClose} width={520}>
      <div className="field">
        <label className="field-label" htmlFor="snippet-trigger">Trigger phrase</label>
        <input
          id="snippet-trigger"
          className="input"
          autoFocus
          placeholder="my email address"
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="snippet-text">Snippet text</label>
        <textarea id="snippet-text" className="input" rows={4} placeholder="remo@example.com" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <p className="hint">Say the trigger phrase while dictating and Spechy inserts the snippet text.</p>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={!valid}>{snippet ? "Save snippet" : "Add snippet"}</Button>
      </div>
    </Dialog>
  );
}

/** Edit the spoken phrase of the built-in clipboard command. */
function ClipboardDialog({ phrase, onClose, onSave }: { phrase: string; onClose: () => void; onSave: (phrase: string) => void }) {
  const [value, setValue] = useState(phrase);
  const submit = () => onSave(value.split(",").map((p) => p.trim()).filter(Boolean).join(", "));
  return (
    <Dialog title="Paste your clipboard" onClose={onClose} width={520}>
      <div className="field">
        <label className="field-label" htmlFor="clipboard-phrase">Phrase</label>
        <input
          id="clipboard-phrase"
          className="input"
          autoFocus
          placeholder="paste clipboard"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        />
      </div>
      <p className="hint">Say this phrase while dictating and Spechy puts the text from your clipboard right there. Separate several phrases with commas, leave it empty to turn the command off.</p>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>Save</Button>
      </div>
    </Dialog>
  );
}

export default function Snippets() {
  const { settings, update, toast } = useStore();
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const clipboardPhrase = settings.clipboardPhrase.trim();
  const lang = settings.appLanguage;
  const [items, setItems] = useState<Snippet[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [sortOpen, setSortOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ open: boolean; snippet: Snippet | null }>({ open: false, snippet: null });

  const reload = useCallback(async () => {
    setItems(await safe(() => api.listSnippets(), MOCK ? mockSnippets : []));
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q ? items.filter((s) => s.trigger.toLowerCase().includes(q) || s.text.toLowerCase().includes(q)) : items;
    list = [...list];
    if (sort === "newest") list.sort((a, b) => b.createdAt - a.createdAt);
    if (sort === "alphabetical") list.sort((a, b) => a.trigger.localeCompare(b.trigger));
    if (sort === "most-used") list.sort((a, b) => b.uses - a.uses);
    return list;
  }, [items, query, sort]);

  const save = async (trigger: string, text: string) => {
    const editing = dialog.snippet;
    setDialog({ open: false, snippet: null });
    try {
      if (editing) {
        const saved = await api.updateSnippet({ ...editing, trigger, text });
        setItems((l) => l.map((x) => (x.id === saved.id ? saved : x)));
      } else {
        const added = await api.addSnippet(trigger, text);
        setItems((l) => [added, ...l]);
      }
      toast({ kind: "success", message: editing ? "Snippet updated" : "Snippet added" });
    } catch {
      toast({ kind: "error", message: "Could not save the snippet" });
    }
  };

  const remove = (s: Snippet) => {
    setItems((l) => l.filter((x) => x.id !== s.id));
    api.deleteSnippet(s.id).catch(() => {});
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("Snippets", lang)}</h1>
        <Button onClick={() => setDialog({ open: true, snippet: null })}>{t("Add new", lang)}</Button>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[{ id: "all", label: t("All", lang) }, { id: "personal", label: t("Personal", lang) }]}
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
        {(!query.trim() || `${clipboardPhrase} clipboard`.toLowerCase().includes(query.trim().toLowerCase())) && (
          <div className="list-row snippet-builtin">
            <div className="list-text">
              <span className="pair one-line">
                <ClipboardPaste size={16} className="snippet-builtin-icon" aria-hidden="true" />
                <span className={clipboardPhrase ? "" : "faint"}>{clipboardPhrase || "Off"}</span>
                <ArrowRight size={16} className="pair-arrow" />
                <span className="snippet-text faint">Your clipboard text</span>
              </span>
            </div>
            <div className="row-actions">
              <IconButton label={t("Edit", lang)} onClick={() => setClipboardOpen(true)}><Pencil size={17} /></IconButton>
            </div>
          </div>
        )}
        {shown.length === 0 && <div className="empty">No snippets yet. Add one with the button above.</div>}
        {shown.map((s) => (
          <div key={s.id} className="list-row">
            <div className="list-text" title={s.text}>
              <span className="pair one-line">
                <span>{s.trigger}</span>
                <ArrowRight size={16} className="pair-arrow" />
                <span className="snippet-text">{s.text}</span>
              </span>
            </div>
            <div className="row-actions">
              <IconButton label={t("Edit", lang)} onClick={() => setDialog({ open: true, snippet: s })}><Pencil size={17} /></IconButton>
              <IconButton label={t("Delete", lang)} onClick={() => remove(s)}><Trash2 size={17} /></IconButton>
            </div>
          </div>
        ))}
      </div>

      {clipboardOpen && (
        <ClipboardDialog
          phrase={settings.clipboardPhrase}
          onClose={() => setClipboardOpen(false)}
          onSave={(phrase) => { setClipboardOpen(false); void update({ clipboardPhrase: phrase }); }}
        />
      )}
      {dialog.open && (
        <SnippetDialog
          key={dialog.snippet?.id ?? "new"}
          snippet={dialog.snippet}
          onClose={() => setDialog({ open: false, snippet: null })}
          onSave={save}
        />
      )}
    </div>
  );
}
