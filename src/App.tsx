import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, events, type DictationState, type InsertText, type Settings, type Toast } from "./lib/ipc";
import { deliverDictation, trackFocusedField } from "./lib/insertText";
import { StoreContext, useStore, type AppStore, type SettingsPatch } from "./lib/store";
import { loadEconomy, useEconomy } from "./lib/economy";
import { themeById } from "./themes/registry";
import { defaultSettings, MOCK, safe } from "./lib/fallback";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import Toasts, { type ToastItem } from "./components/Toasts";
import Home from "./views/Home";
import Insights from "./views/Insights";
import Dictionary from "./views/Dictionary";
import Snippets from "./views/Snippets";
import Style from "./views/Style";
import Help from "./views/Help";
import SettingsView from "./views/settings/Settings";
import Onboarding from "./views/Onboarding";
import { cachedTheme, useTheme } from "./lib/theme";
import { revealWindow } from "./lib/reveal";
import ThemeLayer from "./themes/ThemeLayer";

// Games are loaded on demand so the main bundle stays small.
const Games = lazy(() => import("./views/games/Games"));

const idleState: DictationState = { phase: "idle", mode: "push-to-talk", liveText: "", level: 0, message: "", startedAtMs: 0 };

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

/** A premium theme saved in settings but not owned (say after a developer reset) falls back to
 *  Dark. Costs nothing for plain themes: the economy is only read while a premium one is saved. */
function PremiumThemeGuard() {
  const { settings, update } = useStore();
  const itemId = themeById(settings.theme)?.itemId;
  const { state } = useEconomy();
  useEffect(() => { if (itemId && !state) void loadEconomy().catch(() => {}); }, [itemId, state]);
  useEffect(() => {
    if (itemId && state && !state.inventory.some((i) => i.itemId === itemId)) void update({ theme: "dark" });
  }, [itemId, state, update]);
  return null;
}

// Until the saved settings arrive, show the theme of the last run, never the built-in default.
const bootSettings: Settings = { ...defaultSettings, theme: cachedTheme() };

export default function App() {
  const [settings, setSettings] = useState<Settings>(bootSettings);
  const settingsRef = useRef(bootSettings);
  const storedSettings = useRef(bootSettings);
  const saveQueue = useRef(Promise.resolve());
  const pendingSaves = useRef(0);
  // Nothing but the themed ground renders before the saved settings are in, so neither the shell
  // nor the onboarding flashes up for a user who is in the other one.
  const [loaded, setLoaded] = useState(false);
  const receiveSettings = useCallback((value: Settings) => {
    if (pendingSaves.current > 0) return;
    storedSettings.current = value;
    settingsRef.current = value;
    setSettings(value);
    setLoaded(true);
  }, []);
  const [view, setView] = useState("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [state, setState] = useState<DictationState>(idleState);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);

  useEffect(() => {
    void safe(() => api.getSettings(), defaultSettings).then(receiveSettings);
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

  const update = useCallback((patch: SettingsPatch) => {
    const previous = settingsRef.current;
    const next = { ...previous, ...patch, style: { ...previous.style, ...patch.style } };
    settingsRef.current = next;
    setSettings(next);
    pendingSaves.current += 1;
    const save = saveQueue.current.then(async () => {
      try {
        storedSettings.current = await api.setSettings(next);
      } catch (error) {
        if (isTauri()) toast({ kind: "error", message: String(error) });
        else storedSettings.current = next;
      } finally {
        pendingSaves.current -= 1;
        if (pendingSaves.current === 0) {
          settingsRef.current = storedSettings.current;
          setSettings(storedSettings.current);
        }
      }
    });
    saveQueue.current = save;
    return save;
  }, [toast]);

  useTheme(settings.theme);

  // Show the hidden window once the real theme is on screen: right after the settings for plain
  // themes, after the field's first frame for animated ones (ThemeLayer onPainted). The timer is a
  // safety net in case the field never reports.
  const waitsForField = !!themeById(settings.theme)?.backdrop;
  const [fieldPainted, setFieldPainted] = useState(false);
  const onFieldPainted = useCallback(() => setFieldPainted(true), []);
  useEffect(() => {
    if (!loaded) return;
    if (!waitsForField || fieldPainted) { revealWindow(); return; }
    const t = window.setTimeout(revealWindow, 600);
    return () => window.clearTimeout(t);
  }, [loaded, waitsForField, fieldPainted]);

  // Monday payout on app start (no request unless the player joined the leaderboard). The Games
  // page flies the coins in later; outside Games the toast tells right away.
  const payoutChecked = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (!settings.onboarded || payoutChecked.current) return;
    payoutChecked.current = true;
    void import("./lib/payout").then((m) => m.checkWeeklyPayout(toast, viewRef.current !== "games")).catch(() => {});
  }, [settings.onboarded, toast]);

  useEvent<Settings>(events.onSettingsChanged, receiveSettings);
  useEvent<Toast>(events.onToast, toast);
  useEvent<string>(events.onNavigate, navigate);
  useEvent<DictationState>(events.onState, setState);
  // Dictations aimed at this window arrive as text, not as a Ctrl+V (see lib/insertText.ts).
  useEffect(() => trackFocusedField(), []);
  useEvent<InsertText>(events.onInsertText, (p) => { void deliverDictation(p.text, toast); });

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
      case "games": return <Suspense fallback={null}><Games /></Suspense>;
      case "help": return <Help />;
      default: return <Home />;
    }
  })();

  return (
    <StoreContext.Provider value={store}>
      <PremiumThemeGuard />
      <ThemeLayer theme={settings.theme} shell={loaded && settings.onboarded} onPainted={onFieldPainted} />
      <div className={`app ${MOCK ? "mock" : ""}`}>
        {!loaded ? null : !settings.onboarded ? (
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
