// Typed bridge to the Rust backend. Mirrors src-tauri/src/model.rs exactly (camelCase).
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Phase = "idle" | "recording" | "transcribing" | "polishing" | "error";
export type DictationMode = "push-to-talk" | "hands-free" | "command";

export interface DictationState {
  phase: Phase;
  mode: DictationMode;
  liveText: string;
  level: number;
  message: string;
  startedAtMs: number;
}

export interface Toast { kind: "info" | "error" | "success"; message: string }

export interface Hotkeys { pushToTalk: string; handsFree: string; command: string; pasteLast: string }

export type SttProvider = "auto" | "groq" | "openrouter" | "custom";
export type PolishProvider = "openrouter" | "groq" | "custom";
/** Which catalogue the model picker asks for. */
export type ModelSource = "groq" | "openrouter" | "custom_stt" | "custom_polish";

export interface Providers {
  groqApiKey: string;
  openrouterApiKey: string;
  sttProvider: SttProvider;
  groqModel: string;
  openrouterSttModel: string;
  polishModel: string;
  polishEnabled: boolean;
  polishProvider: PolishProvider;
  groqPolishModel: string;
  /** Own or local OpenAI-compatible server, base url up to /v1. */
  customSttBaseUrl: string;
  /** "openai" for any OpenAI-compatible server, "whisper_cpp" for whisper.cpp's own /inference API. */
  customSttApi: "openai" | "whisper_cpp";
  customSttApiKey: string;
  customSttModel: string;
  customPolishBaseUrl: string;
  customPolishApiKey: string;
  customPolishModel: string;
}

export interface ModelInfo { id: string; name: string; audio: boolean; free: boolean }

/** ---------- Local model library ---------- */

/** How well a model fits the machine it was scored on. */
export type LocalFit = "great" | "good" | "tight" | "too_big";

export interface GpuInfo { name: string; vramMb: number; vendor: string }

/** Best-effort hardware profile; missing values are 0 or empty, never "no PC". */
export interface HardwareProfile {
  totalRamMb: number;
  availableRamMb: number;
  cpuCores: number;
  cpuName: string;
  gpuName: string;
  /** Dedicated memory usable for inference; 0 for integrated graphics or unknown. */
  vramMb: number;
  gpuVendor: string;
  gpus: GpuInfo[];
  modelsDir: string;
}

export interface LocalModel {
  id: string;
  name: string;
  backend: string;
  family: string;
  params: string;
  sizeBytes: number;
  sha256: string;
  ramMb: number;
  vramMb: number;
  quality: number;
  speed: number;
  german: number;
  languages: string;
  englishOnly: boolean;
  license: string;
  note: string;
  file: string;
  url: string;
}

export interface LocalModelFit {
  model: LocalModel;
  fit: LocalFit;
  score: number;
  recommended: boolean;
  installed: boolean;
  installedPath: string | null;
  reason: string;
}

/** State of the whisper.cpp server Spechy can unpack and run itself. */
export interface LocalServerStatus {
  installed: boolean;
  installedFlavors: string[];
  preferredFlavor: string;
  running: boolean;
  flavor: string | null;
  port: number;
  modelId: string | null;
  modelPath: string | null;
  build: string;
  logTail: string[];
}

export type Tone = "neutral" | "formal" | "casual";
export interface AppStyleRule { id: string; appMatch: string; tone: Tone; note: string }
export interface StyleSettings { defaultTone: Tone; appRules: AppStyleRule[]; customRules: string; keepFillers: boolean }

export interface Settings {
  userName: string;
  appLanguage: "en" | "de";
  theme: "system" | "light" | "dark";
  dictationLanguages: string[];
  /** Language the user mainly speaks: "de", "en", "auto", or "" to follow the first dictation language. */
  primaryLanguage: string;
  microphone: string;
  hotkeys: Hotkeys;
  launchAtLogin: boolean;
  showPillAlways: boolean;
  /** Pill size in percent of the base size (50..150). */
  pillScale: number;
  dictationReminder: boolean;
  sounds: boolean;
  liveTranscript: boolean;
  vibeCoding: boolean;
  vibeCodingApps: string[];
  providers: Providers;
  style: StyleSettings;
  scratchpadPinned: boolean;
  onboarded: boolean;
}

