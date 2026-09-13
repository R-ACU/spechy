//! The dictation orchestrator: one state machine, one dictation at a time.
//!
//! Hotkeys and the pill call in here, everything slow runs on its own thread so
//! the keyboard hook callback stays instant.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::audio::Recorder;
use crate::model::{
    new_id, now_ms, DictationMode, DictationState, HistoryEntry, Phase, Toast, EV_HISTORY_ADDED, EV_SCRATCHPAD,
    EV_STATE, EV_TOAST,
};
use crate::pill::PillState;
use crate::sound::SoundKind;

/// Recordings quieter than this never reach the transcription service
/// (Whisper hallucinates on silence).
const SILENCE_RMS: f32 = 0.01;
/// Interval for the live partial transcript.
/// 3.5 s keeps a long dictation under Groq's free-tier limit of 20 requests per minute.
const PARTIAL_INTERVAL: Duration = Duration::from_millis(3500);
/// Hands-free recordings are cut into segments of this length.
const SEGMENT_SECS: u64 = 60;
/// How long an error stays on the pill.
const ERROR_HOLD: Duration = Duration::from_millis(2500);

static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: OnceLock<Mutex<PipelineState>> = OnceLock::new();
static PARTIAL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
/// Incremented on every start and cancel so stale worker threads notice they are obsolete.
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Default)]
struct PipelineState {
    public: DictationState,
    recorder: Option<Recorder>,
    /// Foreground window we recorded from; the text goes back there.
    target_hwnd: isize,
    target_process: String,
    target_title: String,
    /// Selection captured at the start of a command dictation.
    selection: String,
    /// Text of the hands-free segments already transcribed.
    segments: Vec<String>,
    generation: u64,
}

fn state_cell() -> &'static Mutex<PipelineState> {
    STATE.get_or_init(|| Mutex::new(PipelineState::default()))
}

fn lock() -> std::sync::MutexGuard<'static, PipelineState> {
    match state_cell().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// The app handle for modules that emit their own events (microphone preview).
pub fn app_handle() -> Option<&'static AppHandle> {
    APP.get()
}

pub fn is_recording() -> bool {
    matches!(lock().public.phase, Phase::Recording)
}

fn emit_state(snapshot: &DictationState) {
    if let Some(app) = app() {
        let _ = app.emit(EV_STATE, snapshot);
    }
}

fn toast(kind: &str, message: &str) {
    if let Some(app) = app() {
        let _ = app.emit(EV_TOAST, Toast { kind: kind.into(), message: message.into() });
    }
}

fn sound(kind: SoundKind) {
    if crate::settings::current().sounds {
        crate::sound::play(kind);
    }
}

/// The current public state for the UI.
pub fn state() -> DictationState {
    lock().public.clone()
}

fn set_phase(phase: Phase, message: &str) {
    let snapshot = {
        let mut s = lock();
        s.public.phase = phase;
        s.public.message = message.to_string();
        s.public.clone()
    };
    emit_state(&snapshot);
}

// ---------- Wiring ----------

/// Wire hotkeys, pill and the settings mirror. Called once from `lib.rs` setup.
pub fn init(handle: AppHandle) {
    let _ = APP.set(handle);
    let _ = state_cell();

    let settings = crate::settings::current();

    if let Err(e) = crate::pill::init(cancel, stop) {
        log::error!("the pill window could not be created: {e}");
    }
    crate::pill::set_always_visible(settings.show_pill_always);

    let config = crate::hotkey::HotkeyConfig {
        push_to_talk: settings.hotkeys.push_to_talk.clone(),
        hands_free: settings.hotkeys.hands_free.clone(),
        command: settings.hotkeys.command.clone(),
        paste_last: settings.hotkeys.paste_last.clone(),
    };
    if let Err(e) = crate::hotkey::start(config, on_hotkey) {
        log::error!("the keyboard hook could not be installed: {e}");
        toast("error", "The keyboard hook could not be installed. Hotkeys will not work.");
    }
}

fn on_hotkey(event: crate::hotkey::HotkeyEvent) {
    use crate::hotkey::HotkeyEvent as E;
    match event {
        E::PasteLast => {
            if !matches!(state().phase, Phase::Idle) { return; }
            match crate::db::list_history(1, 0, "") {
                Ok(page) => {
                    if let Some(entry) = page.entries.first() {
                        if let Err(error) = crate::paste::paste_text(&entry.text) {
                            toast("error", &error);
                        }
                    } else {
                        toast("info", "No dictation to paste yet.");
                    }
                }
                Err(error) => toast("error", &error),
            }
        }
        E::PttDown => {
            // While a hands-free dictation runs, the push-to-talk chord submits it.
            let hands_free_running = {
                let s = lock();
                matches!(s.public.phase, Phase::Recording) && s.public.mode == DictationMode::HandsFree
            };
            if hands_free_running {
                stop();
            } else {
                let _ = start(DictationMode::PushToTalk);
            }
        }
        E::PttUp => stop(),
        E::CommandDown => {
            let _ = start(DictationMode::Command);
        }
        E::CommandUp => stop(),
        E::HandsFreeToggle => {
            let recording = matches!(lock().public.phase, Phase::Recording);
            if recording {
                stop();
            } else {
                let _ = start(DictationMode::HandsFree);
            }
        }
        E::Escape => cancel(),
    }
}

