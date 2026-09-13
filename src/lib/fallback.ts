// Browser dev fallback used by the shell views (Home, Dictionary, Snippets, Help).
// The Tauri `invoke` bridge does not exist in a plain browser, so every backend call
// goes through `safe()` and the view renders an empty state instead of crashing.
// TESTCODE (2026-09-13): `?mock=1` additionally feeds sample data for visual checks.
import type { DictionaryEntry, HistoryEntry, HistoryPage, MicDevice, ModelInfo, ModelSource, Settings, Snippet, Stats } from "./ipc";

export const MOCK = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1";
/** TESTCODE (2026-09-13): `?mock=1&onboarding=1` starts the shell in the first run flow. */
export const ONBOARDING_MOCK = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("onboarding") === "1";

/** Run a backend call, fall back to a default value when the bridge is missing or fails. */
export async function safe<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch {
    return fallback;
  }
}

export const defaultSettings: Settings = {
  userName: "",
  appLanguage: "en",
  theme: "system",
  dictationLanguages: ["en", "de"],
  microphone: "",
  hotkeys: { pushToTalk: "Ctrl+Win", handsFree: "Ctrl+Win+Space", command: "Ctrl+Alt", pasteLast: "Shift+Alt+Z" },
  launchAtLogin: false,
  showPillAlways: false,
  pillScale: 70,
  dictationReminder: true,
  sounds: true,
  liveTranscript: true,
  vibeCoding: false,
  vibeCodingApps: [],
  providers: {
    groqApiKey: "",
    openrouterApiKey: "",
    sttProvider: "auto",
    groqModel: "whisper-large-v3-turbo",
    openrouterSttModel: "",
    polishModel: "",
    polishEnabled: true,
    polishProvider: "openrouter",
    groqPolishModel: "llama-3.3-70b-versatile",
    customSttBaseUrl: "",
    customSttApiKey: "",
    customSttModel: "",
    customPolishBaseUrl: "",
    customPolishApiKey: "",
    customPolishModel: "",
  },
  style: { defaultTone: "neutral", appRules: [], customRules: "", keepFillers: false },
  scratchpadPinned: false,
  onboarded: !ONBOARDING_MOCK,
};

const DAY = 86_400_000;
const now = Date.now();
const at = (hours: number, days = 0) => {
  const d = new Date(now - days * DAY);
  d.setHours(hours, Math.floor((hours * 37) % 60), 0, 0);
  return d.getTime();
};

const texts = [
  "Please send the meeting notes tomorrow.",
  "The new version is ready for testing.",
  "Thanks for your feedback. I will make those changes.",
  "The project builds successfully on Windows.",
  "Let's review the plan at our next meeting.",
  "Could you summarize the discussion?",
  "Please run the tests before publishing.",
];

export const mockHistory: HistoryEntry[] = texts.map((text, i) => ({
  id: "m" + i,
  createdAt: i < 5 ? at(23 - i * 2) : at(18 - i, 1),
  text,
  rawText: text.replace(/,/g, "").toLowerCase(),
  appName: i % 2 ? "code.exe" : "chrome.exe",
  appTitle: i % 2 ? "Visual Studio Code" : "Chrome",
  durationMs: 4200 + i * 900,
  latencyMs: 780 + i * 40,
  wordCount: text.split(/\s+/).length,
  flagged: i === 2,
  mode: "push-to-talk" as const,
}));

export const mockHistoryPage: HistoryPage = { entries: mockHistory, total: mockHistory.length };

export const mockStats: Stats = {
  totalWords: 172_400,
  totalDictations: 1843,
  wpm: 121,
  streakDays: 7,
  longestStreak: 19,
  fixes: 412,
  dictionaryFixes: 74,
  wordsThisMonth: 22_100,
  wordsPrevMonth: 18_400,
  perDay: [],
  perApp: [],
  topWords: [],
  appsUsed: 9,
};

