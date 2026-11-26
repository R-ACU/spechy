// Theme resolution: settings.theme -> <html data-theme="light|dark" data-skin="<id>"> + color-scheme.
// data-theme drives the base tokens in styles.css, data-skin the overrides in themes/themes.css.
// The last choice is cached in localStorage so the very first paint already has the right ground colour,
// and the native window background follows, so no light edge shows while resizing a dark window.
import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isThemeId, loadBackdrop, themeById } from "../themes/registry";
import { usePreviewTheme } from "../themes/preview";
import "../themes/themes.css";

export type ThemeChoice = string;
/** Theme of a fresh install, also what an empty cache falls back to (keep in step with model.rs). */
export const DEFAULT_THEME = "ascii";
const THEME_KEY = "spechy.theme";
/** Resolved --bg of the last theme, read by the inline script in index.html before any CSS loads. */
const BG_KEY = "spechy.bg";

function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The theme of the last run, so the first frame already shows it instead of a default. */
export function cachedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isThemeId(v)) return v;
  } catch {
    /* storage blocked: fall through to the default */
  }
  return DEFAULT_THEME;
}

/** Base palette ("light" | "dark") a choice resolves to right now. Unknown ids behave like "system". */
export function resolveBase(choice: ThemeChoice, systemDark: boolean): "light" | "dark" {
  const base = themeById(choice)?.base ?? "system";
  if (base === "system") return systemDark ? "dark" : "light";
  return base;
}

let nativeBg = "";

/** Paint the native window ground in the resolved --bg so window edges match while resizing. */
function syncNativeBackground(): void {
  const hex = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return;
  try { localStorage.setItem(BG_KEY, hex); } catch { /* storage blocked */ }
  if (!isTauri() || hex === nativeBg) return;
  nativeBg = hex;
  const n = parseInt(m[1], 16);
  getCurrentWindow().setBackgroundColor([(n >> 16) & 255, (n >> 8) & 255, n & 255]).catch(() => {
    nativeBg = "";
  });
}

/** Resolve the choice and stamp it on <html>; color-scheme keeps native scrollbars and inputs in step. */
function applyTheme(choice: ThemeChoice, systemDark: boolean): void {
  const skin = isThemeId(choice) ? choice : "system";
  const base = resolveBase(skin, systemDark);
  const root = document.documentElement;
  root.setAttribute("data-theme", base);
  root.setAttribute("data-skin", skin);
  root.style.colorScheme = base;
  // index.html paints the cached ground inline until the stylesheet takes over.
  root.style.removeProperty("background");
  syncNativeBackground();
}

if (typeof document !== "undefined") {
  const first = cachedTheme();
  applyTheme(first, prefersDark());
  // Fetch the field chunk while React mounts, so the animated theme is there in the first frame.
  void loadBackdrop(first).catch(() => {});
}

/** Keep <html> in sync with settings.theme, following the OS while the theme's base is "system". */
export function useTheme(choice: ThemeChoice): void {
  // A shop preview (themes/preview.ts) is shown but never cached or saved.
  const preview = usePreviewTheme();
  const shown = preview ?? choice;
  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, isThemeId(choice) ? choice : "system"); } catch { /* storage blocked */ }
  }, [choice]);
  useEffect(() => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const sync = () => applyTheme(shown, !!mq?.matches);
    sync();
    if (!mq || (themeById(shown)?.base ?? "system") !== "system") return;
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [shown]);
}