export interface HistoryEntry {
  id: string; createdAt: number; text: string; rawText: string; appName: string; appTitle: string;
  durationMs: number; latencyMs: number; wordCount: number; flagged: boolean; mode: DictationMode;
}
export interface HistoryPage { entries: HistoryEntry[]; total: number }
export interface DictionaryEntry { id: string; word: string; misspelling: string; autoLearned: boolean; starred: boolean; createdAt: number; uses: number }
export interface Snippet { id: string; trigger: string; text: string; createdAt: number; uses: number }
export interface Transform { id: string; name: string; prompt: string; builtin: boolean; createdAt: number }
export interface DayStat { date: string; words: number; count: number }
export type AppCategory = "ai" | "coding" | "messages" | "documents" | "email" | "other";
export interface AppStat { appName: string; category: AppCategory; words: number; count: number }
export interface WordStat { word: string; count: number }
export interface Stats {
  totalWords: number; totalDictations: number; wpm: number; streakDays: number; longestStreak: number;
  fixes: number; dictionaryFixes: number; wordsThisMonth: number; wordsPrevMonth: number;
  perDay: DayStat[]; perApp: AppStat[]; topWords: WordStat[]; appsUsed: number;
}
export interface MicDevice { name: string; isDefault: boolean }

// ---------- Commands ----------
export const api = {
  // settings
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<Settings>("set_settings", { settings }),
  listMicrophones: () => invoke<MicDevice[]>("list_microphones"),
  /** Live level meter for a microphone. Records nothing and costs nothing. */
  startMicTest: (device: string) => invoke<void>("start_mic_test", { device }),
  stopMicTest: () => invoke<void>("stop_mic_test"),
  testProvider: (provider: ModelSource, apiKey: string) => invoke<string>("test_provider", { provider, apiKey }),
  listModels: (provider: ModelSource, refresh = false) => invoke<ModelInfo[]>("list_models", { provider, refresh }),
  // local model library
  localHardware: () => invoke<HardwareProfile>("local_hardware"),
  listLocalModels: () => invoke<LocalModelFit[]>("list_local_models"),
  downloadLocalModel: (id: string, onProgress: (progress: { downloaded: number; total: number | null }) => void) => {
    const channel = new Channel<{ downloaded: number; total: number | null }>();
    channel.onmessage = onProgress;
    return invoke<LocalModelFit>("download_local_model", { id, onProgress: channel });
  },
  removeLocalModel: (id: string) => invoke<LocalModelFit[]>("remove_local_model", { id }),
  openModelsDir: () => invoke<void>("open_models_dir"),
  // managed local whisper.cpp server
  localServerStatus: () => invoke<LocalServerStatus>("local_server_status"),
  installLocalServer: (flavor: string, onProgress: (progress: { downloaded: number; total: number | null }) => void) => {
    const channel = new Channel<{ downloaded: number; total: number | null }>();
    channel.onmessage = onProgress;
    return invoke<LocalServerStatus>("install_local_server", { flavor, onProgress: channel });
  },
  startLocalServer: (modelId: string, port: number) => invoke<LocalServerStatus>("start_local_server", { modelId, port }),
  stopLocalServer: () => invoke<LocalServerStatus>("stop_local_server"),
  getAppVersion: () => invoke<string>("get_app_version"),
  // dictation control (UI buttons; hotkeys work without these)
  getState: () => invoke<DictationState>("get_state"),
  startDictation: (mode: DictationMode) => invoke<void>("start_dictation", { mode }),
  stopDictation: () => invoke<void>("stop_dictation"),
  cancelDictation: () => invoke<void>("cancel_dictation"),
  // history
  listHistory: (limit: number, offset: number, query: string) => invoke<HistoryPage>("list_history", { limit, offset, query }),
  deleteHistory: (id: string) => invoke<void>("delete_history", { id }),
  setHistoryFlag: (id: string, flagged: boolean) => invoke<void>("set_history_flag", { id, flagged }),
  updateHistoryText: (id: string, text: string) => invoke<void>("update_history_text", { id, text }),
  repolishHistory: (id: string) => invoke<HistoryEntry>("repolish_history", { id }),
  clearHistory: () => invoke<void>("clear_history"),
  // dictionary
  listDictionary: () => invoke<DictionaryEntry[]>("list_dictionary"),
  addDictionary: (word: string, misspelling: string) => invoke<DictionaryEntry>("add_dictionary", { word, misspelling }),
  updateDictionary: (entry: DictionaryEntry) => invoke<DictionaryEntry>("update_dictionary", { entry }),
  deleteDictionary: (id: string) => invoke<void>("delete_dictionary", { id }),
  // snippets
  listSnippets: () => invoke<Snippet[]>("list_snippets"),
  addSnippet: (trigger: string, text: string) => invoke<Snippet>("add_snippet", { trigger, text }),
  updateSnippet: (snippet: Snippet) => invoke<Snippet>("update_snippet", { snippet }),
  deleteSnippet: (id: string) => invoke<void>("delete_snippet", { id }),
  // transforms
  listTransforms: () => invoke<Transform[]>("list_transforms"),
  addTransform: (name: string, prompt: string) => invoke<Transform>("add_transform", { name, prompt }),
  updateTransform: (transform: Transform) => invoke<Transform>("update_transform", { transform }),
  deleteTransform: (id: string) => invoke<void>("delete_transform", { id }),
  applyTransform: (transformId: string, text: string) => invoke<string>("apply_transform", { transformId, text }),
  // scratchpad
  getScratchpad: () => invoke<string>("get_scratchpad"),
  setScratchpad: (text: string) => invoke<void>("set_scratchpad", { text }),
  // stats / data
  getStats: () => invoke<Stats>("get_stats"),
  exportData: () => invoke<string>("export_data"), // returns path of the written JSON file
  getDataDir: () => invoke<string>("get_data_dir"),
  openDataDir: () => invoke<void>("open_data_dir"),
  copyToClipboard: (text: string) => invoke<void>("copy_to_clipboard", { text }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  // window
  checkForUpdates: () => invoke<{ version: string; available: boolean; downloadUrl: string }>("check_for_updates"),
  downloadUpdate: (onProgress: (progress: { downloaded: number; total: number | null }) => void) => {
    const channel = new Channel<{ downloaded: number; total: number | null }>();
    channel.onmessage = onProgress;
    return invoke<string>("download_update", { onProgress: channel });
  },
  installUpdate: () => invoke<void>("install_update"),
  updateDownloadStatus: () => invoke<{ downloading: boolean; version: string | null; progress: { downloaded: number; total: number | null } | null; error: string | null }>("update_download_status"),
  suspendHotkeys: (suspended: boolean) => invoke<void>("suspend_hotkeys", { suspended }),
  minimizeWindow: () => invoke<void>("window_minimize"),
  toggleMaximizeWindow: () => invoke<void>("window_toggle_maximize"),
  closeWindow: () => invoke<void>("window_close"), // destroys the webview, app stays in tray
};

// ---------- Events ----------
export const events = {
  onState: (cb: (s: DictationState) => void): Promise<UnlistenFn> => listen<DictationState>("spechy://state", (e) => cb(e.payload)),
  onMicLevel: (cb: (level: number) => void): Promise<UnlistenFn> => listen<number>("spechy://mic-level", (e) => cb(e.payload)),
  onHistoryAdded: (cb: (h: HistoryEntry) => void): Promise<UnlistenFn> => listen<HistoryEntry>("spechy://history-added", (e) => cb(e.payload)),
  onSettingsChanged: (cb: (s: Settings) => void): Promise<UnlistenFn> => listen<Settings>("spechy://settings-changed", (e) => cb(e.payload)),
  onToast: (cb: (t: Toast) => void): Promise<UnlistenFn> => listen<Toast>("spechy://toast", (e) => cb(e.payload)),
  onNavigate: (cb: (view: string) => void): Promise<UnlistenFn> => listen<string>("spechy://navigate", (e) => cb(e.payload)),
  onScratchpad: (cb: (text: string) => void): Promise<UnlistenFn> => listen<string>("spechy://scratchpad", (e) => cb(e.payload)),
};
