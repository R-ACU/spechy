import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, BellOff, Download, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { api } from "../lib/ipc";
import { useStore } from "../lib/store";
import { IconButton } from "./ui";

export default function UpdateNotifications() {
  const { navigate } = useStore();
  const [version, setVersion] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Opened by keyboard (click with detail 0): move focus to the action. Opened by mouse: focus the panel
  // itself, so no focus ring appears on a button the user never tabbed to.
  const byKeyboard = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let pending = false;
    let checkedAt = 0;
    const check = async () => {
      if (pending || Date.now() - checkedAt < 5 * 60 * 1000) return;
      pending = true;
      checkedAt = Date.now();
      try {
        const update = await api.checkForUpdates();
        if (cancelled) return;
        setFailed(false);
        setVersion(update.available ? update.version : null);
        if (update.available) {
          try {
            if (localStorage.getItem("spechy.notifiedUpdate") !== update.version) {
              setRinging(true);
              localStorage.setItem("spechy.notifiedUpdate", update.version);
            }
          } catch { setRinging(true); }
        }
      } catch { if (!cancelled) setFailed(true); }
      finally { pending = false; }
    };
    void check();
    const interval = window.setInterval(() => void check(), 30 * 60 * 1000);
    const focus = () => void check();
    window.addEventListener("focus", focus);
    return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener("focus", focus); };
  }, []);

  useEffect(() => {
    if (!open) return;
    (byKeyboard.current ? action.current : panel.current)?.focus();
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [open]);

  const showUpdates = () => {
    setOpen(false);
    navigate("help");
    window.requestAnimationFrame(() => {
      const section = document.getElementById("spechy-updates");
      section?.scrollIntoView({ block: "start" });
      section?.focus({ preventScroll: true });
    });
  };

  return <div className="update-notifications" ref={root}>
    <button ref={trigger} type="button" className="icon-btn notification-trigger"
      aria-label={version ? "Notifications, 1 update available" : "Notifications"}
      aria-expanded={open} aria-controls="update-notification-panel" aria-haspopup="dialog"
      onClick={(event) => { byKeyboard.current = event.detail === 0; setOpen(value => !value); }}>
      <Bell size={18} className={ringing ? "notification-ring" : undefined} onAnimationEnd={() => setRinging(false)} />
      {version && <span className="notification-count" aria-hidden="true">1</span>}
    </button>
    {open && <div ref={panel} id="update-notification-panel" className="notification-panel" role="dialog" aria-label="Notifications" tabIndex={-1}>
      <div className="notification-heading">
        <span>Notifications</span>
        <IconButton label="Close notifications" className="notification-close" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={15} /></IconButton>
      </div>
      {version ? <button ref={action} type="button" className="notification-update" onClick={showUpdates}>
        <span className="notification-icon"><Download size={16} /></span>
        <span className="notification-text"><strong>Spechy {version} is available</strong><span>View the update and install it</span></span>
        <ArrowRight size={15} className="notification-arrow" />
      </button> : <div className="notification-empty">
        <span className="notification-icon"><BellOff size={16} /></span>
        <span className="notification-text"><strong>{failed ? "Could not check for updates" : "No new updates"}</strong><span>{failed ? "Spechy tries again in a while." : "You will see new versions here."}</span></span>
      </div>}
      {!version && <button ref={action} type="button" className="notification-link" onClick={showUpdates}>Open Updates<ArrowRight size={14} /></button>}
    </div>}
  </div>;
}