export const mockDictionary: DictionaryEntry[] = [
  { id: "d0", word: "Spechy", misspelling: "", autoLearned: true, starred: true, createdAt: now, uses: 42 },
  { id: "d1", word: "ChatGPT", misspelling: "", autoLearned: true, starred: false, createdAt: now - DAY, uses: 31 },
  { id: "d2", word: "TypeScript", misspelling: "", autoLearned: true, starred: false, createdAt: now - 2 * DAY, uses: 12 },
  { id: "d3", word: "codex", misspelling: "", autoLearned: true, starred: false, createdAt: now - 3 * DAY, uses: 9 },
  { id: "d4", word: "alex@example.com", misspelling: "", autoLearned: false, starred: false, createdAt: now - 4 * DAY, uses: 4 },
  { id: "d5", word: "Acme", misspelling: "Ack me", autoLearned: false, starred: true, createdAt: now - 5 * DAY, uses: 18 },
  { id: "d6", word: "GitHub", misspelling: "", autoLearned: true, starred: false, createdAt: now - 6 * DAY, uses: 7 },
  { id: "d7", word: "claude", misspelling: "", autoLearned: false, starred: false, createdAt: now - 7 * DAY, uses: 55 },
  { id: "d8", word: "Vercel", misspelling: "", autoLearned: true, starred: false, createdAt: now - 8 * DAY, uses: 6 },
];

export const mockSnippets: Snippet[] = [
  { id: "s0", trigger: "my email address", text: "alex@example.com", createdAt: now, uses: 11 },
  { id: "s1", trigger: "organize thoughts prompt", text: "Organize these unstructured thoughts into a clear, polished version without losing any detail, keep my voice and do not invent anything.", createdAt: now - DAY, uses: 5 },
  { id: "s2", trigger: "my signature", text: "Best regards, Alex", createdAt: now - 2 * DAY, uses: 3 },
];

/** TESTCODE (2026-09-13): model lists so the picker renders in a plain browser. */
const mockModelLists: Record<ModelSource, ModelInfo[]> = {
  openrouter: [
    { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5", audio: false, free: false },
    { id: "google/gemini-2.0-flash-001", name: "Google: Gemini 2.0 Flash", audio: true, free: false },
    { id: "google/gemini-2.5-flash", name: "Google: Gemini 2.5 Flash", audio: true, free: false },
    { id: "google/gemini-2.5-flash-lite", name: "Google: Gemini 2.5 Flash Lite", audio: true, free: false },
    { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Meta: Llama 3.3 70B Instruct (free)", audio: false, free: true },
    { id: "openai/gpt-4.1-mini", name: "OpenAI: GPT-4.1 mini", audio: false, free: false },
    { id: "qwen/qwen3-30b-a3b:free", name: "Qwen: Qwen3 30B A3B (free)", audio: false, free: true },
  ],
  groq: [
    { id: "llama-3.1-8b-instant", name: "llama-3.1-8b-instant", audio: false, free: false },
    { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b-versatile", audio: false, free: false },
    { id: "whisper-large-v3", name: "whisper-large-v3", audio: true, free: false },
    { id: "whisper-large-v3-turbo", name: "whisper-large-v3-turbo", audio: true, free: false },
  ],
  custom_stt: [
    { id: "Systran/faster-whisper-large-v3", name: "Systran/faster-whisper-large-v3", audio: false, free: false },
    { id: "ggml-large-v3-turbo", name: "ggml-large-v3-turbo", audio: false, free: false },
  ],
  custom_polish: [
    { id: "llama3.2:3b", name: "llama3.2:3b", audio: false, free: false },
    { id: "qwen2.5:7b-instruct", name: "qwen2.5:7b-instruct", audio: false, free: false },
  ],
};

/** Sample catalogue for `?mock=1`; outside mock mode the picker shows the real error. */
export function mockModels(provider: ModelSource): ModelInfo[] {
  return mockModelLists[provider] ?? [];
}

export const mockMicrophones: MicDevice[] = [
  { name: "Microphone Array (Realtek(R) Audio)", isDefault: true },
  { name: "Headset (WH-1000XM4 Hands-Free)", isDefault: false },
  { name: "Webcam C920 (USB Audio)", isDefault: false },
];
