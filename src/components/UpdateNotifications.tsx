import { useEffect, useRef, useState } from "react";
import { Bell, Download, X } from "lucide-react";
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
    action.current?.focus();
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
      onClick={() => setOpen(value => !value)}>
      <Bell size={18} className={ringing ? "notification-ring" : undefined} onAnimationEnd={() => setRinging(false)} />
      {version && <span className="notification-count" aria-hidden="true">1</span>}
    </button>
    {open && <div id="update-notification-panel" className="notification-panel" role="dialog" aria-label="Notifications">
      <div className="notification-heading"><strong>Notifications</strong><IconButton label="Close notifications" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} /></IconButton></div>
      {version ? <button ref={action} className="notification-update" onClick={showUpdates}>
        <Download size={19} />
        <span><strong>Spechy {version} is available</strong><span>View update and install</span></span>
      </button> : <div className="notification-empty">
        <p>{failed ? "Could not check for updates." : "No new updates."}</p>
        <button ref={action} className="btn btn-secondary" onClick={showUpdates}>Open Updates</button>
      </div>}
    </div>}
  </div>;
}
