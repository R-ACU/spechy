// Typed bridge to the Rust backend. Mirrors src-tauri/src/model.rs exactly (camelCase).
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Phase = "idle" | "recording" | "transcribing" | "polishing" | "error";
export type DictationMode = "push-to-talk" | "hands-free" | "command" | "prompt";

export interface DictationState {
  phase: Phase;
  mode: DictationMode;
  liveText: string;
  level: number;
  message: string;
  startedAtMs: number;
}

export interface Toast { kind: "info" | "error" | "success"; message: string }

export interface Hotkeys { pushToTalk: string; handsFree: string; command: string; prompt: string; pasteLast: string }

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
  /** Theme id, resolved in src/lib/theme.ts ("system" | "light" | "dark" | extra themes). Stored as a plain string by the backend. */
  theme: string;
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
  /** Mute other apps (music, videos) while the microphone records. */
  muteWhileDictating: boolean;
  liveTranscript: boolean;
  vibeCoding: boolean;
  vibeCodingApps: string[];
  providers: Providers;
  style: StyleSettings;
  scratchpadPinned: boolean;
  onboarded: boolean;
  /** Leaderboard server: https, or http on this machine. Empty = debug default in dev builds, none in release. */
  leaderboardUrl: string;
}

export interface HistoryEntry {
  id: string; createdAt: number; text: string; rawText: string; appName: string; appTitle: string;
  durationMs: number; latencyMs: number; wordCount: number; flagged: boolean; mode: DictationMode;
}
export interface HistoryPage { entries: HistoryEntry[]; total: number }
/** A dictation whose transcription failed; its recording is kept until retried or discarded. */
export interface FailedDictation {
  id: string; createdAt: number; mode: DictationMode; appName: string; appTitle: string; durationMs: number; error: string;
}
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

// ---------- Games economy (mirrors src-tauri/src/economy.rs) ----------
export type GameId = "tower" | "snake" | "comet";
export type EquipSlot = "title" | "theme" | "pill" | "tower-skin" | "snake-skin" | "comet-skin";
export type ItemKindId = EquipSlot | "profile";
export type BoxId = "basic" | "premium" | "mythic";
export type TitleRarity = "common" | "rare" | "epic" | "legendary";
export interface RankState {
  /** 0 Bronze, 1 Silver, 2 Gold, 3 Platinum, 4 Diamond, 5 Master, 6 Champion. */
  tier: number; tierId: string; tierName: string;
  /** 0..2 for I..III; null at Champion. */
  division: number | null;
  /** RP inside the current division (0..99); keeps growing at Champion. */
  rp: number; totalRp: number;
}
export interface BoxState { id: BoxId; price: number; keys: number; opened: number; sinceLegendary: number; pity: number | null }
export interface OwnedItem { itemId: string; kind: ItemKindId | string; acquiredAt: number; source: "shop" | "box" | "rank" | "dev" | string }
export interface DailyEconomy { day: string; gameCoins: number; gameCoinCap: number; bestBonuses: number; bestBonusCap: number }
/** Effective (boosted) earning values from the backend (`EARN_BOOST_PERCENT` in economy.rs); the UI never hard-codes them. */
export interface EarnRates {
  boostPercent: number;
  /** First dictation of a day at streak 1. */
  dayCoins: number;
  /** Streak ceiling of the day bonus. */
  dayCoinsMax: number;
  /** What the next dictation day pays. */
  nextDayCoins: number;
  /** Per full 1,000 words. */
  wordsCoins: number;
  /** Largest round payout before the daily cap. */
  roundCoinMax: number;
  bestBonus: number;
  divisionCoins: number;
  /** Tier promotion coins by tier index, 0 Bronze .. 6 Champion. */
  tierCoins: number[];
  /** Monday payout for rank 1, 2, 3. */
  weeklyPayout: number[];
}
export interface EconomyState {
  balance: number;
  /** Developer "unlimited coins" (debug builds only): purchases keep the balance. */
  unlimited: boolean;
  /** True in debug builds, where the developer commands work. */
  devTools: boolean;
  rank: RankState;
  boxes: BoxState[];
  inventory: OwnedItem[];
  equipped: Partial<Record<EquipSlot, string>>;
  today: DailyEconomy;
  streak: number;
  wordsTowardNext: number;
  /** Coins earned this ISO week, Monday 00:00 UTC until now (not refunds), the leaderboard's week. */
  weekEarned: number;
  earnRates: EarnRates;
}
export interface Promotion {
  kind: "division" | "tier";
  tier: number; tierName: string; division: number | null;
  /** Already added to the balance. */
  coins: number; boxKey: BoxId | null; title: string | null;
}
export interface GameAward {
  game: GameId; score: number; newBest: boolean; quit: boolean;
  /** min(10, f(score)) before the daily cap. */
  baseCoins: number;
  coins: number; bestBonus: number; total: number; rp: number;
  dailyCapHit: boolean; bestCapHit: boolean;
  rankBefore: RankState;
  promotions: Promotion[];
  state: EconomyState;
}
export interface BoxOpening {
  boxId: BoxId; rarity: TitleRarity; title: string; isNew: boolean;
  refund: number; usedKey: boolean; pityHit: boolean; state: EconomyState;
}
export interface RankUpResult { promotions: Promotion[]; state: EconomyState }
/** Monday payout for a top three finish last week; already in `state.balance`. */
export interface WeeklyPayout { week: string; rank: number; coins: number; state: EconomyState }

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
  listFailedDictations: () => invoke<FailedDictation[]>("list_failed_dictations"),
  retryFailedDictation: (id: string) => invoke<void>("retry_failed_dictation", { id }), // result arrives as events
  discardFailedDictation: (id: string) => invoke<void>("discard_failed_dictation", { id }),
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
  // games economy (use src/lib/economy.ts in views: it keeps the shared state and the browser mock)
  economyState: () => invoke<EconomyState>("economy_state"),
  economyAwardGame: (game: GameId, score: number, newBest: boolean, quit: boolean) =>
    invoke<GameAward>("economy_award_game", { game, score, newBest, quit }),
  economyBuy: (itemId: string) => invoke<EconomyState>("economy_buy", { itemId }),
  economyOpenBox: (boxId: BoxId) => invoke<BoxOpening>("economy_open_box", { boxId }),
  economyEquip: (slot: EquipSlot, itemId: string | null) => invoke<EconomyState>("economy_equip", { slot, itemId }),
};

