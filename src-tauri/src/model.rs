//! Shared data model: the contract between the Rust backend and the React UI.
//! Field names are serialized as camelCase; `src/lib/ipc.ts` mirrors every type here.
//! Do not rename fields without updating ipc.ts.

use serde::{Deserialize, Serialize};

// ---------- Events (backend -> UI) ----------
pub const EV_STATE: &str = "spechy://state"; // payload: DictationState
pub const EV_HISTORY_ADDED: &str = "spechy://history-added"; // payload: HistoryEntry
pub const EV_SETTINGS_CHANGED: &str = "spechy://settings-changed"; // payload: Settings
pub const EV_TOAST: &str = "spechy://toast"; // payload: Toast
pub const EV_NAVIGATE: &str = "spechy://navigate"; // payload: String (view id, e.g. "settings")
pub const EV_SCRATCHPAD: &str = "spechy://scratchpad"; // payload: String (full scratchpad text after a dictation landed there)

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Toast {
    pub kind: String, // "info" | "error" | "success"
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Recording,
    Transcribing,
    Polishing,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DictationMode {
    PushToTalk,
    HandsFree,
    Command,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictationState {
    pub phase: Phase,
    pub mode: DictationMode,
    /// Partial transcript while recording (only when live transcript is on).
    pub live_text: String,
    /// Microphone level 0.0..1.0 for the waveform dots.
    pub level: f32,
    /// Human-readable error when phase == Error.
    pub message: String,
    pub started_at_ms: i64,
}

impl Default for DictationState {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            mode: DictationMode::PushToTalk,
            live_text: String::new(),
            level: 0.0,
            message: String::new(),
            started_at_ms: 0,
        }
    }
}

// ---------- Settings ----------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    /// Chords as "Ctrl+Win", "Ctrl+Win+Space", "Ctrl+Win+Shift".
    /// Keys: Ctrl, Win, Alt, Shift, Space, F1..F12, A..Z, 0..9.
    pub push_to_talk: String,
    pub hands_free: String,
    pub command: String,
    pub paste_last: String,
}
impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            push_to_talk: "Ctrl+Win".into(),
            hands_free: "Ctrl+Win+Space".into(),
            command: "Ctrl+Win+Shift".into(),
            paste_last: "Shift+Alt+Z".into(),
        }
    }
}

#[cfg(test)]
mod hotkey_migration_tests {
    use super::Hotkeys;

    #[test]
    fn existing_shortcuts_survive_adding_paste_last() {
        let old = r#"{"pushToTalk":"Ctrl+F2","handsFree":"Ctrl+F3","command":"Ctrl+F4"}"#;
        let keys: Hotkeys = serde_json::from_str(old).unwrap();
        assert_eq!(keys.push_to_talk, "Ctrl+F2");
        assert_eq!(keys.command, "Ctrl+F4");
        assert_eq!(keys.paste_last, "Shift+Alt+Z");
        let mut changed = keys;
        changed.paste_last = "Ctrl+Alt+P".into();
        let saved = serde_json::to_string(&changed).unwrap();
        assert_eq!(serde_json::from_str::<Hotkeys>(&saved).unwrap().paste_last, "Ctrl+Alt+P");
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Providers {
    pub groq_api_key: String,
    pub openrouter_api_key: String,
    /// "auto" (Groq if key present, else OpenRouter) | "groq" | "openrouter" | "custom".
    /// "custom" is never picked by "auto": the user has to choose it.
    pub stt_provider: String,
    pub groq_model: String,
    /// OpenRouter model used for transcription (audio-capable chat model).
    pub openrouter_stt_model: String,
    /// OpenRouter chat model for the polish step.
    pub polish_model: String,
    pub polish_enabled: bool,
    /// Which endpoint runs the cleanup step: "openrouter" | "groq" | "custom".
    pub polish_provider: String,
    /// Groq chat model for the cleanup step (the free tier covers this too).
    pub groq_polish_model: String,
    /// Own or local OpenAI-compatible transcription server, base url up to /v1
    /// (for example http://localhost:8000/v1). Used with /audio/transcriptions.
    pub custom_stt_base_url: String,
    pub custom_stt_api_key: String,
    pub custom_stt_model: String,
    /// Own or local OpenAI-compatible chat server, base url up to /v1
    /// (for example http://localhost:11434/v1). Used with /chat/completions.
    pub custom_polish_base_url: String,
    pub custom_polish_api_key: String,
    pub custom_polish_model: String,
}
impl Default for Providers {
    fn default() -> Self {
        Self {
            groq_api_key: String::new(),
            openrouter_api_key: String::new(),
            stt_provider: "auto".into(),
            groq_model: "whisper-large-v3-turbo".into(),
            openrouter_stt_model: "google/gemini-2.5-flash".into(),
            polish_model: "google/gemini-2.5-flash-lite".into(),
            polish_enabled: true,
            polish_provider: "openrouter".into(),
            groq_polish_model: "llama-3.3-70b-versatile".into(),
            custom_stt_base_url: String::new(),
            custom_stt_api_key: String::new(),
            custom_stt_model: String::new(),
            custom_polish_base_url: String::new(),
            custom_polish_api_key: String::new(),
            custom_polish_model: String::new(),
        }
    }
}

/// One entry of a provider's model catalogue, shown in the settings model picker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// Human readable name; falls back to the id when the provider has none.
    pub name: String,
    /// The model can take audio input (transcription capable).
    pub audio: bool,
    /// The model costs nothing to use.
    pub free: bool,
}

// ---------- Local model library ----------

/// A graphics adapter as reported by the Windows display class registry keys.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    /// Dedicated video memory in MB; 0 when Windows reports none.
    pub vram_mb: u64,
    /// "nvidia" | "amd" | "intel" | "other"
    pub vendor: String,
}

