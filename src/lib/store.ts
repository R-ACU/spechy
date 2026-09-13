// Global settings + toast state shared by all views.
import { createContext, useContext } from "react";
import type { Settings, Toast } from "./ipc";

export interface AppStore {
  settings: Settings;
  /** Persist a partial change; backend echoes the full settings back. */
  update: (patch: Partial<Settings>) => Promise<void>;
  toast: (t: Toast) => void;
  /** Navigate to a view id: "home" | "insights" | "dictionary" | "snippets" | "style" | "transforms" | "scratchpad" | "settings" | "help" */
  navigate: (view: string) => void;
  view: string;
}

export const StoreContext = createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error("StoreContext missing");
  return s;
}

/** Tiny i18n: UI strings in English (default) or German, switched by settings.appLanguage. Add keys as needed. */
const de: Record<string, string> = {
  "Welcome back": "Willkommen zurück",
  Home: "Start", Insights: "Einblicke", Dictionary: "Wörterbuch", Snippets: "Bausteine", Style: "Stil", Transforms: "Umwandlungen", Scratchpad: "Notizblock", Settings: "Einstellungen", Help: "Hilfe",
  "Add new": "Neu", All: "Alle", Personal: "Persönlich", Cancel: "Abbrechen", Save: "Speichern", Delete: "Löschen", Edit: "Bearbeiten", Search: "Suchen",
  "total words": "Wörter gesamt", wpm: "WpM", "day streak": "Tage in Folge",
};

export function t(key: string, lang: string): string {
  return lang === "de" ? de[key] ?? key : key;
}