/** Developer economy commands. Debug builds only: null in a release bundle (and the backend refuses them there). */
export const economyDevApi = import.meta.env.DEV
  ? {
      setUnlimited: (on: boolean) => invoke<EconomyState>("economy_dev_set_unlimited", { on }),
      addCoins: (amount: number) => invoke<EconomyState>("economy_dev_add_coins", { amount }),
      rankUp: () => invoke<RankUpResult>("economy_dev_rank_up"),
      grantKeys: (boxId: BoxId, count: number) => invoke<EconomyState>("economy_dev_grant_keys", { boxId, count }),
      reset: () => invoke<EconomyState>("economy_dev_reset"),
    }
  : null;

// ---------- Events ----------
/** Dictation whose target is Spechy's own window. Payload: InsertText. Mirrors EV_INSERT_TEXT in model.rs. */
export const EV_INSERT_TEXT = "spechy://insert-text";
export interface InsertText { text: string }

export const events = {
  onState: (cb: (s: DictationState) => void): Promise<UnlistenFn> => listen<DictationState>("spechy://state", (e) => cb(e.payload)),
  onMicLevel: (cb: (level: number) => void): Promise<UnlistenFn> => listen<number>("spechy://mic-level", (e) => cb(e.payload)),
  onHistoryAdded: (cb: (h: HistoryEntry) => void): Promise<UnlistenFn> => listen<HistoryEntry>("spechy://history-added", (e) => cb(e.payload)),
  onSettingsChanged: (cb: (s: Settings) => void): Promise<UnlistenFn> => listen<Settings>("spechy://settings-changed", (e) => cb(e.payload)),
  onToast: (cb: (t: Toast) => void): Promise<UnlistenFn> => listen<Toast>("spechy://toast", (e) => cb(e.payload)),
  onNavigate: (cb: (view: string) => void): Promise<UnlistenFn> => listen<string>("spechy://navigate", (e) => cb(e.payload)),
  onScratchpad: (cb: (text: string) => void): Promise<UnlistenFn> => listen<string>("spechy://scratchpad", (e) => cb(e.payload)),
  onFailedChanged: (cb: (list: FailedDictation[]) => void): Promise<UnlistenFn> => listen<FailedDictation[]>("spechy://failed-changed", (e) => cb(e.payload)),
  onInsertText: (cb: (p: InsertText) => void): Promise<UnlistenFn> => listen<InsertText>(EV_INSERT_TEXT, (e) => cb(e.payload)),
  /** Economy changed without the page asking (dictation rewards). Mirrors EV_ECONOMY_CHANGED in economy.rs. */
  onEconomyChanged: (cb: (s: EconomyState) => void): Promise<UnlistenFn> => listen<EconomyState>("spechy://economy-changed", (e) => cb(e.payload)),
};

