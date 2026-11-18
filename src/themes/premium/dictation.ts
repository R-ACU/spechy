// How hard Event Horizon burns: 1 while the user dictates (phase "recording"), a short afterglow while
// the text is transcribed and polished, 0 otherwise. Follows the backend's `spechy://state` event,
// subscribed only while a horizon field is running. TESTCODE (2026-11-18): in Vite dev a page can fake
// it with window.dispatchEvent(new CustomEvent("spechy-dev-dictation", { detail: 1 })).
import { isTauri } from "@tauri-apps/api/core";
import { api, events, type Phase } from "../../lib/ipc";

let target = 0;
let users = 0;
let unlisten: (() => void) | null = null;
let alive = 0;

const level = (p: Phase) => (p === "recording" ? 1 : p === "transcribing" || p === "polishing" ? 0.35 : 0);
const onDev = (e: Event) => { target = Math.max(0, Math.min(1, Number((e as CustomEvent).detail) || 0)); };

/** Current target energy, 0..1. */
export function dictationEnergy(): number {
  return target;
}

/** Start following the dictation state; returns the release function. */
export function followDictation(): () => void {
  users += 1;
  if (users === 1) {
    const my = ++alive;
    if (isTauri()) {
      api.getState().then((s) => { if (alive === my) target = level(s.phase); }).catch(() => {});
      events.onState((s) => { target = level(s.phase); })
        .then((f) => { if (alive === my && users > 0) unlisten = f; else f(); })
        .catch(() => {});
    }
    if (import.meta.env.DEV) window.addEventListener("spechy-dev-dictation", onDev); // TESTCODE (2026-11-18)
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    users -= 1;
    if (users > 0) return;
    alive += 1;
    unlisten?.();
    unlisten = null;
    target = 0;
    if (import.meta.env.DEV) window.removeEventListener("spechy-dev-dictation", onDev);
  };
}