// ---------- Start ----------

pub fn start(mode: DictationMode) -> Result<(), String> {
    if matches!(lock().public.phase, Phase::Recording) {
        return Ok(());
    }

    // The microphone preview must let go of the device before a dictation opens it.
    crate::mictest::stop();

    let settings = crate::settings::current();
    let app_info = crate::winutil::foreground_app();

    // Command mode works on whatever is selected right now.
    let selection = if mode == DictationMode::Command {
        crate::paste::copy_selection().unwrap_or_default()
    } else {
        String::new()
    };

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let recorder = Recorder::start(&settings.microphone, move |level| {
        let snapshot = {
            let mut s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
            s.public.level = level;
            s.public.clone()
        };
        crate::pill::set_state(PillState::Recording {
            level: snapshot.level,
            live_text: snapshot.live_text.clone(),
        });
    })?;

    {
        let mut s = lock();
        s.public = DictationState {
            phase: Phase::Recording,
            mode,
            live_text: String::new(),
            level: 0.0,
            message: String::new(),
            started_at_ms: now_ms(),
        };
        s.recorder = Some(recorder);
        s.target_hwnd = app_info.hwnd;
        s.target_process = app_info.process_name.clone();
        s.target_title = app_info.title.clone();
        s.selection = selection;
        s.segments.clear();
        s.generation = generation;
    }

    crate::hotkey::set_active(true);
    // The push-to-talk chord alone submits a hands-free dictation, so the hook has
    // to know that one is running.
    crate::hotkey::set_hands_free_running(mode == DictationMode::HandsFree);
    sound(SoundKind::Start);
    crate::pill::set_state(PillState::Recording { level: 0.0, live_text: String::new() });
    emit_state(&state());

    if settings.live_transcript && mode != DictationMode::Command {
        spawn_partial_loop(generation);
    }
    if mode == DictationMode::HandsFree {
        spawn_segment_loop(generation);
    }
    Ok(())
}

/// Live transcript: every couple of seconds a snapshot goes through the STT provider.
fn spawn_partial_loop(generation: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(PARTIAL_INTERVAL);
        let wav = {
            let s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
            match s.recorder.as_ref() {
                Some(r) => r.snapshot_wav(),
                None => return,
            }
        };
        if PARTIAL_IN_FLIGHT.swap(true, Ordering::SeqCst) {
            continue; // a request is already running, skip this tick
        }
        let settings = crate::settings::current();
        let dictionary = crate::db::list_dictionary().unwrap_or_default();
        let vocabulary: Vec<String> = dictionary.iter().map(|d| d.word.clone()).collect();
        let result = crate::stt::transcribe(
            &settings.providers,
            crate::stt::SttRequest {
                wav: &wav,
                language: settings.spoken_language(),
                vocabulary: &vocabulary,
                partial: true,
            },
        );
        PARTIAL_IN_FLIGHT.store(false, Ordering::SeqCst);

        let Ok(text) = result else { continue };
        if text.trim().is_empty() {
            continue;
        }
        let snapshot = {
            let mut s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
            let prefix = s.segments.join(" ");
            s.public.live_text = if prefix.is_empty() { text.clone() } else { format!("{prefix} {text}") };
            s.public.clone()
        };
        crate::pill::set_state(PillState::Recording {
            level: snapshot.level,
            live_text: snapshot.live_text.clone(),
        });
        emit_state(&snapshot);
    });
}