// ---------- Leaderboard (opt-in; use src/lib/leaderboard.ts in views, it adds the browser mock) ----------
export type LeaderboardCategory = "overall" | "words" | "tower" | "snake" | "comet";
export type ReportKind = "name" | "avatar" | "player";
export interface LeaderboardStatus {
  joined: boolean;
  /** False in a release build until the owner deploys a server (and while the URL setting is invalid). */
  serverConfigured: boolean;
  displayName?: string;
  playerId?: string;
  /** Moderation hid the player or the picture. */
  hidden?: boolean;
  avatarHidden?: boolean;
}
/** One row as the backend returns it. `title` is the server's title id ("night-owl"). */
export interface LeaderboardRowRaw {
  /** null only for your own row while you have no value yet. */
  rank: number | null;
  playerId: string;
  name: string;
  title: string | null;
  /** 0 Bronze .. 6 Champion. */
  tier: number;
  /** 0..2 for I..III (0 at Champion). */
  division: number;
  rp: number;
  score: number;
  hasAvatar: boolean;
  avatarVersion: string | null;
  me: boolean;
}
export interface LeaderboardBoardRaw {
  cat: LeaderboardCategory;
  /** ISO week key, "2026-W47". */
  week: string;
  startsAt: string;
  endsAt: string;
  current: boolean;
  total: number;
  rows: LeaderboardRowRaw[];
  me: LeaderboardRowRaw | null;
}
/** What every leaderboard call rejects with. */
export interface LeaderboardError {
  /** Server code (validation_failed, rate_limited, ...) or local: network, not_configured, not_joined, already_joined, locked, invalid. */
  code: string;
  message: string;
  /** length | characters | profanity | reserved for a rejected name. */
  reason: string | null;
  retryAfter: number | null;
  status: number;
}
/** Fields of `update_me`; titleId null unequips. */
export interface LeaderboardMeFields { name?: string; titleId?: string | null; tier?: number; division?: number; rp?: number }

export const leaderboardApi = {
  status: () => invoke<LeaderboardStatus>("leaderboard_status"),
  join: (displayName: string) => invoke<LeaderboardStatus>("leaderboard_join", { displayName }),
  /** serverDeleted false = server unreachable, the deletion is retried automatically. */
  leave: () => invoke<{ serverDeleted: boolean }>("leaderboard_leave"),
  board: (cat: LeaderboardCategory) => invoke<LeaderboardBoardRaw>("leaderboard_board", { cat }),
  /** Raw picture bytes (ArrayBuffer). */
  avatar: (playerId: string) => invoke<ArrayBuffer>("leaderboard_avatar", { playerId }),
  updateMe: (fields: LeaderboardMeFields) => invoke<void>("leaderboard_update_me", { fields }),
  report: (playerId: string, reason: ReportKind, note?: string) => invoke<void>("leaderboard_report", { playerId, reason, note: note ?? null }),
  /** Sends the pending batch now; true when something is still pending. Normally the backend does this itself. */
  sync: () => invoke<boolean>("leaderboard_sync"),
  avatarSave: (bytes: Uint8Array, mime: string) => invoke<void>("leaderboard_avatar_save", bytes, { headers: { "x-mime": mime } }),
  /** The local picture; an empty buffer when none. */
  myAvatar: () => invoke<ArrayBuffer>("leaderboard_my_avatar"),
  /** Deletes the local picture and, when joined, the server copy. The unlock stays owned. */
  avatarRemove: () => invoke<void>("leaderboard_avatar_remove"),
  /** Monday payout check; null when not joined (no request), already paid or no top three finish. */
  claimPayout: () => invoke<WeeklyPayout | null>("leaderboard_claim_payout"),
};
/** Joined, left, moderated, or a sync finished. Payload: LeaderboardStatus. Mirrors EV_LEADERBOARD_CHANGED in leaderboard.rs. */
export const onLeaderboardChanged = (cb: (s: LeaderboardStatus) => void): Promise<UnlistenFn> =>
  listen<LeaderboardStatus>("spechy://leaderboard-changed", (e) => cb(e.payload));
