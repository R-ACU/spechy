// The sound button of the play header (next to Best) and its small popover: mute toggle and
// volume slider. The values belong to the open game, which stores them under its own keys
// (`<best key>.muted` and `.volume`). Escape or a click outside closes it; no backdrop.
import { useEffect, useId, useRef, useState } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { Toggle } from "../../components/ui";
import type { SoundControl } from "./catalog";

export default function SoundMenu({ control }: { control: SoundControl }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const id = useId();
  const audible = !control.muted && control.volume > 0;
  const Icon = !audible ? VolumeX : control.volume < 0.5 ? Volume1 : Volume2;
  const label = audible ? `Sound on, volume ${Math.round(control.volume * 100)}` : "Sound off";

  useEffect(() => {
    if (!open) return;
    slider.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture phase, so Escape closes the popover before the play view sees it (and leaves the game).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={wrap} className="gm-sound-wrap">
      <button
        ref={button}
        type="button"
        className={`btn btn-ghost gm-sound ${open ? "on" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className="gm-sound-pop" role="dialog" aria-label="Game sound">
          <div className="gm-sound-row">
            <span className="gm-sound-label">Sound</span>
            <Toggle on={!control.muted} label="Sound" onChange={(on) => control.setMuted(!on)} />
          </div>
          <div className="gm-sound-row">
            <label className="gm-sound-label" htmlFor={`${id}-vol`}>Volume</label>
            <span className="gm-sound-val">{Math.round(control.volume * 100)}</span>
          </div>
          <input
            ref={slider}
            id={`${id}-vol`}
            className="set-range gm-sound-range"
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(control.volume * 100)}
            onChange={(e) => control.setVolume(Number(e.target.value) / 100)}
          />
        </div>
      )}
    </div>
  );
}
