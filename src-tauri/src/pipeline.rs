//! The dictation orchestrator: one state machine, one dictation at a time.
//!
//! Hotkeys and the pill call in here, everything slow runs on its own thread so
//! the keyboard hook callback stays instant.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::audio::Recorder;
use crate::failed::{Part, Pending};
use crate::model::{
    new_id, now_ms, DictationMode, DictationState, FailedDictation, HistoryEntry, Phase, Toast, EV_HISTORY_ADDED,
    EV_SCRATCHPAD, EV_STATE, EV_TOAST,
};
use crate::pill::PillState;
use crate::sound::SoundKind;

/// Parts whose speech share falls below this are suspicious: mostly-silent
/// audio is where Whisper invents watermarks (bare links, subtitle credits).
const LOW_SPEECH: f32 = 0.5;
/// Interval for the live partial transcript.
/// 3.5 s keeps a long dictation under Groq's free-tier limit of 20 requests per minute.
const PARTIAL_INTERVAL: Duration = Duration::from_millis(3500);
/// The live transcript only sends the last this many seconds of audio: a long
/// push-to-talk or a full hands-free minute used to go out whole every tick.
const LIVE_WINDOW_SECS: u32 = 20;
/// Hands-free recordings are cut into segments of this length.
const SEGMENT_SECS: u64 = 60;
/// How long an error stays on the pill.
const ERROR_HOLD: Duration = Duration::from_millis(2500);
/// A failure the user can retry stays clickable on the pill a little longer.
const RETRY_HOLD: Duration = Duration::from_millis(7000);

static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: OnceLock<Mutex<PipelineState>> = OnceLock::new();
static PARTIAL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
/// Incremented on every start and retry: each dictation owns one generation.
/// A newer dictation never cancels an older one that is still transcribing;
/// the older one finishes in the background and only stays off the pill.
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Generations the user threw away with Escape (or the pill's cancel).
static CANCELLED: Mutex<Vec<u64>> = Mutex::new(Vec::new());
/// Failed dictation the error on the pill belongs to; a click on the pill retries it.
static PILL_RETRY: Mutex<Option<String>> = Mutex::new(None);
/// A held dictation (push-to-talk, command, prompt) ends when the hotkey module
/// reports its chord released for this many watchdog ticks in a row.
const HOLD_WATCHDOG_TICK: Duration = Duration::from_millis(250);
const HOLD_WATCHDOG_MISSES: u32 = 4;

fn mark_cancelled(generation: u64) {
    if let Ok(mut list) = CANCELLED.lock() {
        list.push(generation);
        let len = list.len();
        if len > 32 {
            list.drain(..len - 32);
        }
    }
}

fn is_cancelled(generation: u64) -> bool {
    CANCELLED.lock().map(|list| list.contains(&generation)).unwrap_or(false)
}

/// True while no newer dictation has started: only then may a background step
/// touch the shared state, the pill and the sounds.
fn is_current(generation: u64) -> bool {
    lock().generation == generation
}

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
    /// Closed hands-free segments: their text, or their audio when the
    /// transcription failed (retried when the dictation is finished).
    parts: Vec<Part>,
    /// Live-transcript text of each closed segment at the moment it was cut,
    /// shown on the pill until the segment's real transcript arrives.
    previews: Vec<String>,
    /// Live-transcript text of the audio since the last segment cut.
    live_tail: String,
    generation: u64,
}

impl PipelineState {
    /// Forget everything that belongs to the parts of a dictation.
    fn clear_parts(&mut self) {
        self.parts.clear();
        self.previews.clear();
        self.live_tail.clear();
    }
}

