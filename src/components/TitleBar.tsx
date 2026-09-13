import { Bell, CircleUser, Copy, Minus, PanelLeft, Square, X } from "lucide-react";
import { api } from "../lib/ipc";
import type { Phase } from "../lib/ipc";
import { IconButton } from "./ui";

const call = (fn: () => Promise<unknown>) => { void fn().catch(() => {}); };

export default function TitleBar({ phase, maximized, onToggleSidebar, onAccount }: {
  phase: Phase;
  maximized: boolean;
  onToggleSidebar: () => void;
  onAccount: () => void;
}) {
  const dot = phase === "recording" ? "rec" : phase === "transcribing" || phase === "polishing" ? "busy" : phase === "error" ? "err" : "";
  return (
    <div
      className="titlebar"
      data-tauri-drag-region
      onDoubleClick={(e) => { if (e.target === e.currentTarget) call(api.toggleMaximizeWindow); }}
    >
      <div className="titlebar-left">
        <IconButton label="Toggle sidebar" onClick={onToggleSidebar}><PanelLeft size={18} /></IconButton>
        <IconButton label="Account" onClick={onAccount}><CircleUser size={18} /></IconButton>
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-right">
        {dot && <span className={`phase-dot ${dot}`} title={phase} aria-label={`Dictation ${phase}`} />}
        <IconButton label="Notifications"><Bell size={18} /></IconButton>
        <IconButton label="Minimize" className="win-btn" onClick={() => call(api.minimizeWindow)}><Minus size={18} /></IconButton>
        <IconButton label={maximized ? "Restore" : "Maximize"} className="win-btn" onClick={() => call(api.toggleMaximizeWindow)}>
          {maximized ? <Copy size={15} /> : <Square size={15} />}
        </IconButton>
        <IconButton label="Close" className="win-btn win-close" onClick={() => call(api.closeWindow)}><X size={18} /></IconButton>
      </div>
    </div>
  );
}
