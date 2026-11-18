// Temporary theme override for "try it on" (shop preview). Never saved: useTheme() and ThemeLayer
// show the override while it is set, and fall back to settings.theme as soon as it is cleared.
import { useSyncExternalStore } from "react";

let previewId: string | null = null;
const subs = new Set<() => void>();

export function setThemePreview(id: string | null): void {
  if (id === previewId) return;
  previewId = id;
  subs.forEach((f) => f());
}

export function themePreview(): string | null {
  return previewId;
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => { subs.delete(f); };
}

// Closing the window ends a running preview first (the field loop stops before the WebView goes).
if (typeof window !== "undefined") {
  const end = () => setThemePreview(null);
  window.addEventListener("pagehide", end);
  window.addEventListener("beforeunload", end);
}

/** The theme being previewed, or null. */
export function usePreviewTheme(): string | null {
  return useSyncExternalStore(subscribe, themePreview, themePreview);
}
