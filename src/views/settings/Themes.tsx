// Settings > Themes: one card per theme with a live preview drawn from that theme's own tokens.
// Keyboard: arrow keys, Home and End move between cards, Enter or Space applies.
import { useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { useStore } from "../../lib/store";
import { isThemeId, THEMES } from "../../themes/registry";
import { useThemeSwitch } from "../../themes/ThemeSwitch";

/** Still textures for the previews, computed once from the same formulas as fieldBackdrop.ts. */
const GLYPH_PREVIEW = (() => {
  const ramp = " ·:-=+#";
  const lines: string[] = [];
  for (let r = 0; r < 14; r++) {
    let line = "";
    for (let c = 0; c < 40; c++) {
      const x = c * 12, y = r * 18, t = 40;
      const band = Math.sin(x * 0.011 + y * 0.016 + 1.8 * Math.sin(x * 0.0034 - t * 0.23) + 1.3 * Math.sin(y * 0.0052 + t * 0.19) - t * 0.85);
      const ridge = band > 0.15 ? (band - 0.15) / 0.85 : 0;
      line += ramp[Math.min(ramp.length - 1, (ridge * ridge * ramp.length) | 0)];
    }
    lines.push(line);
  }
  return lines.join("\n");
})();

const DOT_PREVIEW = (() => {
  const ramp = " ··••●●";
  const lines: string[] = [];
  for (let r = 0; r < 22; r++) {
    let line = "";
    for (let c = 0; c < 34; c++) {
      const x = c * 14, y = r * 14, t = 40;
      const v = 0.5 + 0.5 * Math.sin(x * 0.0105 + 1.6 * Math.sin(y * 0.0085 + t * 0.33) + t * 0.5) * Math.cos(y * 0.0125 - 1.3 * Math.sin(x * 0.0068 - t * 0.27) - t * 0.38);
      line += ramp[Math.min(ramp.length - 1, (v * v * ramp.length) | 0)];
    }
    lines.push(line);
  }
  return lines.join("\n");
})();

function Mini({ skin }: { skin: string }) {
  return (
    <div className="th-preview" data-skin={skin}>
      <div className="th-pv-side">
        <div className="th-pv-brand" />
        <div className="th-pv-nav on" />
        <div className="th-pv-nav" />
        <div className="th-pv-nav" />
      </div>
      <div className="th-pv-main">
        {skin === "ascii" && <pre className="th-pv-field">{GLYPH_PREVIEW}</pre>}
        {skin === "halftone" && <pre className="th-pv-field dots">{DOT_PREVIEW}</pre>}
        <div className="th-pv-aa">Aa</div>
        <div className="th-pv-line" style={{ width: "78%" }} />
        <div className="th-pv-line faint" style={{ width: "56%" }} />
        <div className="th-pv-card">
          <div className="th-pv-line faint" style={{ width: "44%" }} />
          <div className="th-pv-bar" />
        </div>
      </div>
    </div>
  );
}

export default function Themes() {
  const { settings, update } = useStore();
  const current = isThemeId(settings.theme) ? settings.theme : "system";
  const { switchTo, overlay } = useThemeSwitch((id) => void update({ theme: id }));
  const [focusIdx, setFocusIdx] = useState(() => Math.max(0, THEMES.findIndex((t) => t.id === current)));
  const gridRef = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);

  const pick = (id: string) => {
    if (id !== current) void switchTo(id);
  };

  const move = (to: number) => {
    const i = Math.max(0, Math.min(THEMES.length - 1, to));
    setFocusIdx(i);
    cards.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    const cols = grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length) : 1;
    const i = focusIdx;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = i + 1;
    else if (e.key === "ArrowLeft") next = i - 1;
    else if (e.key === "ArrowDown") next = i + cols;
    else if (e.key === "ArrowUp") next = i - cols;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = THEMES.length - 1;
    if (next === null || next < 0 || next >= THEMES.length) {
      if (next !== null) e.preventDefault();
      return;
    }
    e.preventDefault();
    move(next);
  };

  return (
    <>
      <div className="th-grid" role="radiogroup" aria-label="Theme" ref={gridRef} onKeyDown={onKeyDown}>
        {THEMES.map((t, i) => {
          const selected = t.id === current;
          return (
            <button
              key={t.id}
              ref={(el) => { cards.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={i === focusIdx ? 0 : -1}
              className="th-card"
              onClick={() => { setFocusIdx(i); pick(t.id); }}
              onFocus={() => setFocusIdx(i)}
            >
              <div className="th-preview-wrap" aria-hidden="true">
                {t.id === "system" ? (<><Mini skin="light" /><Mini skin="dark" /></>) : <Mini skin={t.id} />}
              </div>
              <div className="th-meta">
                <div className="th-name-row">
                  <span className="th-name">{t.name}</span>
                  {t.backdrop && <span className="th-tag">Animated</span>}
                  {selected && <Check size={15} strokeWidth={2.2} className="th-check" aria-hidden="true" />}
                </div>
                <div className="th-line">{t.line}</div>
              </div>
            </button>
          );
        })}
      </div>
      {overlay}
    </>
  );
}