/// Hands-free: close a segment every minute so no single request gets too large.
fn spawn_segment_loop(generation: u64) {
    std::thread::spawn(move || loop {
        for _ in 0..SEGMENT_SECS {
            std::thread::sleep(Duration::from_secs(1));
            let s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
        }
        // Rotate the recorder: stop the running one, start a fresh one.
        let settings = crate::settings::current();
        let old = {
            let mut s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
            s.recorder.take()
        };
        let Some(old) = old else { return };
        let (wav, _duration) = old.stop();

        let fresh = Recorder::start(&settings.microphone, move |level| {
            let snapshot = {
                let mut s = lock();
                if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                    return;
                }
                s.public.level = level;
                s.public.clone()
            };
            crate::pill::set_state(PillState::Recording {
                level: snapshot.level,
                live_text: snapshot.live_text.clone(),
            });
        });
        match fresh {
            Ok(r) => lock().recorder = Some(r),
            Err(e) => {
                log::error!("the microphone could not be restarted: {e}");
                fail("The microphone stopped working");
                return;
            }
        }

        let dictionary = crate::db::list_dictionary().unwrap_or_default();
        let vocabulary: Vec<String> = dictionary.iter().map(|d| d.word.clone()).collect();
        if let Ok(text) = crate::stt::transcribe(
            &settings.providers,
            crate::stt::SttRequest {
                wav: &wav,
                language: settings.spoken_language(),
                vocabulary: &vocabulary,
                partial: false,
            },
        ) {
            if !text.trim().is_empty() {
                let mut s = lock();
                if s.generation == generation {
                    s.segments.push(text.trim().to_string());
                }
            }
        }
    });
}

// ---------- Cancel ----------

pub fn cancel() {
    let recorder = {
        let mut s = lock();
        if matches!(s.public.phase, Phase::Idle) {
            return;
        }
        GENERATION.fetch_add(1, Ordering::SeqCst);
        s.generation = GENERATION.load(Ordering::SeqCst);
        s.public = DictationState::default();
        s.segments.clear();
        s.selection.clear();
        s.recorder.take()
    };
    if let Some(r) = recorder {
        let _ = r.stop();
    }
    crate::hotkey::set_active(false);
    crate::pill::set_state(PillState::Done);
    emit_state(&state());
}

fn fail(message: &str) {
    set_phase(Phase::Error, message);
    crate::pill::set_state(PillState::Error { message: message.to_string() });
    toast("error", message);
    sound(SoundKind::Error);
    std::thread::spawn(move || {
        std::thread::sleep(ERROR_HOLD);
        crate::pill::set_state(PillState::Done);
    });
    let snapshot = {
        let mut s = lock();
        s.recorder = None;
        s.public = DictationState::default();
        s.public.clone()
    };
    crate::hotkey::set_active(false);
    emit_state(&snapshot);
}

// ---------- Stop and the finishing work ----------

pub fn stop() {
    let (recorder, mode, generation) = {
        let mut s = lock();
        if !matches!(s.public.phase, Phase::Recording) {
            return;
        }
        (s.recorder.take(), s.public.mode, s.generation)
    };
    let Some(recorder) = recorder else { return };

    crate::hotkey::set_active(false);
    sound(SoundKind::Stop);
    set_phase(Phase::Transcribing, "");
    crate::pill::set_state(PillState::Processing);

    std::thread::spawn(move || {
        let stop_instant = Instant::now();
        let peak = recorder.peak_rms();
        let (wav, duration_ms) = recorder.stop();

        if GENERATION.load(Ordering::SeqCst) != generation {
            return; // cancelled while we were stopping
        }

        let segments = lock().segments.clone();
        if peak < SILENCE_RMS && segments.is_empty() {
            let snapshot = {
                let mut s = lock();
                s.public = DictationState::default();
                s.public.clone()
            };
            crate::pill::set_state(PillState::Done);
            emit_state(&snapshot);
            return;
        }

        if let Err(message) = finish(wav, duration_ms, mode, generation, stop_instant, segments) {
            fail(&message);
        }
    });
}

