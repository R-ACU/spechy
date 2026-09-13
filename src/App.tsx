import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, events, type DictationState, type Settings, type Toast } from "./lib/ipc";
import { StoreContext, type AppStore } from "./lib/store";
import { defaultSettings, MOCK, safe } from "./lib/fallback";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import Toasts, { type ToastItem } from "./components/Toasts";
import Home from "./views/Home";
import Insights from "./views/Insights";
import Dictionary from "./views/Dictionary";
import Snippets from "./views/Snippets";
import Style from "./views/Style";
import Transforms from "./views/Transforms";
import Scratchpad from "./views/Scratchpad";
import Help from "./views/Help";
import SettingsView from "./views/settings/Settings";
import Onboarding from "./views/Onboarding";

const idleState: DictationState = { phase: "idle", mode: "push-to-talk", liveText: "", level: 0, message: "", startedAtMs: 0 };

// ---------- Theme ----------
type ThemeChoice = Settings["theme"];
/** Last chosen theme, cached so the very first paint already has the right ground color. */
const THEME_KEY = "spechy.theme";

function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function cachedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch {
    /* storage blocked: fall through to system */
  }
  return "system";
}

/** Resolve the choice and stamp it on <html>; color-scheme keeps native scrollbars and inputs in step. */
function applyTheme(choice: ThemeChoice, systemDark: boolean): void {
  const dark = choice === "dark" || (choice === "system" && systemDark);
  const root = document.documentElement;
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.style.colorScheme = dark ? "dark" : "light";
}

if (typeof document !== "undefined") applyTheme(cachedTheme(), prefersDark());

/** Keep <html> in sync with settings.theme, following Windows while the choice is "system". */
function useTheme(choice: ThemeChoice): void {
  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, choice); } catch { /* storage blocked */ }
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const sync = () => applyTheme(choice, !!mq?.matches);
    sync();
    if (!mq || choice !== "system") return;
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [choice]);
}

/** Subscribe to a backend event; no-op when the Tauri bridge is missing (plain browser). */
function useEvent<T>(sub: (cb: (v: T) => void) => Promise<() => void>, cb: (v: T) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    sub((v) => ref.current(v))
      .then((f) => { if (dead) f(); else un = f; })
      .catch(() => {});
    return () => { dead = true; un?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [view, setView] = useState("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [state, setState] = useState<DictationState>(idleState);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);

  useEffect(() => {
    void safe(() => api.getSettings(), defaultSettings).then(setSettings);
    void safe(() => api.getState(), idleState).then(setState);
  }, []);

  const toast = useCallback((tt: Toast) => {
    toastId.current += 1;
    const item: ToastItem = { ...tt, id: toastId.current };
    setToasts((l) => [...l, item]);
  }, []);

  const dismiss = useCallback((id: number) => setToasts((l) => l.filter((x) => x.id !== id)), []);

  const navigate = useCallback((next: string) => {
    if (next === "settings" || next.startsWith("settings:")) {
      setSettingsSection(next.includes(":") ? next.split(":")[1] : undefined);
      setSettingsOpen(true);
      return;
    }
    setSettingsOpen(false);
    setView(next);
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const stored = await api.setSettings(next);
      setSettings(stored);
    } catch (error) {
      if (isTauri()) {
        setSettings(settings);
        toast({ kind: "error", message: String(error) });
      }
    }
  }, [settings, toast]);

  useTheme(settings.theme);

  useEvent<Settings>(events.onSettingsChanged, setSettings);
  useEvent<Toast>(events.onToast, toast);
  useEvent<string>(events.onNavigate, navigate);
  useEvent<DictationState>(events.onState, setState);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ",") { e.preventDefault(); navigate("settings"); }
      else if (e.key === "Escape" && settingsOpen) { setSettingsOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, settingsOpen]);

  useEffect(() => {
    const onResize = () => setMaximized(window.outerWidth >= screen.availWidth - 8 && window.outerHeight >= screen.availHeight - 8);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const store = useMemo<AppStore>(() => ({ settings, update, toast, navigate, view }), [settings, update, toast, navigate, view]);

  const body = (() => {
    switch (view) {
      case "insights": return <Insights />;
      case "dictionary": return <Dictionary />;
      case "snippets": return <Snippets />;
      case "style": return <Style />;
      case "transforms": return <Transforms />;
      case "scratchpad": return <Scratchpad />;
      case "help": return <Help />;
      default: return <Home />;
    }
  })();

  return (
    <StoreContext.Provider value={store}>
      <div className={`app ${MOCK ? "mock" : ""}`}>
        {!settings.onboarded ? (
          <Onboarding />
        ) : (
          <>
            <TitleBar
              phase={state.phase}
              maximized={maximized}
              onToggleSidebar={() => setCollapsed((c) => !c)}
              onAccount={() => navigate("settings:account")}
            />
            <div className="shell">
              <Sidebar collapsed={collapsed} activeId={settingsOpen ? "settings" : view} />
              <main className="content">{body}</main>
            </div>
            {settingsOpen && <SettingsView open={settingsOpen} onClose={() => setSettingsOpen(false)} initialSection={settingsSection} />}
          </>
        )}
        <Toasts items={toasts} onDone={dismiss} />
      </div>
    </StoreContext.Provider>
  );
}
