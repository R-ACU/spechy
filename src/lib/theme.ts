// Theme resolution: settings.theme -> <html data-theme="light|dark" data-skin="<id>"> + color-scheme.
// data-theme drives the base tokens in styles.css, data-skin the overrides in themes/themes.css.
// The last choice is cached in localStorage so the very first paint already has the right ground colour,
// and the native window background follows, so no light edge shows while resizing a dark window.
import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isThemeId, themeById } from "../themes/registry";
import "../themes/themes.css";

export type ThemeChoice = string;
const THEME_KEY = "spechy.theme";

function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function cachedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isThemeId(v)) return v;
  } catch {
    /* storage blocked: fall through to system */
  }
  return "system";
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
  if (!isTauri()) return;
  const hex = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || hex === nativeBg) return;
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
  syncNativeBackground();
}

if (typeof document !== "undefined") applyTheme(cachedTheme(), prefersDark());

/** Keep <html> in sync with settings.theme, following the OS while the theme's base is "system". */
export function useTheme(choice: ThemeChoice): void {
  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, isThemeId(choice) ? choice : "system"); } catch { /* storage blocked */ }
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const sync = () => applyTheme(choice, !!mq?.matches);
    sync();
    if (!mq || (themeById(choice)?.base ?? "system") !== "system") return;
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [choice]);
}
