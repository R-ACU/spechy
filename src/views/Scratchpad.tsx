import { useEffect, useRef, useState } from "react";
import { api, events } from "../lib/ipc";
import { safeCall } from "../lib/mock";
import { useStore } from "../lib/store";
import { Button, Dialog, Toggle } from "../components/ui";

export default function Scratchpad() {
  const { settings, update, toast } = useStore();
  const [text, setText] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const timer = useRef<number | null>(null);
  const local = useRef(false);

  useEffect(() => {
    void safeCall(() => api.getScratchpad(), "scratchpad", "").then((t) => { if (!local.current) setText(t); });
    let off: (() => void) | undefined;
    events.onScratchpad((t) => { local.current = false; setText(t); })
      .then((fn) => { off = fn; })
      .catch(() => {});
    return () => {
      off?.();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const push = (next: string) => {
    setText(next);
    local.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void api.setScratchpad(next).catch(() => {}); }, 500);
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;

  const copyAll = async () => {
    try { await api.copyToClipboard(text); toast({ kind: "success", message: "Scratchpad copied" }); }
    catch { toast({ kind: "error", message: "Could not copy" }); }
  };

  return (
    <div className="page sp-page">
      <div className="page-head sp-head">
        <div className="sp-head-left">
          <h1 className="page-title">Scratchpad</h1>
          <div className="sp-pin">
            <Toggle on={settings.scratchpadPinned} onChange={(v) => void update({ scratchpadPinned: v })} />
            <div className="sp-pin-text">
              <div className="sp-pin-label">Pin dictations here</div>
              <div className="muted sp-pin-sub">While pinned, everything you dictate lands here instead of the focused app</div>
            </div>
          </div>
        </div>
        <div className="sp-actions">
          <Button variant="secondary" size="sm" onClick={() => void copyAll()}>Copy all</Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>Clear</Button>
        </div>
      </div>

      <textarea
        className="sp-area"
        value={text}
        onChange={(e) => push(e.target.value)}
        placeholder="Everything you dictate while pinned lands here. You can also just type."
        spellCheck={false}
      />

      <div className="sp-foot muted">
        {words.toLocaleString("en-US")} words &middot; {chars.toLocaleString("en-US")} characters
      </div>

      {confirmClear && (
        <Dialog title="Clear scratchpad" onClose={() => setConfirmClear(false)} width={420}>
          <p className="muted">This removes everything in the scratchpad. It cannot be undone.</p>
          <div className="dialog-actions">
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { push(""); setConfirmClear(false); }}>Clear</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
