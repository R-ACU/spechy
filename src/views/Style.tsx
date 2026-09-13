import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AppStyleRule, Tone } from "../lib/ipc";
import { useStore } from "../lib/store";
import { Button, IconButton, Listbox, Toggle } from "../components/ui";

const TONES: { id: Tone; label: string; desc: string }[] = [
  { id: "neutral", label: "Neutral", desc: "Clean and plain. Keeps your wording, fixes grammar and punctuation." },
  { id: "formal", label: "Formal", desc: "Complete sentences, no contractions, polite address." },
  { id: "casual", label: "Casual", desc: "Relaxed and short. Contractions are fine, small talk stays." },
];

const TONE_OPTIONS = TONES.map((t) => ({ value: t.id, label: t.label }));

export default function Style() {
  const { settings, update } = useStore();
  const style = settings.style;
  const [rules, setRules] = useState<AppStyleRule[]>(style.appRules);
  const [customRules, setCustomRules] = useState(style.customRules);

  const saveStyle = (patch: Partial<typeof style>) => void update({ style: { ...style, ...patch } });

  const setRule = (id: string, patch: Partial<AppStyleRule>) => {
    const next = rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRules(next);
    saveStyle({ appRules: next });
  };

  const addRule = () => {
    const next = [...rules, { id: `rule-${Date.now()}`, appMatch: "", tone: style.defaultTone, note: "" }];
    setRules(next);
    saveStyle({ appRules: next });
  };

  const removeRule = (id: string) => {
    const next = rules.filter((r) => r.id !== id);
    setRules(next);
    saveStyle({ appRules: next });
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Style</h1>
      </div>

      <section className="sty-section rise">
        <h2 className="sty-h2">Default tone</h2>
        <p className="muted sty-sub">How Spechy rewrites your dictation when no app rule matches.</p>
        <div className="sty-tones">
          {TONES.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`sty-tile ${style.defaultTone === t.id ? "active" : ""}`}
              role="radio"
              aria-checked={style.defaultTone === t.id}
              onClick={() => saveStyle({ defaultTone: t.id })}
            >
              <span className="sty-tile-dot" />
              <span className="sty-tile-name">{t.label}</span>
              <span className="sty-tile-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="sty-section">
        <div className="sty-head">
          <div>
            <h2 className="sty-h2">Rules per app</h2>
            <p className="muted sty-sub">Matches the window title or process name, e.g. slack, outlook, code.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={addRule}><Plus size={15} /> Add rule</Button>
        </div>
        <div className="card sty-card">
          {rules.length === 0 ? (
            <div className="empty">No app rules yet.</div>
          ) : (
            rules.map((r) => (
              <div className="sty-rule" key={r.id}>
                <input
                  className="input"
                  placeholder="slack"
                  value={r.appMatch}
                  onChange={(e) => setRule(r.id, { appMatch: e.target.value })}
                />
                <Listbox
                  value={r.tone}
                  options={TONE_OPTIONS}
                  onChange={(v) => setRule(r.id, { tone: v as Tone })}
                  className="sty-rule-tone"
                />
                <input
                  className="input"
                  placeholder="Note, e.g. keep it short"
                  value={r.note}
                  onChange={(e) => setRule(r.id, { note: e.target.value })}
                />
                <IconButton label="Delete rule" onClick={() => removeRule(r.id)}><Trash2 size={16} /></IconButton>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="sty-section">
        <h2 className="sty-h2">Custom rules</h2>
        <p className="muted sty-sub">Free text instructions applied to every dictation.</p>
        <textarea
          className="input sty-textarea"
          rows={5}
          placeholder={"Always write 'AI-OS' with a hyphen. Use 'du' not 'Sie'."}
          value={customRules}
          onChange={(e) => setCustomRules(e.target.value)}
          onBlur={() => saveStyle({ customRules })}
        />
      </section>

      <section className="sty-section">
        <div className="card sty-card">
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">Keep filler words</div>
              <div className="set-row-sub muted">Leave "uhm", "you know" and repetitions in the text instead of cleaning them up.</div>
            </div>
            <Toggle on={style.keepFillers} onChange={(v) => saveStyle({ keepFillers: v })} />
          </div>
        </div>
      </section>
    </div>
  );
}
