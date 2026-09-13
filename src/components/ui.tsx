// Shared primitives used by every view. Styles live in src/styles.css (.btn, .toggle, .listbox, .dialog, ...).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export function Button({ variant = "primary", size, className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" }) {
  return <button className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className}`} {...rest} />;
}

export function IconButton({ label, className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button className={`icon-btn ${className}`} aria-label={label} title={label} {...rest} />;
}

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} disabled={disabled} className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

export function Tabs<T extends string>({ value, onChange, items, tools }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[]; tools?: ReactNode }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? "active" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
      {tools && <div className="tabs-tools">{tools}</div>}
    </div>
  );
}

export interface ListboxOption { value: string; label: string; hint?: string }

/** Custom dropdown (native <select> renders an unstylable OS list on Windows). Keyboard: Enter/Space open, arrows move, Enter selects, Escape closes. */
export function Listbox({ value, options, onChange, placeholder = "Select", className = "" }: { value: string; options: ListboxOption[]; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const openMenu = () => { setFocus(Math.max(0, options.findIndex((o) => o.value === value))); setOpen(true); };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setFocus((f) => Math.min(options.length - 1, f + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocus((f) => Math.max(0, f - 1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const o = options[focus]; if (o) { onChange(o.value); setOpen(false); } }
  };

  return (
    <div className={`listbox ${className}`} ref={ref} onKeyDown={onKey}>
      <button type="button" className="listbox-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => (open ? setOpen(false) : openMenu())}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current?.label ?? <span className="faint">{placeholder}</span>}</span>
        <ChevronDown size={16} style={{ flex: "none", color: "var(--text-2)" }} />
      </button>
      {open && (
        <div className="listbox-menu" role="listbox" id={id}>
          {options.map((o, i) => (
            <div key={o.value} role="option" aria-selected={o.value === value} data-value={o.value} className={`listbox-opt ${o.value === value ? "selected" : ""} ${i === focus ? "focus" : ""}`} onMouseEnter={() => setFocus(i)} onClick={() => { onChange(o.value); setOpen(false); }}>
              <span>{o.label}{o.hint && <span className="faint" style={{ marginLeft: 8, fontSize: 12 }}>{o.hint}</span>}</span>
              {o.value === value && <Check size={14} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Dialog({ title, onClose, children, width }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={width ? { width } : undefined}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3>{title}</h3>
          <IconButton label="Close" onClick={onClose} style={{ marginTop: -12 }}><X size={16} /></IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Small context menu anchored to a button. Renders children as .menu-item buttons. */
export function Menu({ open, onClose, children, align = "right" }: { open: boolean; onClose: () => void; children: ReactNode; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className="menu" style={{ top: "calc(100% + 4px)", [align]: 0 }}>{children}</div>;
}

export function Kbd({ children }: { children: ReactNode }) { return <span className="kbd">{children}</span>; }

export function formatTime(ms: number, lang: string = "en"): string {
  return new Date(ms).toLocaleTimeString(lang === "de" ? "de-DE" : "en-US", { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(ms: number, lang: string = "en"): string {
  const d = new Date(ms); const today = new Date();
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return lang === "de" ? "HEUTE" : "TODAY";
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (same(d, y)) return lang === "de" ? "GESTERN" : "YESTERDAY";
  return d.toLocaleDateString(lang === "de" ? "de-DE" : "en-US", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}
