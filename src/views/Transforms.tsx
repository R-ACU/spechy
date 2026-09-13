import { useEffect, useState } from "react";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type Transform } from "../lib/ipc";
import { safeCall } from "../lib/mock";
import { useStore } from "../lib/store";
import { Button, Dialog, IconButton, Listbox } from "../components/ui";

export default function Transforms() {
  const { toast } = useStore();
  const [items, setItems] = useState<Transform[]>([]);
  const [editing, setEditing] = useState<Transform | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [pick, setPick] = useState("");
  const [result, setResult] = useState("");
  const [running, setRunning] = useState(false);

  const load = () => { void safeCall(() => api.listTransforms(), "transforms", []).then(setItems); };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!pick && items.length) setPick(items[0].id); }, [items, pick]);

  const openNew = () => { setCreating(true); setEditing(null); setName(""); setPrompt(""); };
  const openEdit = (t: Transform) => { setCreating(false); setEditing(t); setName(t.name); setPrompt(t.prompt); };
  const close = () => { setCreating(false); setEditing(null); };

  const save = async () => {
    if (!name.trim() || !prompt.trim()) return;
    try {
      if (editing) await api.updateTransform({ ...editing, name: name.trim(), prompt: prompt.trim() });
      else await api.addTransform(name.trim(), prompt.trim());
      load();
      toast({ kind: "success", message: editing ? "Transform updated" : "Transform added" });
    } catch {
      toast({ kind: "error", message: "Could not save the transform" });
    }
    close();
  };

  const remove = async (id: string) => {
    try { await api.deleteTransform(id); load(); } catch { toast({ kind: "error", message: "Could not delete the transform" }); }
    setConfirmId(null);
  };

  const run = async () => {
    if (!pick || !input.trim()) return;
    setRunning(true);
    try {
      const out = await api.applyTransform(pick, input);
      setResult(out);
    } catch {
      toast({ kind: "error", message: "The transform could not run" });
    }
    setRunning(false);
  };

  const copy = async () => {
    try { await api.copyToClipboard(result); toast({ kind: "success", message: "Copied" }); }
    catch { toast({ kind: "error", message: "Could not copy" }); }
  };

  const deleteTarget = items.find((t) => t.id === confirmId);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Transforms</h1>
        <Button onClick={openNew}><Plus size={16} /> Add new</Button>
      </div>
      <p className="muted tr-intro">
        A transform is a saved instruction that rewrites a piece of text. Pick one in the pill while dictating, or try it here.
      </p>

      <div className="tr-grid rise">
        <div className="card tr-list">
          {items.length === 0 ? (
            <div className="empty">No transforms yet.</div>
          ) : (
            items.map((t) => (
              <div className="tr-row" key={t.id}>
                <div className="tr-row-main">
                  <div className="tr-row-name">
                    {t.name}
                    {t.builtin && <span className="tr-badge">Built in</span>}
                  </div>
                  <div className="tr-row-prompt muted">{t.prompt}</div>
                </div>
                <div className="tr-row-actions">
                  <IconButton label="Edit" onClick={() => openEdit(t)}><Pencil size={15} /></IconButton>
                  {!t.builtin && <IconButton label="Delete" onClick={() => setConfirmId(t.id)}><Trash2 size={15} /></IconButton>}
                </div>
              </div>
            ))
          )}
        </div>

        <aside className="card tr-try">
          <h2 className="tr-try-title">Try it</h2>
          <textarea
            className="input tr-try-input"
            rows={6}
            placeholder="Paste or dictate text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Listbox
            value={pick}
            options={items.map((t) => ({ value: t.id, label: t.name }))}
            onChange={setPick}
            placeholder="Pick a transform"
          />
          <Button onClick={() => void run()} disabled={running || !pick || !input.trim()}>
            {running ? "Running" : "Run"}
          </Button>
          {result && (
            <div className="tr-result">
              <div className="tr-result-text">{result}</div>
              <div className="tr-result-actions">
                <Button variant="secondary" size="sm" onClick={() => void copy()}><Copy size={14} /> Copy</Button>
                <Button variant="ghost" size="sm" onClick={() => { setInput(result); setResult(""); }}>Replace input</Button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {(creating || editing) && (
        <Dialog title={editing ? "Edit transform" : "New transform"} onClose={close}>
          <label className="tr-field">
            <span className="section-label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Make it shorter" autoFocus />
          </label>
          <label className="tr-field">
            <span className="section-label">Prompt</span>
            <textarea
              className="input"
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Rewrite the text so it is half as long and keeps every fact."
            />
          </label>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button onClick={() => void save()} disabled={!name.trim() || !prompt.trim()}>Save</Button>
          </div>
        </Dialog>
      )}

      {deleteTarget && (
        <Dialog title="Delete transform" onClose={() => setConfirmId(null)} width={420}>
          <p className="muted">Delete "{deleteTarget.name}"? This cannot be undone.</p>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setConfirmId(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void remove(deleteTarget.id)}>Delete</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