/// What this PC can comfortably run. Every field is best effort: a missing value
/// is 0 or an empty string and must never be read as "no hardware at all".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub cpu_cores: u32,
    pub cpu_name: String,
    /// Strongest adapter, empty when only placeholder drivers were found.
    pub gpu_name: String,
    /// Dedicated memory usable for inference; 0 for integrated graphics or unknown.
    pub vram_mb: u64,
    /// "nvidia" | "amd" | "intel" | "none"
    pub gpu_vendor: String,
    pub gpus: Vec<GpuInfo>,
    /// Where downloaded models live, for example `%APPDATA%\com.remo.spechy\models`.
    pub models_dir: String,
}

/// One curated local speech model: everything the library needs to score it,
/// describe it and (when it is a single file) download it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub name: String,
    /// Runtime that serves this file: currently always "whisper_cpp".
    pub backend: String,
    /// Model generation as shown to people, for example "Whisper Large v3".
    pub family: String,
    /// Parameter count, for example "809M".
    pub params: String,
    /// Exact download size in bytes; used to verify the transfer.
    pub size_bytes: u64,
    /// SHA-256 of the published file, checked after the download.
    pub sha256: String,
    /// RAM the runtime needs with this model loaded for CPU inference.
    pub ram_mb: u64,
    /// Dedicated VRAM that makes this model comfortable on a GPU.
    pub vram_mb: u64,
    /// 1 (rough) .. 5 (excellent), language independent.
    pub quality: u8,
    /// 1 (slow) .. 5 (fast), relative to CPU inference.
    pub speed: u8,
    /// 1 .. 5 German transcription quality.
    pub german: u8,
    pub languages: String,
    pub english_only: bool,
    pub license: String,
    /// One sentence for the library card.
    pub note: String,
    /// File name inside the models folder.
    pub file: String,
    /// Direct download; empty when the model has to be installed by hand.
    pub url: String,
}

/// How well a model fits the machine it was scored on.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Fit {
    /// Runs on the GPU with room to spare.
    Great,
    /// Fits in RAM for CPU inference.
    Good,
    /// Fits, but leaves little room for other apps.
    Tight,
    /// Needs more memory than this PC has.
    TooBig,
}

