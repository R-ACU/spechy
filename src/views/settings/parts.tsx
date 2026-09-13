// Shared building blocks for the settings panel.
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/ipc";
import { Eye, EyeOff } from "lucide-react";
import { Kbd } from "../../components/ui";

export function Group({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="set-group">
      {label && <h3 className="set-group-label">{label}</h3>}
      <div className="card set-card">{children}</div>
    </div>
  );
}

export function Row({ label, sub, extra, children }: { label: ReactNode; sub?: ReactNode; extra?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-label">
          {label}
          {extra}
        </div>
        {sub && <div className="set-row-sub muted">{sub}</div>}
      </div>
      {children && <div className="set-row-control">{children}</div>}
    </div>
  );
}

export interface ChoiceOption<T extends string> { value: T; label: string; desc: string }

/** Segmented choice: one tile per option with a one line explanation under the name. */
export function Choice<T extends string>({ value, options, onChange }: { value: T; options: ChoiceOption<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="pv-choice" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`pv-tile ${value === o.value ? "active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          <span className="pv-tile-name">{o.label}</span>
          <span className="pv-tile-desc">{o.desc}</span>
        </button>
      ))}
    </div>
  );
}

/** Renders "Ctrl+Win+Space" as separate key caps. */
export function Chord({ chord }: { chord: string }) {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  return (
    <span className="set-chord">
      {parts.map((p, i) => (
        <span key={`${p}-${i}`}>
          {i > 0 && <span className="set-chord-plus">+</span>}
          <Kbd>{p}</Kbd>
        </span>
      ))}
    </span>
  );
}

export function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="set-secret">
      <input
        className="input"
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="set-secret-eye" aria-label={show ? "Hide" : "Show"} onClick={() => setShow((s) => !s)}>
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

/** Focusable box that records a key chord like "Ctrl+Win+Space". */
export function ChordRecorder({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!active) return;
    void api.suspendHotkeys(true).catch(() => {});
    return () => { void api.suspendHotkeys(false).catch(() => {}); };
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.metaKey) mods.push("Win");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");

    const k = e.key;
    let main = "";
    if (k === "Control" || k === "Meta" || k === "OS" || k === "Alt" || k === "Shift") main = "";
    else if (k === " " || k === "Spacebar") main = "Space";
    else if (/^F\d{1,2}$/i.test(k)) main = k.toUpperCase();
    else if (k === "Escape") main = "Esc";
    else if (k.length === 1) main = k.toUpperCase();
    else main = k;

    const chord = main ? [...mods, main].join("+") : mods.join("+");
    if (chord) onChange(chord);
  };

  return (
    <label className="set-rec">
      <span className="section-label">{label}</span>
      <div
        className={`set-rec-box ${active ? "active" : ""}`}
        tabIndex={0}
        role="button"
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        onKeyDown={onKeyDown}
      >
        {active ? <span className="faint">Press keys...</span> : value ? <Chord chord={value} /> : <span className="faint">Not set</span>}
      </div>
    </label>
  );
}