/// The text of the parts that are already transcribed, in spoken order.
fn joined_text(parts: &[Part]) -> String {
    parts
        .iter()
        .filter_map(|part| match part {
            Part::Text(text) => Some(text.trim()),
            Part::Audio(_) => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The text for the live transcript: transcribed parts as they are, parts still
/// in flight with the live text they had when they were cut.
fn preview_text(parts: &[Part], previews: &[String]) -> String {
    parts
        .iter()
        .enumerate()
        .map(|(index, part)| match part {
            Part::Text(text) => text.trim(),
            Part::Audio(_) => previews.get(index).map(|p| p.trim()).unwrap_or(""),
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Normalized form of a word for overlap matching: lowercase letters and digits.
fn word_key(word: &str) -> String {
    word.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Stitch the transcript of a sliding live window onto the live text so far.
/// `previous` covers the audio up to the last tick, `fresh` only the last
/// LIVE_WINDOW_SECS, so the two overlap. The first word of `fresh` may be cut
/// in half by the window, so the next up to three words anchor the join; the
/// latest place in `previous` where they appear is where `fresh` takes over.
/// Without a match the texts are joined with an ellipsis: the live transcript
/// is only a preview, the final text is transcribed from the full audio.
fn merge_live(previous: &str, fresh: &str) -> String {
    let fresh = fresh.trim();
    let previous = previous.trim();
    if previous.is_empty() {
        return fresh.to_string();
    }
    let fresh_words: Vec<&str> = fresh.split_whitespace().collect();
    // (index in fresh_words, key) of the words after the possibly clipped first one.
    let fresh_keys: Vec<(usize, String)> = fresh_words
        .iter()
        .enumerate()
        .skip(1)
        .map(|(i, w)| (i, word_key(w)))
        .filter(|(_, k)| !k.is_empty())
        .collect();
    if fresh_keys.is_empty() {
        return previous.to_string();
    }
    let anchor_len = fresh_keys.len().min(3);
    let anchor: Vec<&str> = fresh_keys[..anchor_len].iter().map(|(_, k)| k.as_str()).collect();

    let previous_words: Vec<&str> = previous.split_whitespace().collect();
    let previous_keys: Vec<(usize, String)> = previous_words
        .iter()
        .enumerate()
        .map(|(i, w)| (i, word_key(w)))
        .filter(|(_, k)| !k.is_empty())
        .collect();

    let found = (0..(previous_keys.len() + 1).saturating_sub(anchor_len))
        .rev()
        .find(|&start| (0..anchor_len).all(|j| previous_keys[start + j].1 == anchor[j]));
    let from_fresh = fresh_keys[0].0;
    match found {
        Some(start) => {
            let cut = previous_keys[start].0;
            let mut words: Vec<&str> = previous_words[..cut].to_vec();
            words.extend_from_slice(&fresh_words[from_fresh..]);
            words.join(" ")
        }
        None => format!("{previous} \u{2026} {}", fresh_words[from_fresh..].join(" ")),
    }
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
    crate::pill::set_retry_handler(retry_from_pill);
    crate::pill::set_always_visible(settings.show_pill_always);
    // Prunes recordings past their retention.
    let _ = crate::failed::list();

    let config = crate::hotkey::HotkeyConfig {
        push_to_talk: settings.hotkeys.push_to_talk.clone(),
        hands_free: settings.hotkeys.hands_free.clone(),
        command: settings.hotkeys.command.clone(),
        prompt: settings.hotkeys.prompt.clone(),
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
            if recording_mode() == Some(DictationMode::HandsFree) {
                stop();
            } else {
                start_held(DictationMode::PushToTalk);
            }
        }
        E::PttUp => stop_if(DictationMode::PushToTalk),
        E::CommandDown => begin_or_convert(DictationMode::Command),
        E::CommandUp => stop_if(DictationMode::Command),
        E::PromptDown => begin_or_convert(DictationMode::Prompt),
        E::PromptUp => stop_if(DictationMode::Prompt),
        E::HandsFreeToggle => match recording_mode() {
            // Space added to a running push-to-talk press locks it into hands-free.
            Some(DictationMode::PushToTalk) => convert_to_hands_free(),
            Some(_) => stop(),
            None => {
                let _ = start(DictationMode::HandsFree);
            }
        },
        E::Escape => cancel(),
    }
}

/// The mode of the dictation that is recording right now.
fn recording_mode() -> Option<DictationMode> {
    let s = lock();
    matches!(s.public.phase, Phase::Recording).then_some(s.public.mode)
}

/// A key-up only ends the dictation its own chord started.
fn stop_if(mode: DictationMode) {
    if recording_mode() == Some(mode) {
        stop();
    }
}

/// Start a dictation that lives as long as its chord is held, and watch the
/// chord: a key-up Windows never delivered must not leave it recording.
fn start_held(mode: DictationMode) {
    if start(mode).is_ok() {
        let generation = lock().generation;
        spawn_hold_watchdog(generation);
    }
}

/// A longer chord (command, prompt) that grew out of a push-to-talk press takes
/// the running recording over instead of stopping it and opening the microphone
/// again: nothing said so far is lost and no second dictation races the first.
fn begin_or_convert(mode: DictationMode) {
    let converted = {
        let mut s = lock();
        if matches!(s.public.phase, Phase::Recording) && s.public.mode == DictationMode::PushToTalk {
            s.public.mode = mode;
            Some(s.generation)
        } else {
            None
        }
    };
    let Some(generation) = converted else {
        start_held(mode);
        return;
    };
    log::info!("push-to-talk press became {mode:?}");
    if mode == DictationMode::Command {
        let selection = crate::paste::copy_selection().unwrap_or_default();
        let mut s = lock();
        if s.generation == generation {
            s.selection = selection;
        }
    }
    emit_state(&state());
}

fn convert_to_hands_free() {
    let generation = {
        let mut s = lock();
        if !matches!(s.public.phase, Phase::Recording) || s.public.mode != DictationMode::PushToTalk {
            return;
        }
        s.public.mode = DictationMode::HandsFree;
        s.generation
    };
    log::info!("push-to-talk press became hands-free");
    crate::hotkey::set_hands_free_running(true);
    emit_state(&state());
    spawn_segment_loop(generation);
}

fn spawn_hold_watchdog(generation: u64) {
    std::thread::spawn(move || {
        let mut misses = 0;
        loop {
            std::thread::sleep(HOLD_WATCHDOG_TICK);
            {
                let s = lock();
                if s.generation != generation
                    || !matches!(s.public.phase, Phase::Recording)
                    || s.public.mode == DictationMode::HandsFree
                {
                    return;
                }
            }
            if crate::hotkey::hold_active() {
                misses = 0;
                continue;
            }
            misses += 1;
            if misses >= HOLD_WATCHDOG_MISSES {
                log::warn!("the hotkey is no longer held but no key-up arrived, stopping the dictation");
                stop();
                return;
            }
        }
    });
}

/// A dictation could not start (microphone busy or missing, ...). Say so on the
/// pill instead of doing nothing; a dictation that is still transcribing keeps
/// the pill and only gets the toast.
fn report_start_failure(message: &str) {
    log::error!("a dictation could not start: {message}");
    let text = format!("Could not start. {message}");
    toast("error", &text);
    if matches!(lock().public.phase, Phase::Idle | Phase::Error) {
        crate::pill::set_state(PillState::Error { message: text, retry: false });
        sound(SoundKind::Error);
        let generation = GENERATION.load(Ordering::SeqCst);
        std::thread::spawn(move || {
            std::thread::sleep(ERROR_HOLD);
            if GENERATION.load(Ordering::SeqCst) == generation && matches!(state().phase, Phase::Idle | Phase::Error) {
                crate::pill::set_state(PillState::Done);
            }
        });
    }
}

// ---------- Start ----------

/// Start a dictation. An older dictation that is still transcribing keeps going
/// in the background and still delivers its text.
pub fn start(mode: DictationMode) -> Result<(), String> {
    let result = start_inner(mode);
    if let Err(message) = &result {
        report_start_failure(message);
    }
    result
}

fn start_inner(mode: DictationMode) -> Result<(), String> {
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
        s.clear_parts();
        s.generation = generation;
    }
    set_pill_retry(None);
    log::info!("dictation {generation} started ({mode:?})");

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

/// Live transcript: every couple of seconds the last LIVE_WINDOW_SECS of audio
/// go through the STT provider and are stitched onto the text so far.
fn spawn_partial_loop(generation: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(PARTIAL_INTERVAL);
        let (wav, clipped, segments) = {
            let s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
            match s.recorder.as_ref() {
                Some(r) => {
                    let (wav, clipped) = r.snapshot_tail_wav(LIVE_WINDOW_SECS);
                    (wav, clipped, s.parts.len())
                }
                None => return,
            }
        };
        // A silent tail or a pause between thoughts must not reach the
        // transcriber: that is where the hallucinated watermarks come from.
        let wav = crate::audio::trim_silence(&wav);
        if wav.is_empty() {
            continue;
        }
        if PARTIAL_IN_FLIGHT.swap(true, Ordering::SeqCst) {
            continue; // a request is already running, skip this tick
        }
        let settings = crate::settings::current();
        let dictionary = crate::db::list_dictionary().unwrap_or_default();
        let vocabulary: Vec<String> = dictionary.iter().map(|d| d.word.clone()).collect();
        // Context only when the window reaches back to the segment start:
        // otherwise the text before the window is not what precedes the audio.
        let context = if clipped { String::new() } else { joined_text(&lock().parts) };
        let result = crate::stt::transcribe_with_context(
            &settings.providers,
            crate::stt::SttRequest {
                wav: &wav,
                language: settings.spoken_language(),
                vocabulary: &vocabulary,
                partial: true,
            },
            Some(&context),
        );
        PARTIAL_IN_FLIGHT.store(false, Ordering::SeqCst);

        let Ok(text) = result else { continue };
        let text = strip_artifacts(text.trim(), false);
        if text.is_empty() {
            continue;
        }
        let snapshot = {
            let mut s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
            // A segment was cut while the request ran: this text belongs to
            // audio that moved into it, the next tick starts fresh.
            if s.parts.len() != segments {
                continue;
            }
            let tail = if clipped { merge_live(&s.live_tail, &text) } else { text };
            s.live_tail = tail;
            let prefix = preview_text(&s.parts, &s.previews);
            s.public.live_text =
                if prefix.is_empty() { s.live_tail.clone() } else { format!("{prefix} {}", s.live_tail) };
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
/// The microphone keeps running: the recorder hands out everything up to a
/// quiet spot and keeps the rest, so no word falls into a gap between segments.
fn spawn_segment_loop(generation: u64) {
    std::thread::spawn(move || loop {
        for _ in 0..SEGMENT_SECS {
            std::thread::sleep(Duration::from_secs(1));
            let s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
        }
        // Cut and file the segment under one lock: a stop right after finds the
        // audio in `parts` and transcribes it itself, nothing is lost.
        let (wav, index) = {
            let mut s = lock();
            if s.generation != generation || !matches!(s.public.phase, Phase::Recording) {
                return;
            }
            let Some(wav) = s.recorder.as_ref().map(|r| r.take_segment()) else { return };
            s.parts.push(Part::Audio(wav.clone()));
            let index = s.parts.len() - 1;
            // Keep the live text of this segment on the pill until its real
            // transcript arrives; the live tail starts over with the new audio.
            let preview = std::mem::take(&mut s.live_tail);
            s.previews.resize(index, String::new());
            s.previews.push(preview);
            (wav, index)
        };

        let settings = crate::settings::current();
        let dictionary = crate::db::list_dictionary().unwrap_or_default();
        let vocabulary: Vec<String> = dictionary.iter().map(|d| d.word.clone()).collect();
        // The text before this segment helps the transcriber across the cut.
        let context = {
            let s = lock();
            joined_text(&s.parts[..index.min(s.parts.len())])
        };
        match transcribe_part(&wav, &settings, &vocabulary, &context) {
            Ok(text) => {
                let mut s = lock();
                if s.generation == generation && matches!(s.parts.get(index), Some(Part::Audio(_))) {
                    s.parts[index] = Part::Text(text);
                }
            }
            // The audio stays: the finish step tries it again, and a failure
            // there makes the whole dictation retryable.
            Err(e) => log::warn!("a hands-free segment could not be transcribed yet: {e}"),
        }
    });
}

/// `context` is the text spoken right before this audio (earlier segments): it
/// seeds the transcriber so names and sentences carry across a cut.
fn transcribe_wav(
    settings: &crate::model::Settings,
    vocabulary: &[String],
    wav: &[u8],
    context: &str,
) -> Result<String, String> {
    crate::stt::transcribe_with_context(
        &settings.providers,
        crate::stt::SttRequest { wav, language: settings.spoken_language(), vocabulary, partial: false },
        Some(context),
    )
}

/// Trim a part down to its audible content. `None` means it holds no speech
/// at all and must not reach the transcriber. The boolean marks parts whose
/// audio is mostly quiet: their transcripts get the watermark strip.
fn audible_part(wav: &[u8]) -> Option<(Vec<u8>, bool)> {
    let trimmed = crate::audio::trim_silence(wav);
    if trimmed.is_empty() {
        return None;
    }
    Some((trimmed, crate::audio::speech_fraction(wav) < LOW_SPEECH))
}

/// Transcribe one audio part. Silence never leaves the device, and a mostly
/// quiet part gets its transcript stripped of hallucinated watermarks.
fn transcribe_part(
    wav: &[u8],
    settings: &crate::model::Settings,
    vocabulary: &[String],
    context: &str,
) -> Result<String, String> {
    let Some((audible, suspicious)) = audible_part(wav) else {
        return Ok(String::new());
    };
    let text = transcribe_wav(settings, vocabulary, &audible, context)?;
    Ok(strip_artifacts(text.trim(), suspicious))
}

/// Transcribes every part that is still audio, in place, so a failure halfway
/// keeps the progress. Returns the full raw text once nothing is left.
fn transcribe_parts(
    parts: &mut [Part],
    settings: &crate::model::Settings,
    vocabulary: &[String],
) -> Result<String, String> {
    for index in 0..parts.len() {
        if let Part::Audio(wav) = &parts[index] {
            let context = joined_text(&parts[..index]);
            let text = transcribe_part(wav, settings, vocabulary, &context)?;
            parts[index] = Part::Text(text);
        }
    }
    Ok(joined_text(parts))
}

// ---------- Silence hallucination filter ----------

/// The token looks like a link or a bare domain. Surrounding punctuation the
/// transcriber may have glued on is ignored for the check.
fn is_urlish(token: &str) -> bool {
    let t = token.trim_matches(|c: char| c.is_ascii_punctuation());
    if t.len() < 4 {
        return false;
    }
    let lower = t.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") {
        return true;
    }
    match lower.rsplit_once('.') {
        Some((_, tld)) => {
            tld.len() >= 2
                && tld.chars().all(|c| c.is_ascii_alphabetic())
                && lower
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '/' | ':' | '?' | '=' | '&' | '%' | '+' | '#' | '@'))
        }
        None => false,
    }
}

/// Every token is link-shaped: the transcript is only a watermark.
fn is_url_only(text: &str) -> bool {
    let mut tokens = text.split_whitespace();
    tokens.next().is_some() && tokens.all(is_urlish)
}

/// The stock phrases Whisper replays on quiet audio: sign-offs, subscribe
/// pleas and subtitle credits.
fn is_known_phrase(text: &str) -> bool {
    let lower = text.to_lowercase();
    let cleaned = lower.trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace());
    const EXACT: &[&str] = &[
        "thank you for watching",
        "thanks for watching",
        "please subscribe",
        "danke fürs zuschauen",
        "danke fürs zusehen",
        "danke fürs zu sehen",
        "vielen dank fürs zuschauen",
    ];
    if EXACT.contains(&cleaned) {
        return true;
    }
    const PREFIX: &[&str] = &[
        "subtitles by",
        "subtitle by",
        "untertitel von",
        "untertitelung",
        "altyazı",
        "transcribed by",
        "transcription by",
        "captions by",
    ];
    PREFIX.iter().any(|p| cleaned.starts_with(p))
}

/// Strip what silence made the transcriber invent. A transcript that IS a
/// watermark (only a link or a stock phrase) is always dropped. The
/// trailing-link strip only runs on mostly quiet parts, so a dictated link
/// inside real speech survives.
fn strip_artifacts(text: &str, suspicious: bool) -> String {
    let t = text.trim();
    if t.is_empty() || is_known_phrase(t) || is_url_only(t) {
        return String::new();
    }
    if !suspicious {
        return t.to_string();
    }
    // Drop the trailing run of link tokens, the usual shape of a watermark a
    // quiet tail produces.
    let tokens: Vec<&str> = t.split_whitespace().collect();
    let mut end = tokens.len();
    while end > 0 && is_urlish(tokens[end - 1]) {
        end -= 1;
    }
    tokens[..end].join(" ").trim().to_string()
}

// ---------- Cancel ----------

/// Throw away the dictation the pill shows (recording or still processing).
/// Older dictations finishing in the background are not affected.
pub fn cancel() {
    let recorder = {
        let mut s = lock();
        if matches!(s.public.phase, Phase::Idle) {
            return;
        }
        mark_cancelled(s.generation);
        s.public = DictationState::default();
        s.clear_parts();
        s.selection.clear();
        s.recorder.take()
    };
    log::info!("dictation cancelled");
    if let Some(r) = recorder {
        let _ = r.stop();
    }
    crate::hotkey::set_active(false);
    crate::pill::set_state(PillState::Done);
    emit_state(&state());
}

fn fail(message: &str, generation: u64) {
    show_error(message, None, generation);
}

/// The transcription failed but the recording is kept: the pill offers a retry.
fn fail_retryable(message: &str, id: &str, generation: u64) {
    show_error(message, Some(id.to_string()), generation);
}

fn set_pill_retry(id: Option<String>) {
    if let Ok(mut guard) = PILL_RETRY.lock() {
        *guard = id;
    }
}

fn show_error(message: &str, retry_id: Option<String>, generation: u64) {
    let retry = retry_id.is_some();
    log::error!("dictation {generation} failed: {message}");
    if !is_current(generation) {
        // A newer dictation owns the pill now; the failure still gets said.
        toast(
            "error",
            &if retry { format!("{message} The recording was kept, retry it from Home.") } else { message.to_string() },
        );
        return;
    }
    set_phase(Phase::Error, message);
    set_pill_retry(retry_id);
    let pill_message = if retry { format!("Click to retry. {message}") } else { message.to_string() };
    crate::pill::set_state(PillState::Error { message: pill_message, retry });
    toast(
        "error",
        &if retry { format!("{message} The recording was kept, retry it from Home.") } else { message.to_string() },
    );
    sound(SoundKind::Error);
    // Only hides the pill when nothing new started in the meantime.
    let shown = GENERATION.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        std::thread::sleep(if retry { RETRY_HOLD } else { ERROR_HOLD });
        if GENERATION.load(Ordering::SeqCst) == shown {
            set_pill_retry(None);
            crate::pill::set_state(PillState::Done);
        }
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
    // Everything that belongs to this dictation is taken out under one lock: a
    // new dictation may start right after and overwrites the shared state.
    let job = {
        let mut s = lock();
        if !matches!(s.public.phase, Phase::Recording) {
            return;
        }
        match s.recorder.take() {
            Some(recorder) => Some(Job {
                recorder,
                mode: s.public.mode,
                generation: s.generation,
                target_hwnd: s.target_hwnd,
                target_process: s.target_process.clone(),
                target_title: s.target_title.clone(),
                selection: std::mem::take(&mut s.selection),
                parts: {
                    let parts = std::mem::take(&mut s.parts);
                    s.clear_parts();
                    parts
                },
            }),
            None => {
                // Recording without a microphone must never stick: that state
                // swallowed every later hotkey until Spechy was restarted.
                log::warn!("stop found a recording without a recorder, resetting");
                s.public = DictationState::default();
                None
            }
        }
    };
    crate::hotkey::set_active(false);
    let Some(job) = job else {
        crate::pill::set_state(PillState::Done);
        emit_state(&state());
        return;
    };
    log::info!("dictation {} stopped ({:?})", job.generation, job.mode);

    sound(SoundKind::Stop);
    set_phase(Phase::Transcribing, "");
    crate::pill::set_state(PillState::Processing);

    std::thread::spawn(move || {
        let stop_instant = Instant::now();
        let generation = job.generation;
        let peak = job.recorder.peak_rms();
        let (wav, duration_ms) = job.recorder.stop();

        if is_cancelled(generation) {
            return; // cancelled while we were stopping
        }

        if peak < crate::audio::SILENCE_RMS && job.parts.is_empty() {
            log::info!("dictation {generation} was silent, nothing to transcribe");
            back_to_idle(generation);
            return;
        }

        let details = JobDetails {
            mode: job.mode,
            generation,
            target_hwnd: job.target_hwnd,
            target_process: job.target_process,
            target_title: job.target_title,
            selection: job.selection,
        };
        if let Err(message) = finish(wav, duration_ms, details, stop_instant, job.parts) {
            fail(&message, generation);
        }
    });
}

/// A stopped recording with everything needed to finish it.
struct Job {
    recorder: Recorder,
    mode: DictationMode,
    generation: u64,
    target_hwnd: isize,
    target_process: String,
    target_title: String,
    selection: String,
    parts: Vec<Part>,
}

struct JobDetails {
    mode: DictationMode,
    generation: u64,
    target_hwnd: isize,
    target_process: String,
    target_title: String,
    selection: String,
}

fn finish(
    wav: Vec<u8>,
    duration_ms: u64,
    job: JobDetails,
    stop_instant: Instant,
    mut parts: Vec<Part>,
) -> Result<(), String> {
    let settings = crate::settings::current();
    let dictionary = crate::db::list_dictionary().unwrap_or_default();
    let vocabulary: Vec<String> = dictionary.iter().map(|d| d.word.clone()).collect();

    // Keep the last recording on disk for debugging mic problems (overwritten every time).
    #[cfg(debug_assertions)]
    let _ = std::fs::write(crate::settings::data_dir().join("last-recording.wav"), &wav);

    let JobDetails { mode, generation, target_hwnd, target_process, target_title, selection } = job;

    // 1) Transcribe the last (or only) chunk plus any segment that failed earlier.
    if wav.len() > 1024 {
        parts.push(Part::Audio(wav));
    }
    let raw = match transcribe_parts(&mut parts, &settings, &vocabulary) {
        Ok(raw) => raw,
        Err(error) => {
            if is_cancelled(generation) {
                return Ok(()); // cancelled: the user threw it away on purpose
            }
            let pending = Pending {
                info: FailedDictation {
                    id: new_id(),
                    created_at: now_ms(),
                    mode,
                    app_name: target_process,
                    app_title: target_title,
                    duration_ms: duration_ms as i64,
                    error: error.clone(),
                },
                target_hwnd,
                selection,
                parts,
            };
            if let Err(e) = crate::failed::save(&pending) {
                log::error!("the failed recording could not be kept: {e}");
                return Err(error);
            }
            fail_retryable(&error, &pending.info.id, generation);
            return Ok(());
        }
    };

    let delivery = Delivery {
        mode,
        target: Some(target_hwnd),
        app_name: target_process,
        app_title: target_title,
        selection,
        duration_ms: duration_ms as i64,
        started: stop_instant,
        generation,
    };
    deliver(&raw, &settings, delivery)
}

/// Where and how a transcript ends up once it exists.
struct Delivery {
    mode: DictationMode,
    /// Window to paste into; `None` leaves the text on the clipboard (retry from
    /// the main window, where pasting would land in Spechy itself).
    target: Option<isize>,
    app_name: String,
    app_title: String,
    selection: String,
    duration_ms: i64,
    /// Latency is measured from here to the pasted text.
    started: Instant,
    generation: u64,
}

/// Back to idle, unless a newer dictation owns the state by now.
fn back_to_idle(generation: u64) {
    let snapshot = {
        let mut s = lock();
        if s.generation != generation || matches!(s.public.phase, Phase::Recording) {
            return;
        }
        s.public = DictationState::default();
        s.clear_parts();
        s.selection.clear();
        s.public.clone()
    };
    crate::pill::set_state(PillState::Done);
    emit_state(&snapshot);
}

/// Polish, paste (or scratchpad or clipboard) and history for a finished transcript.
fn deliver(raw: &str, settings: &crate::model::Settings, delivery: Delivery) -> Result<(), String> {
    let raw = raw.trim().to_string();
    if is_cancelled(delivery.generation) {
        return Ok(());
    }
    if raw.is_empty() {
        back_to_idle(delivery.generation);
        return Ok(());
    }

    // 2) Polish.
    if is_current(delivery.generation) {
        set_phase(Phase::Polishing, "");
    }
    let dictionary = crate::db::list_dictionary().unwrap_or_default();
    let snippets = crate::db::list_snippets().unwrap_or_default();
    let foreground = crate::winutil::ForegroundApp {
        process_name: delivery.app_name.clone(),
        title: delivery.app_title.clone(),
        hwnd: delivery.target.unwrap_or(0),
    };
    let vibe = is_vibe_app(settings, &delivery.app_name);
    let command = delivery.mode == DictationMode::Command;

    let polished = crate::polish::polish(crate::polish::PolishContext {
        raw: &raw,
        settings,
        dictionary: &dictionary,
        snippets: &snippets,
        app: &foreground,
        vibe,
        prompt_mode: delivery.mode == DictationMode::Prompt,
        command_instruction: if command { Some(raw.as_str()) } else { None },
        selection: if command { Some(delivery.selection.as_str()) } else { None },
    });

    let (text, used_dictionary, used_snippets, dictionary_fixes, polish_failed) = match polished {
        Ok(r) => (r.text, r.used_dictionary, r.used_snippets, r.dictionary_fixes, false),
        Err(e) => {
            log::warn!("polish failed, using the raw transcript: {e}");
            toast("error", &format!("Cleanup failed, the raw text was used. {e}"));
            (raw.clone(), Vec::new(), Vec::new(), 0, true)
        }
    };

    if is_cancelled(delivery.generation) {
        return Ok(());
    }
    if text.trim().is_empty() {
        back_to_idle(delivery.generation);
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
    } else if delivery.target.is_some_and(crate::winutil::is_own_process_window) {
        // Spechy's own window (scratchpad, onboarding practice box): moving the
        // focus to the top-level window and sending Ctrl+V loses the WebView's
        // text field, so the page inserts the text itself.
        insert_into_own_window(&text)?;
    } else if let Some(target_hwnd) = delivery.target {
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
    } else {
        crate::paste::set_clipboard(&text)?;
        toast("success", "The dictation is on your clipboard.");
    }

    // 4) History.
    let latency_ms = delivery.started.elapsed().as_millis() as i64;
    let entry = HistoryEntry {
        id: new_id(),
        created_at: now_ms(),
        text: text.clone(),
        raw_text: raw,
        app_name: if to_scratchpad { "Spechy".to_string() } else { delivery.app_name },
        app_title: if to_scratchpad { "Scratchpad".to_string() } else { delivery.app_title },
        duration_ms: delivery.duration_ms,
        latency_ms,
        word_count: text.split_whitespace().count() as i64,
        flagged: false,
        mode: delivery.mode,
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
    log::info!("dictation {} delivered ({} words)", delivery.generation, entry.word_count);
    back_to_idle(delivery.generation);
    Ok(())
}

/// Hand a finished dictation to Spechy's own page, which inserts it at the
/// cursor of the text field last focused there. Without a page (window closed)
/// the text goes to the clipboard.
fn insert_into_own_window(text: &str) -> Result<(), String> {
    use tauri::Manager;
    let page = app().and_then(|app| app.get_webview_window("main"));
    match page {
        Some(window) => window
            .emit(crate::model::EV_INSERT_TEXT, serde_json::json!({ "text": text }))
            .map_err(|e| format!("The text could not reach the Spechy window: {e}")),
        None => {
            crate::paste::set_clipboard(text)?;
            toast("success", "The dictation is on your clipboard.");
            Ok(())
        }
    }
}

// ---------- Retry ----------

fn retry_from_pill() {
    let id = PILL_RETRY.lock().ok().and_then(|mut guard| guard.take());
    if let Some(id) = id {
        if let Err(e) = retry(&id, true) {
            fail(&e, lock().generation);
        }
    }
}

/// Send a kept recording through transcription again. From the pill the text is
/// pasted where the dictation was meant to go; from the main window it lands on
/// the clipboard. Returns once the work has started; the outcome arrives as
/// events, a failure keeps the recording (with the progress made) for later.
pub fn retry(id: &str, into_target: bool) -> Result<(), String> {
    let mut pending = {
        let mut s = lock();
        if !matches!(s.public.phase, Phase::Idle | Phase::Error) || s.recorder.is_some() {
            return Err("Finish the current dictation first.".into());
        }
        let pending = crate::failed::load(id)?;
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        s.generation = generation;
        s.public = DictationState {
            phase: Phase::Transcribing,
            mode: pending.info.mode,
            started_at_ms: now_ms(),
            ..DictationState::default()
        };
        s.clear_parts();
        s.selection.clear();
        pending
    };
    let generation = GENERATION.load(Ordering::SeqCst);
    set_pill_retry(None);
    crate::pill::set_state(PillState::Processing);
    emit_state(&state());

    std::thread::spawn(move || {
        let started = Instant::now();
        let settings = crate::settings::current();
        let dictionary = crate::db::list_dictionary().unwrap_or_default();
        let vocabulary: Vec<String> = dictionary.iter().map(|d| d.word.clone()).collect();

        let raw = match transcribe_parts(&mut pending.parts, &settings, &vocabulary) {
            Ok(raw) => raw,
            Err(error) => {
                if is_cancelled(generation) {
                    return;
                }
                pending.info.error = error.clone();
                if let Err(e) = crate::failed::save(&pending) {
                    log::error!("the retry progress could not be kept: {e}");
                }
                fail_retryable(&error, &pending.info.id, generation);
                return;
            }
        };
        if is_cancelled(generation) {
            return;
        }

        let id = pending.info.id.clone();
        let delivery = Delivery {
            mode: pending.info.mode,
            target: if into_target { Some(pending.target_hwnd) } else { None },
            app_name: pending.info.app_name,
            app_title: pending.info.app_title,
            selection: pending.selection,
            duration_ms: pending.info.duration_ms,
            started,
            generation,
        };
        // The text exists now; from here on the recording is no longer needed,
        // even when pasting fails (the text is then on the clipboard).
        let result = deliver(&raw, &settings, delivery);
        crate::failed::discard(&id);
        if let Err(message) = result {
            fail(&message, generation);
        }
    });
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn custom_settings(base_url: &str) -> crate::model::Settings {
        let mut settings = crate::model::Settings::default();
        settings.providers.stt_provider = "custom".into();
        settings.providers.custom_stt_base_url = base_url.into();
        settings.providers.custom_stt_model = "whisper-1".into();
        settings
    }

    /// Answers every request with one transcript, like an OpenAI-compatible server.
    fn fake_server(transcript: &'static str, requests: usize) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(requests) {
                let mut stream = stream.unwrap();
                let mut buffer = [0u8; 65536];
                let mut request = Vec::new();
                // Read until the multipart body is complete (it ends with the closing boundary).
                loop {
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    request.extend_from_slice(&buffer[..n]);
                    if n == 0 || request.ends_with(b"--\r\n") {
                        break;
                    }
                }
                let body = format!("{{\"text\":\"{transcript}\"}}");
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        format!("http://{address}/v1")
    }

    /// Half a second of loud audio: a part the transcriber is meant to see.
    fn loud_wav() -> Vec<u8> {
        crate::audio::encode_wav(&vec![16_000; 8000])
    }

    #[test]
    fn a_failed_transcription_keeps_every_part_for_the_retry() {
        // Nothing listens on the discard port, the request fails at once.
        let settings = custom_settings("http://127.0.0.1:9/v1");
        let mut parts = vec![Part::Text("first minute".into()), Part::Audio(loud_wav())];
        let before = parts.clone();
        assert!(transcribe_parts(&mut parts, &settings, &[]).is_err());
        assert_eq!(parts, before);
    }

    #[test]
    fn a_silent_part_never_reaches_the_server() {
        // Port 9 refuses everything; a silent part must not even be sent.
        let settings = custom_settings("http://127.0.0.1:9/v1");
        let silent = crate::audio::encode_wav(&vec![0; 16000]);
        let mut parts = vec![Part::Text("real".into()), Part::Audio(silent)];
        let raw = transcribe_parts(&mut parts, &settings, &[]).unwrap();
        assert_eq!(raw, "real");
    }

    #[test]
    fn a_watermark_transcript_is_dropped() {
        // The classics a quiet recording invents: bare links and stock phrases.
        assert_eq!(strip_artifacts("www.turkcealtyazi.org", false), "");
        assert_eq!(strip_artifacts("www.feyyaz.tv", false), "");
        assert_eq!(strip_artifacts("https://www.subtitle.site/video", false), "");
        assert_eq!(strip_artifacts("Thank you for watching!", false), "");
        assert_eq!(strip_artifacts("Subtitles by OpenSubtitles", false), "");
    }

    #[test]
    fn real_speech_keeps_its_links() {
        // Not suspicious: nothing is touched, a dictated link survives.
        assert_eq!(
            strip_artifacts("schau dir github.com an", false),
            "schau dir github.com an"
        );
        // Suspicious audio: the link stays too when it is not trailing.
        assert_eq!(
            strip_artifacts("schau dir github.com an", true),
            "schau dir github.com an"
        );
        // Suspicious audio: only the trailing watermark goes.
        assert_eq!(strip_artifacts("echter text www.junk.com", true), "echter text");
        assert_eq!(strip_artifacts("echter text", true), "echter text");
    }

    #[test]
    fn a_retry_joins_the_kept_text_and_the_new_transcripts_in_order() {
        let settings = custom_settings(&fake_server("second part", 2));
        let mut parts = vec![Part::Audio(loud_wav()), Part::Text("middle".into()), Part::Audio(loud_wav())];
        let raw = transcribe_parts(&mut parts, &settings, &[]).unwrap();
        assert_eq!(raw, "second part middle second part");
        assert!(parts.iter().all(|part| matches!(part, Part::Text(_))));
    }

    #[test]
    fn an_older_dictation_never_resets_a_newer_one() {
        // Dictation 7 records while 6 is still finishing in the background: the
        // late steps of 6 (silent, failed, delivered) must leave 7 alone. The
        // old code reset the shared state here, dropped the new recorder or
        // left it recording with Escape and the Start-menu guard stuck.
        {
            let mut s = lock();
            s.generation = 7;
            s.public.phase = Phase::Recording;
            s.public.mode = DictationMode::Prompt;
        }
        back_to_idle(6);
        show_error("old failure", None, 6);
        let s = lock();
        assert_eq!(s.generation, 7);
        assert!(matches!(s.public.phase, Phase::Recording));
        assert_eq!(s.public.mode, DictationMode::Prompt);
    }

    #[test]
    fn live_window_is_stitched_onto_the_text_so_far() {
        // The window starts in the middle of "Anna": the clipped word is dropped
        // and the join happens where the next words already stood.
        assert_eq!(
            merge_live(
                "Hallo Anna, danke für das Update. Ich schicke",
                "nna, danke für das Update. Ich schicke dir morgen die Dateien."
            ),
            "Hallo Anna, danke für das Update. Ich schicke dir morgen die Dateien."
        );
        // Punctuation and case differences do not stop the match.
        assert_eq!(merge_live("one two three four five", "wo Three, four five six"), "one two Three, four five six");
        // No overlap at all: an ellipsis marks the gap, nothing is invented.
        assert_eq!(merge_live("erster Satz", "xyz ganz anders hier"), "erster Satz \u{2026} ganz anders hier");
        // Nothing before yet, or nothing usable in the window.
        assert_eq!(merge_live("", "frischer Text"), "frischer Text");
        assert_eq!(merge_live("bisher", "nur"), "bisher");
        // A repeated phrase joins at its latest occurrence.
        assert_eq!(merge_live("a b c x a b c", "q a b c d"), "a b c x a b c d");
    }

    #[test]
    fn preview_text_shows_segments_still_in_flight() {
        let parts = vec![Part::Text("erste Minute".into()), Part::Audio(Vec::new()), Part::Audio(Vec::new())];
        let previews = vec![String::new(), "zweite Minute live".into()];
        assert_eq!(preview_text(&parts, &previews), "erste Minute zweite Minute live");
        assert_eq!(preview_text(&[], &[]), "");
    }

    #[test]
    fn escape_cancels_only_the_dictation_it_was_meant_for() {
        mark_cancelled(1001);
        assert!(is_cancelled(1001));
        assert!(!is_cancelled(1002), "a newer dictation is not cancelled by an older Escape");
        for g in 2000..2100 {
            mark_cancelled(g);
        }
        assert!(is_cancelled(2099));
    }

    #[test]
    fn hands_free_context_reaches_the_transcriber() {
        // The text of the earlier segment travels with the next request.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (seen_tx, seen_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Some(Ok(mut stream)) = listener.incoming().next() {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut buffer = [0u8; 65536];
                let mut request = Vec::new();
                loop {
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    request.extend_from_slice(&buffer[..n]);
                    if n == 0 || request.ends_with(b"--\r\n") {
                        break;
                    }
                }
                let _ = seen_tx.send(String::from_utf8_lossy(&request).to_string());
                let body = "{\"text\":\"zweiter Teil\"}";
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        let settings = custom_settings(&format!("http://{address}/v1"));
        let mut parts = vec![Part::Text("Der Kunde heisst Giovanni.".into()), Part::Audio(loud_wav())];
        let raw = transcribe_parts(&mut parts, &settings, &[]).unwrap();
        assert_eq!(raw, "Der Kunde heisst Giovanni. zweiter Teil");
        let request = seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.contains("Giovanni"), "the earlier text was not sent as prompt context");
    }
}