/// A catalogue entry scored against the current machine, ready for the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelFit {
    pub model: LocalModel,
    pub fit: Fit,
    pub score: i64,
    /// Best pick for this PC and the configured dictation languages.
    pub recommended: bool,
    pub installed: bool,
    /// Full path of the installed file, when it is present.
    pub installed_path: Option<String>,
    /// One line explaining the fit, for example "Runs on your RTX 4070".
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppStyleRule {
    pub id: String,
    /// Substring matched case-insensitively against the foreground process name or window title (e.g. "slack", "outlook").
    pub app_match: String,
    /// "formal" | "casual" | "neutral"
    pub tone: String,
    pub note: String,
}
impl Default for AppStyleRule {
    fn default() -> Self {
        Self { id: String::new(), app_match: String::new(), tone: "neutral".into(), note: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StyleSettings {
    /// "neutral" | "formal" | "casual"
    pub default_tone: String,
    pub app_rules: Vec<AppStyleRule>,
    /// Free-text rules appended to the polish prompt.
    pub custom_rules: String,
    /// Keep filler words instead of removing them.
    pub keep_fillers: bool,
}
impl Default for StyleSettings {
    fn default() -> Self {
        Self { default_tone: "neutral".into(), app_rules: vec![], custom_rules: String::new(), keep_fillers: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub user_name: String,
    /// UI language: "en" | "de"
    pub app_language: String,
    /// "system" | "light" | "dark"
    pub theme: String,
    /// Whisper language hints, e.g. ["de", "en"]. Empty = auto.
    pub dictation_languages: Vec<String>,
    /// Microphone device name; empty = system default.
    pub microphone: String,
    pub hotkeys: Hotkeys,
    pub launch_at_login: bool,
    pub show_pill_always: bool,
    /// Size of the pill in percent of the base size (100 = 195 x 52 px at 100 % DPI).
    pub pill_scale: u32,
    pub dictation_reminder: bool,
    pub sounds: bool,
    pub live_transcript: bool,
    /// Code mode in terminals/IDEs: technical terms, no prose reformatting.
    pub vibe_coding: bool,
    /// Extra process names (lowercase, e.g. "code.exe") treated as coding apps.
    pub vibe_coding_apps: Vec<String>,
    pub providers: Providers,
    pub style: StyleSettings,
    /// When true, dictations go to the scratchpad instead of the focused app.
    pub scratchpad_pinned: bool,
    pub onboarded: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            user_name: String::new(),
            app_language: "en".into(),
            theme: "system".into(),
            dictation_languages: vec!["de".into(), "en".into()],
            microphone: String::new(),
            hotkeys: Hotkeys::default(),
            launch_at_login: false,
            show_pill_always: false,
            pill_scale: 70,
            dictation_reminder: true,
            sounds: true,
            live_transcript: true,
            vibe_coding: true,
            vibe_coding_apps: vec![],
            providers: Providers::default(),
            style: StyleSettings::default(),
            scratchpad_pinned: false,
            onboarded: false,
        }
    }
}

// ---------- Data ----------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    /// Unix ms.
    pub created_at: i64,
    pub text: String,
    pub raw_text: String,
    pub app_name: String,
    pub app_title: String,
    pub duration_ms: i64,
    pub latency_ms: i64,
    pub word_count: i64,
    pub flagged: bool,
    pub mode: DictationMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntry {
    pub id: String,
    pub word: String,
    /// Misspelling that should become `word` (empty = plain vocabulary word).
    pub misspelling: String,
    pub auto_learned: bool,
    pub starred: bool,
    pub created_at: i64,
    pub uses: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub trigger: String,
    pub text: String,
    pub created_at: i64,
    pub uses: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub builtin: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    /// "YYYY-MM-DD"
    pub date: String,
    pub words: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppStat {
    pub app_name: String,
    /// "ai" | "coding" | "messages" | "documents" | "email" | "other"
    pub category: String,
    pub words: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WordStat {
    pub word: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_words: i64,
    pub total_dictations: i64,
    pub wpm: i64,
    pub streak_days: i64,
    pub longest_streak: i64,
    /// Words changed by the polish step (raw vs final, rough diff count).
    pub fixes: i64,
    pub dictionary_fixes: i64,
    pub words_this_month: i64,
    pub words_prev_month: i64,
    pub per_day: Vec<DayStat>,
    pub per_app: Vec<AppStat>,
    pub top_words: Vec<WordStat>,
    pub apps_used: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MicDevice {
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub entries: Vec<HistoryEntry>,
    pub total: i64,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