fn finish(
    wav: Vec<u8>,
    duration_ms: u64,
    mode: DictationMode,
    generation: u64,
    stop_instant: Instant,
    segments: Vec<String>,
) -> Result<(), String> {
    let settings = crate::settings::current();
    let dictionary = crate::db::list_dictionary().unwrap_or_default();
    let snippets = crate::db::list_snippets().unwrap_or_default();
    let vocabulary: Vec<String> = dictionary.iter().map(|d| d.word.clone()).collect();

    // Keep the last recording on disk for debugging mic problems (overwritten every time).
    #[cfg(debug_assertions)]
    let _ = std::fs::write(crate::settings::data_dir().join("last-recording.wav"), &wav);

    // 1) Transcribe the last (or only) chunk.
    let tail = if wav.len() > 1024 {
        crate::stt::transcribe(
            &settings.providers,
            crate::stt::SttRequest {
                wav: &wav,
                language: settings.spoken_language(),
                vocabulary: &vocabulary,
                partial: false,
            },
        )?
    } else {
        String::new()
    };

    let mut raw = segments.join(" ");
    if !tail.trim().is_empty() {
        if raw.is_empty() {
            raw = tail.trim().to_string();
        } else {
            raw.push(' ');
            raw.push_str(tail.trim());
        }
    }
    let raw = raw.trim().to_string();

    if GENERATION.load(Ordering::SeqCst) != generation {
        return Ok(());
    }

    if raw.is_empty() {
        let snapshot = {
            let mut s = lock();
            s.public = DictationState::default();
            s.public.clone()
        };
        crate::pill::set_state(PillState::Done);
        emit_state(&snapshot);
        return Ok(());
    }

    // 2) Polish.
    set_phase(Phase::Polishing, "");
    let (target_hwnd, target_process, target_title, selection) = {
        let s = lock();
        (s.target_hwnd, s.target_process.clone(), s.target_title.clone(), s.selection.clone())
    };
    let foreground = crate::winutil::ForegroundApp {
        process_name: target_process.clone(),
        title: target_title.clone(),
        hwnd: target_hwnd,
    };
    let vibe = is_vibe_app(&settings, &target_process);
    let command_instruction = if mode == DictationMode::Command { Some(raw.as_str()) } else { None };

    let polished = crate::polish::polish(crate::polish::PolishContext {
        raw: &raw,
        settings: &settings,
        dictionary: &dictionary,
        snippets: &snippets,
        app: &foreground,
        vibe,
        command_instruction,
        selection: if mode == DictationMode::Command { Some(selection.as_str()) } else { None },
    });

    let (text, used_dictionary, used_snippets, dictionary_fixes, polish_failed) = match polished {
        Ok(r) => (r.text, r.used_dictionary, r.used_snippets, r.dictionary_fixes, false),
        Err(e) => {
            log::warn!("polish failed, using the raw transcript: {e}");
            toast("error", &format!("Cleanup failed, the raw text was used. {e}"));
            (raw.clone(), Vec::new(), Vec::new(), 0, true)
        }
    };

    if GENERATION.load(Ordering::SeqCst) != generation {
        return Ok(());
    }
    if text.trim().is_empty() {
        let snapshot = {
            let mut s = lock();
            s.public = DictationState::default();
            s.public.clone()
        };
        crate::pill::set_state(PillState::Done);
        emit_state(&snapshot);
        return Ok(());
    }

    // 3) Deliver: scratchpad when pinned, otherwise the app we recorded from.
    // Spechy's own window is a normal target too (onboarding practice box, scratchpad view).
    let to_scratchpad = settings.scratchpad_pinned;

    if to_scratchpad {
        let existing = crate::db::get_scratchpad().unwrap_or_default();
        let combined = if existing.trim().is_empty() {
            text.clone()
        } else {
            format!("{}\n\n{}", existing.trim_end(), text)
        };
        crate::db::set_scratchpad(&combined)?;
        if let Some(app) = app() {
            let _ = app.emit(EV_SCRATCHPAD, combined);
        }
    } else {
        crate::winutil::focus_hwnd(target_hwnd);
        // Give the target a moment to take the focus back before Ctrl+V.
        std::thread::sleep(Duration::from_millis(60));
        if let Err(e) = crate::paste::paste_text(&text) {
            log::warn!("pasting failed, falling back to typing: {e}");
            if let Err(e2) = crate::paste::type_text(&text) {
                let _ = crate::paste::set_clipboard(&text);
                return Err(format!("The text could not be inserted, it is on the clipboard. {e2}"));
            }
        }
    }

    // 4) History.
    let latency_ms = stop_instant.elapsed().as_millis() as i64;
    let entry = HistoryEntry {
        id: new_id(),
        created_at: now_ms(),
        text: text.clone(),
        raw_text: raw,
        app_name: if to_scratchpad { "Spechy".to_string() } else { target_process },
        app_title: if to_scratchpad { "Scratchpad".to_string() } else { target_title },
        duration_ms: duration_ms as i64,
        latency_ms,
        word_count: text.split_whitespace().count() as i64,
        flagged: false,
        mode,
    };
    if let Err(e) = crate::db::insert_history_with_fixes(&entry, dictionary_fixes) {
        log::error!("the dictation could not be saved: {e}");
    }
    let _ = crate::db::bump_dictionary_uses(&used_dictionary);
    let _ = crate::db::bump_snippet_uses(&used_snippets);
    if let Some(app) = app() {
        let _ = app.emit(EV_HISTORY_ADDED, &entry);
    }

    if polish_failed {
        let _ = crate::paste::set_clipboard(&text);
    }

    // 5) Back to idle.
    let snapshot = {
        let mut s = lock();
        s.public = DictationState::default();
        s.segments.clear();
        s.selection.clear();
        s.public.clone()
    };
    crate::pill::set_state(PillState::Done);
    emit_state(&snapshot);
    Ok(())
}

/// Coding context: the global toggle plus a known editor or terminal.
fn is_vibe_app(settings: &crate::model::Settings, process_name: &str) -> bool {
    if !settings.vibe_coding {
        return false;
    }
    let name = process_name.to_lowercase();
    if settings.vibe_coding_apps.iter().any(|a| a.to_lowercase() == name) {
        return true;
    }
    crate::winutil::app_category(&name, "") == "coding"
}
