// The main window starts hidden (tauri.conf.json "visible": false) and is shown from here once the
// saved settings are in and the theme, field included, has drawn: no frame of another theme, no
// empty ground before the field. The backend shows the window on its own after a few seconds in
// case this never runs (lib.rs / tray.rs, reveal fallback), so a broken page cannot hide the app.
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

let shown = false;

export function revealWindow(): void {
  if (shown) return;
  shown = true;
  if (!isTauri()) return;
  const w = getCurrentWindow();
  void w.show().then(() => w.setFocus()).catch(() => {});
}
