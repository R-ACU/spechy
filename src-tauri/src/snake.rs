//! Voice Snake (Games tab): offline voice commands through Vosk (`vosk.rs`).
//!
//! A session plays in one language, English or German. It downloads the engine and that
//! language's small model on first use, opens the microphone and feeds it to one
//! recognizer with a closed grammar: only the direction words of that language plus
//! "[unk]", so other speech and noise are rejected instead of being forced into a
//! direction, and free text can never show up. A command fires as soon as the partial
//! result confirms it, so "down down down up up up" steers as fast as it is said. Every
//! result becomes a `snake-input` event.
//!
//! Exactly one session lives at a time: a new start cancels the old one and waits for
//! it before touching the microphone, and leaving the game (`snake_stop`), destroying
//! the window and quitting (`stop_all`) cancel it. A session stops its microphone and
//! frees its recognizer before it sends `closed`.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::vosk;

pub const EVENT: &str = "snake-input";

/// The four commands the game understands.
const COMMANDS: [&str; 4] = ["up", "down", "left", "right"];
/// Audio handed to the recognizer at once: 50 ms.
const BLOCK_MS: u32 = 50;
/// A command word at the end of a partial result fires once it stood this long (ms).
const STABLE_MS: u64 = 300;
/// Level events: one per 70 ms of audio.
const LEVEL_MS: u32 = 70;
/// Digital silence this long means the microphone delivers nothing (muted, wrong device).
const NO_SIGNAL_MS: u32 = 4000;
const MIC_OPEN_TIMEOUT: Duration = Duration::from_secs(6);

/// One spoken language: its model and its whole vocabulary. Anything else is "[unk]".
pub struct Lang {
    pub code: &'static str,
    pub culture: &'static str,
    pub model: &'static vosk::Asset,
    /// Spoken word to command.
    pub words: &'static [(&'static str, &'static str)],
    /// Words that are in the grammar only to catch other speech. The small German model
    /// matches almost anything to a command instead of "[unk]" ("hallo" became "hoch");
    /// with these decoys chatter and look-alikes land on a word that does nothing.
    pub decoys: &'static [&'static str],
}

pub static EN: Lang = Lang {
    code: "en",
    culture: "en-US",
    model: &vosk::MODEL_EN,
    words: &[("up", "up"), ("down", "down"), ("left", "left"), ("right", "right")],
    // "[unk]" already rejects other speech in English.
    decoys: &[],
};

pub static DE: Lang = Lang {
    code: "de",
    culture: "de-DE",
    model: &vosk::MODEL_DE,
    words: &[("hoch", "up"), ("oben", "up"), ("runter", "down"), ("unten", "down"), ("links", "left"), ("rechts", "right")],
    decoys: &[
        // Everyday words and fillers.
        "ja", "nein", "und", "der", "die", "das", "ist", "ich", "du", "wir", "es", "nicht", "mit", "so",
        "jetzt", "gut", "mal", "warte", "stopp", "weiter", "schnell", "langsam", "mist", "oh", "ach", "okay",
        "spiel", "schlange", "essen", "wand", "fenster", "morgen", "haus",
    ],
};

impl Lang {
    /// "de", "de-DE", "DE" give German, everything else English.
    fn pick(code: &str) -> &'static Lang {
        if code.trim().get(..2).is_some_and(|c| c.eq_ignore_ascii_case("de")) { &DE } else { &EN }
    }

    /// The command and the static spelling of a recognized word.
    fn lookup(&self, word: &str) -> Option<(&'static str, &'static str)> {
        self.words.iter().find(|(w, _)| *w == word).map(|(w, c)| (*c, *w))
    }
}

// ------------------------------------------------------------------ events

/// One event for the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SnakeEvent {
    /// Listening; `cultures` is ["en-US"] or ["de-DE"]. `feed` is always false: there is no
    /// free text.
    Ready { cultures: Vec<String>, feed: bool },
    /// Microphone level 0..100.
    Level { value: u8 },
    /// The spoken word the recognizer is about to confirm, for a dimmed preview; empty
    /// clears it.
    Partial { text: String },
    /// A command to apply. `word` is the spoken word, e.g. "links" for left.
    Heard { command: String, confidence: f32, word: String },
    /// Speech that matched no command.
    Rejected,
    /// Hint about the signal: NoSignal.
    Signal { problem: String },
    /// First-use download. `stage` is "download" or "unpack", `progress` 0..1 over all
    /// files, `mb` the size of the whole download.
    Download { stage: String, progress: f32, label: String, mb: u32 },
    /// Fatal: download-failed, unsupported-platform, engine-failed, no-mic, mic-busy.
    /// `closed` follows.
    Error { code: String, detail: String },
    /// The session ended.
    Closed,
}

#[derive(Serialize, Clone)]
struct Message<'a> {
    session: &'a str,
    #[serde(flatten)]
    event: &'a SnakeEvent,
}

type Emit = Arc<dyn Fn(SnakeEvent) + Send + Sync>;

// ------------------------------------------------------------------ recognizer output

/// Words of a Vosk result or partial result, with confidences when Vosk sends them.
#[derive(Debug, Default, PartialEq)]
struct Parsed {
    words: Vec<(String, f32)>,
    text: String,
}

fn parse(json: &str) -> Parsed {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return Parsed::default() };
    let text = value.get("text").or_else(|| value.get("partial")).and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
    let list = value.get("result").or_else(|| value.get("partial_result")).and_then(|r| r.as_array());
    let words = match list {
        Some(list) => list
            .iter()
            .filter_map(|w| {
                let word = w.get("word")?.as_str()?.to_string();
                let conf = w.get("conf").and_then(|c| c.as_f64()).unwrap_or(1.0) as f32;
                Some((word, conf))
            })
            .collect(),
        None => text.split_whitespace().map(|w| (w.to_string(), 1.0)).collect(),
    };
    Parsed { words, text }
}

#[derive(Debug, Clone, PartialEq)]
struct Hit {
    command: &'static str,
    word: &'static str,
    confidence: f32,
}

fn hits(lang: &Lang, parsed: &Parsed) -> Vec<Hit> {
    parsed
        .words
        .iter()
        .filter_map(|(word, conf)| lang.lookup(word).map(|(command, word)| Hit { command, word, confidence: *conf }))
        .collect()
}

/// Command words of the running utterance. Partial results grow and are sometimes
/// revised (a short "let" flickers as "left" before it turns into "[unk]"). A command
/// fires once per position: as soon as another word follows it, or when it has stood
/// unchanged for `STABLE_MS`. Vosk updates its partial result about every 250 ms, so a
/// word must survive at least one update. The final result adds whatever is left.
#[derive(Default)]
struct Utterance {
    fired: Vec<&'static str>,
    /// The newest, not yet fired command: position, spoken word, first seen (ms).
    pending: Option<(usize, &'static str, u64)>,
}

/// End of an utterance.
#[derive(Debug, PartialEq)]
struct Finished {
    /// Commands the partials did not fire.
    new: Vec<Hit>,
    /// Commands of the whole utterance.
    total: usize,
    /// Fired commands the final result disagrees with (diagnostics only).
    revised: usize,
}

impl Utterance {
    fn partial(&mut self, hits: Vec<Hit>, now: u64) -> Vec<Hit> {
        let done = self.fired.len();
        if hits.len() <= done {
            self.pending = None;
            return Vec::new();
        }
        let mut new: Vec<Hit> = hits.into_iter().skip(done).collect();
        let last = new.pop().expect("at least one new hit");
        let at = done + new.len();
        match self.pending {
            Some((i, word, since)) if i == at && word == last.word => {
                if now >= since + STABLE_MS {
                    new.push(last);
                    self.pending = None;
                }
            }
            _ => self.pending = Some((at, last.word, now)),
        }
        self.fired.extend(new.iter().map(|h| h.command));
        new
    }

    /// The spoken word waiting for confirmation, for the dimmed preview.
    fn pending(&self) -> Option<&'static str> {
        self.pending.map(|(_, word, _)| word)
    }

    fn finish(&mut self, hits: Vec<Hit>) -> Finished {
        let revised = self.fired.iter().zip(&hits).filter(|(a, b)| **a != b.command).count();
        let new: Vec<Hit> = hits.into_iter().skip(self.fired.len()).collect();
        let total = self.fired.len() + new.len();
        self.fired.clear();
        self.pending = None;
        Finished { new, total, revised }
    }
}

/// The grammar of a language: those of its words and decoys the model knows. Fails with
/// the commands that would be left without a word.
fn grammar(lang: &Lang, knows: impl Fn(&str) -> bool) -> Result<Vec<&'static str>, Vec<&'static str>> {
    let mut known = Vec::new();
    for (word, command) in lang.words {
        if knows(word) {
            known.push((*word, *command));
        } else {
            log::warn!("voice snake: the {} model does not know '{word}'", lang.code);
        }
    }
    let missing: Vec<&'static str> = COMMANDS.iter().copied().filter(|c| !known.iter().any(|(_, k)| k == c)).collect();
    if !missing.is_empty() {
        return Err(missing);
    }
    let decoys = lang.decoys.iter().copied().filter(|w| knows(w));
    Ok(known.into_iter().map(|(w, _)| w).chain(decoys).collect())
}

// ------------------------------------------------------------------ engine

/// The recognizer and its bookkeeping.
struct Engine {
    lang: &'static Lang,
    rec: vosk::Recognizer,
    utterance: Utterance,
    rate: u32,
    samples: u64,
    /// Word shown as pending in the frontend.
    shown: Option<&'static str>,
    revised: usize,
}

impl Engine {
    fn new(lang: &'static Lang, model: &Arc<vosk::Model>, rate: u32) -> Result<Engine, String> {
        let mut grammar = grammar(lang, |w| model.knows(w))
            .map_err(|missing| format!("The voice model has no word for {}.", missing.join(", ")))?;
        grammar.push("[unk]");
        let rec = vosk::Recognizer::new(model, rate, &grammar)?;
        Ok(Engine { lang, rec, utterance: Utterance::default(), rate, samples: 0, shown: None, revised: 0 })
    }

    /// Audio position in ms.
    fn now_ms(&self) -> u64 {
        self.samples * 1000 / self.rate.max(1) as u64
    }

    fn feed(&mut self, block: &[i16]) -> Vec<SnakeEvent> {
        self.samples += block.len() as u64;
        let ended = self.rec.accept(block);
        let json = if ended { self.rec.result() } else { self.rec.partial() };
        self.take(&json, ended)
    }

    /// Flush the pending audio, e.g. at the end of a test clip.
    #[cfg(test)]
    fn finish(&mut self) -> Vec<SnakeEvent> {
        let json = self.rec.final_result();
        self.take(&json, true)
    }

    fn take(&mut self, json: &str, ended: bool) -> Vec<SnakeEvent> {
        let parsed = parse(json);
        let (new, rejected) = if ended {
            let done = self.utterance.finish(hits(self.lang, &parsed));
            self.revised += done.revised;
            // "[unk]" alone: the player said something, just not a direction.
            (done.new, done.total == 0 && !parsed.text.is_empty())
        } else {
            let now = self.now_ms();
            (self.utterance.partial(hits(self.lang, &parsed), now), false)
        };
        let mut out = Vec::new();
        let pending = self.utterance.pending();
        if pending != self.shown {
            self.shown = pending;
            out.push(SnakeEvent::Partial { text: pending.unwrap_or("").into() });
        }
        out.extend(new.into_iter().map(|h| SnakeEvent::Heard { command: h.command.into(), confidence: h.confidence, word: h.word.into() }));
        if rejected {
            out.push(SnakeEvent::Rejected);
        }
        out
    }
}

/// Level meter and the no-signal hint. Only true digital silence counts: a quiet room
/// still has noise, and speech of course never looks like this.
struct Meter {
    window: usize,
    limit: usize,
    square_sum: f64,
    count: usize,
    silent: usize,
    warned: bool,
}

impl Meter {
    fn new(rate: u32) -> Meter {
        Meter {
            window: (rate * LEVEL_MS / 1000).max(1) as usize,
            limit: (rate as u64 * NO_SIGNAL_MS as u64 / 1000) as usize,
            square_sum: 0.0,
            count: 0,
            silent: 0,
            warned: false,
        }
    }

    fn push(&mut self, block: &[i16]) -> Vec<SnakeEvent> {
        let mut out = Vec::new();
        for &s in block {
            let v = f64::from(s) / 32768.0;
            self.square_sum += v * v;
            self.count += 1;
            if s.unsigned_abs() <= 1 {
                self.silent += 1;
            } else {
                self.silent = 0;
                self.warned = false;
            }
            if self.count >= self.window {
                let rms = (self.square_sum / self.count as f64).sqrt() as f32;
                self.square_sum = 0.0;
                self.count = 0;
                out.push(SnakeEvent::Level { value: level(rms) });
            }
        }
        if !self.warned && self.silent >= self.limit {
            self.warned = true;
            out.push(SnakeEvent::Signal { problem: "NoSignal".into() });
        }
        out
    }
}

/// Same curve as the dictation meter: raw RMS of speech is tiny, lift it with a soft knee.
fn level(rms: f32) -> u8 {
    let lifted = ((rms - 0.002).max(0.0) * 15.0).clamp(0.0, 1.0);
    (lifted.powf(0.7) * 100.0).round() as u8
}

// ------------------------------------------------------------------ microphone

/// The cpal stream is not Send, so it lives on its own thread until the Mic is dropped.
struct Mic {
    rate: u32,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

type Fail = (&'static str, String);

impl Mic {
    /// Open the chosen microphone (or the default one) and send mono 16 bit blocks to `tx`
    /// at the device's own sample rate; Vosk resamples internally.
    fn start(wanted: &str, tx: mpsc::Sender<Vec<i16>>) -> Result<Mic, Fail> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, Fail>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let wanted = wanted.to_string();
        let thread = std::thread::Builder::new()
            .name("snake-mic".into())
            .spawn(move || match open_stream(&wanted, tx) {
                Ok((stream, rate)) => {
                    use cpal::traits::StreamTrait;
                    if let Err(e) = stream.play() {
                        let _ = ready_tx.send(Err(("mic-busy", e.to_string())));
                        return;
                    }
                    let _ = ready_tx.send(Ok(rate));
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|e| ("failed", e.to_string()))?;
        // A device that never answers must not hang the session forever. On timeout the
        // stop sender is dropped with this frame, so a late stream ends right away.
        match ready_rx.recv_timeout(MIC_OPEN_TIMEOUT) {
            Ok(Ok(rate)) => Ok(Mic { rate, stop: Some(stop_tx), thread: Some(thread) }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err(("mic-busy", "The microphone did not respond.".into())),
        }
    }
}

impl Drop for Mic {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn open_stream(wanted: &str, tx: mpsc::Sender<Vec<i16>>) -> Result<(cpal::Stream, u32), Fail> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let named = (!wanted.is_empty())
        .then(|| host.input_devices().ok())
        .flatten()
        .and_then(|mut devices| devices.find(|d| d.description().ok().map(|x| x.name().to_string()).as_deref() == Some(wanted)));
    let device = named.or_else(|| host.default_input_device()).ok_or(("no-mic", String::new()))?;

    // The default format first. Asking the driver for every supported format takes
    // seconds on some laptops, so that only happens when the default fails.
    let mut first_error = None;
    if let Ok(config) = device.default_input_config() {
        match build(&device, &config, tx.clone()) {
            Ok(stream) => return Ok((stream, config.sample_rate())),
            Err(e) => first_error = Some(e),
        }
    }
    if let Ok(ranges) = device.supported_input_configs() {
        for range in ranges {
            let rate = [48_000, 44_100, 16_000].into_iter().find(|r| range.contains_rate(*r)).unwrap_or_else(|| range.max_sample_rate());
            let config = range.with_sample_rate(rate);
            match build(&device, &config, tx.clone()) {
                Ok(stream) => return Ok((stream, config.sample_rate())),
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
    }
    Err(("mic-busy", first_error.unwrap_or_else(|| "No usable microphone format.".into())))
}

fn build(device: &cpal::Device, config: &cpal::SupportedStreamConfig, tx: mpsc::Sender<Vec<i16>>) -> Result<cpal::Stream, String> {
    use cpal::SampleFormat as F;
    let c = config.config();
    match config.sample_format() {
        F::F32 => run::<f32>(device, c, tx),
        F::F64 => run::<f64>(device, c, tx),
        F::I16 => run::<i16>(device, c, tx),
        F::U16 => run::<u16>(device, c, tx),
        F::I24 => run::<cpal::I24>(device, c, tx),
        F::I32 => run::<i32>(device, c, tx),
        F::U32 => run::<u32>(device, c, tx),
        F::I8 => run::<i8>(device, c, tx),
        F::U8 => run::<u8>(device, c, tx),
        other => Err(format!("Unsupported microphone sample format: {other}")),
    }
}

fn run<T>(device: &cpal::Device, config: cpal::StreamConfig, tx: mpsc::Sender<Vec<i16>>) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    use cpal::traits::DeviceTrait;
    use cpal::FromSample;
    let channels = config.channels.max(1) as usize;
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mono: Vec<i16> = data
                    .chunks(channels)
                    .map(|frame| {
                        let sum: f32 = frame.iter().map(|s| f32::from_sample_(*s)).sum();
                        ((sum / frame.len() as f32).clamp(-1.0, 1.0) * 32767.0) as i16
                    })
                    .collect();
                let _ = tx.send(mono);
            },
            |e| log::warn!("voice snake microphone error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ session

/// Everything a session needs on disk: the native library and the model of its language.
fn assets(lang: &Lang) -> Option<[&'static vosk::Asset; 2]> {
    vosk::LIBRARY.as_ref().map(|library| [library, lang.model])
}

fn run_session(lang: &'static Lang, cancel: &AtomicBool, emit: &Emit) {
    if let Err((code, detail)) = listen(lang, cancel, emit) {
        log::warn!("voice snake: {code} {detail}");
        emit(SnakeEvent::Error { code: code.into(), detail });
    }
}

fn listen(lang: &'static Lang, cancel: &AtomicBool, emit: &Emit) -> Result<(), Fail> {
    let assets = assets(lang).ok_or(("unsupported-platform", String::new()))?;
    let installed = vosk::install(&assets, cancel, &mut |step| {
        emit(SnakeEvent::Download {
            stage: step.stage.into(),
            progress: step.progress.clamp(0.0, 1.0),
            label: step.label.into(),
            mb: (step.total as f64 / 1_000_000.0).round() as u32,
        })
    });
    match installed {
        Ok(()) => {}
        Err(vosk::InstallError::Cancelled) => return Ok(()),
        Err(vosk::InstallError::Failed(e)) => return Err(("download-failed", e)),
    }

    let api = vosk::api().map_err(|e| ("engine-failed", e))?;
    let model = vosk::Model::load(&api, &vosk::path(lang.model)).map_err(|e| ("engine-failed", e))?;
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }

    let (tx, rx) = mpsc::channel::<Vec<i16>>();
    let mic = Mic::start(&crate::settings::current().microphone, tx)?;
    let rate = mic.rate;
    let mut engine = Engine::new(lang, &model, rate).map_err(|e| ("engine-failed", e))?;
    log::info!("voice snake listening at {rate} Hz ({})", lang.code);
    emit(SnakeEvent::Ready { cultures: vec![lang.culture.into()], feed: false });

    let mut meter = Meter::new(rate);
    let block_len = (rate * BLOCK_MS / 1000).max(1) as usize;
    let mut pending: Vec<i16> = Vec::with_capacity(block_len * 2);
    let mut stalled = false;
    while !cancel.load(Ordering::Relaxed) {
        match rx.recv_timeout(Duration::from_millis(NO_SIGNAL_MS as u64)) {
            Ok(chunk) => {
                stalled = false;
                pending.extend_from_slice(&chunk);
            }
            // No callbacks at all: the device stalled or was unplugged.
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !stalled {
                    stalled = true;
                    emit(SnakeEvent::Signal { problem: "NoSignal".into() });
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if pending.len() < block_len {
            continue;
        }
        for event in meter.push(&pending).into_iter().chain(engine.feed(&pending)) {
            emit(event);
        }
        pending.clear();
    }
    drop(mic);
    if engine.revised > 0 {
        log::info!("voice snake: {} fired commands were revised by a final result", engine.revised);
    }
    Ok(())
}

struct Listener {
    session: String,
    cancel: Arc<AtomicBool>,
    thread: JoinHandle<()>,
    done: mpsc::Receiver<()>,
}

static LISTENER: Mutex<Option<Listener>> = Mutex::new(None);

fn slot() -> MutexGuard<'static, Option<Listener>> {
    LISTENER.lock().unwrap_or_else(|e| e.into_inner())
}

/// Start a session, replacing any running one. Events go to `emit` from the session
/// thread; `Closed` is always the last one.
fn start_session(session: String, lang: &'static Lang, emit: Emit) -> Result<(), String> {
    let mut guard = slot();
    let previous = guard.take();
    if let Some(old) = &previous {
        old.cancel.store(true, Ordering::Relaxed);
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let (done_tx, done) = mpsc::channel::<()>();
    let flag = Arc::clone(&cancel);
    let thread = std::thread::Builder::new()
        .name("snake-session".into())
        .spawn(move || {
            // Never two sessions on the microphone or the download at once.
            if let Some(old) = previous {
                let _ = old.thread.join();
            }
            if !flag.load(Ordering::Relaxed) {
                run_session(lang, &flag, &emit);
            }
            emit(SnakeEvent::Closed);
            drop(done_tx);
        })
        .map_err(|e| format!("failed: {e}"))?;
    *guard = Some(Listener { session, cancel, thread, done });
    Ok(())
}

/// Cancel a listener and wait up to `wait` for it to release the microphone. A session
/// stuck in a download read ends by itself within the read timeout.
fn stop(listener: Listener, wait: Duration) {
    listener.cancel.store(true, Ordering::Relaxed);
    if !wait.is_zero() && matches!(listener.done.recv_timeout(wait), Err(mpsc::RecvTimeoutError::Disconnected)) {
        let _ = listener.thread.join();
    }
}

fn stop_session(session: &str, wait: Duration) {
    let mut guard = slot();
    if guard.as_ref().is_some_and(|l| l.session == session) {
        if let Some(old) = guard.take() {
            drop(guard);
            stop(old, wait);
        }
    }
}

/// Stop whatever session runs. Called when the window is destroyed and on exit.
pub fn stop_all() {
    let old = slot().take();
    if let Some(old) = old {
        stop(old, Duration::from_secs(1));
    }
}

/// Leaving the game. Does not block the UI: the session ends within one audio block
/// (or right after the model load it is in), and the next start waits for it.
#[tauri::command]
pub fn snake_stop(session: String) {
    stop_session(&session, Duration::ZERO);
}

/// Start listening for `session` in `language` ("de" or "en"; without it, Spechy's
/// spoken language). Fails right away with "unsupported-platform" where no Vosk build
/// exists.
#[tauri::command]
pub fn snake_start(app: tauri::AppHandle, session: String, language: Option<String>) -> Result<(), String> {
    use tauri::Emitter;
    let code = language
        .filter(|l| !l.trim().is_empty())
        .or_else(|| crate::settings::current().spoken_language().map(String::from))
        .unwrap_or_default();
    let lang = Lang::pick(&code);
    if assets(lang).is_none() {
        return Err("unsupported-platform".into());
    }
    let id = session.clone();
    start_session(
        session,
        lang,
        Arc::new(move |event: SnakeEvent| {
            let _ = app.emit(EVENT, Message { session: &id, event: &event });
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits_of(commands: &[&'static str]) -> Vec<Hit> {
        commands.iter().map(|c| Hit { command: c, word: c, confidence: 1.0 }).collect()
    }

    fn names(hits: &[Hit]) -> Vec<&'static str> {
        hits.iter().map(|h| h.command).collect()
    }

    #[test]
    fn partials_fire_each_command_once() {
        let mut u = Utterance::default();
        // A new last word waits for confirmation.
        assert!(u.partial(hits_of(&["down"]), 900).is_empty());
        assert_eq!(u.pending(), Some("down"));
        assert!(u.partial(hits_of(&["down"]), 1150).is_empty());
        assert_eq!(names(&u.partial(hits_of(&["down"]), 1200)), ["down"]);
        assert!(u.partial(hits_of(&["down"]), 1250).is_empty());
        assert_eq!(u.pending(), None);
        // A word followed by another one is settled at once.
        assert_eq!(names(&u.partial(hits_of(&["down", "down", "up"]), 1400)), ["down"]);
        assert_eq!(u.pending(), Some("up"));
        // A shorter revised partial fires nothing and drops the pending word.
        assert!(u.partial(hits_of(&["down", "down"]), 1450).is_empty());
        assert_eq!(u.pending(), None);
        let done = u.finish(hits_of(&["down", "down", "up"]));
        assert_eq!(names(&done.new), ["up"]);
        assert_eq!((done.total, done.revised), (3, 0));
        // The next utterance starts from zero.
        assert!(u.partial(hits_of(&["left"]), 3000).is_empty());
        assert_eq!(names(&u.partial(hits_of(&["left"]), 3300)), ["left"]);
    }

    #[test]
    fn a_flickering_word_never_fires() {
        // "let": "left" for 250 ms, then "[unk]" (no hit), then the final says "[unk]".
        let mut u = Utterance::default();
        for t in (900..1150).step_by(50) {
            assert!(u.partial(hits_of(&["left"]), t).is_empty());
        }
        for t in (1150..1800).step_by(50) {
            assert!(u.partial(Vec::new(), t).is_empty());
        }
        assert_eq!(u.finish(Vec::new()), Finished { new: vec![], total: 0, revised: 0 });
        // "light": "left" flips to "right" at the same position; the timer starts over.
        let mut u = Utterance::default();
        assert!(u.partial(hits_of(&["left"]), 900).is_empty());
        assert!(u.partial(hits_of(&["right"]), 1150).is_empty());
        assert!(u.partial(hits_of(&["right"]), 1400).is_empty());
        assert_eq!(names(&u.partial(hits_of(&["right"]), 1450)), ["right"]);
    }

    #[test]
    fn spam_sequences_fire_everything_once() {
        for said in [&["down", "down", "down", "up", "up", "up"][..], &["left", "right", "left", "right"][..]] {
            let mut u = Utterance::default();
            let mut fired = Vec::new();
            let mut t = 0;
            for n in 1..=said.len() {
                // The partial grows every 250 ms and is read every 50 ms.
                for _ in 0..5 {
                    t += 50;
                    fired.extend(names(&u.partial(hits_of(&said[..n]), t)));
                }
            }
            let done = u.finish(hits_of(said));
            fired.extend(names(&done.new));
            assert_eq!(fired, said);
            assert_eq!((done.total, done.revised), (said.len(), 0));
        }
    }

    #[test]
    fn final_adds_what_partials_missed_and_counts_revisions() {
        let mut u = Utterance::default();
        assert!(u.partial(hits_of(&["left"]), 0).is_empty());
        assert_eq!(names(&u.partial(hits_of(&["left"]), 400)), ["left"]);
        let done = u.finish(hits_of(&["right", "right", "left"]));
        assert_eq!(names(&done.new), ["right", "left"]);
        assert_eq!((done.total, done.revised), (3, 1));
        let done = u.finish(Vec::new());
        assert_eq!(done, Finished { new: vec![], total: 0, revised: 0 });
    }

    #[test]
    fn parses_vosk_json() {
        let p = parse(r#"{"partial_result":[{"conf":1.0,"end":1.2,"start":0.9,"word":"left"},{"conf":0.6,"end":1.5,"start":1.3,"word":"[unk]"}],"partial":"left [unk]"}"#);
        assert_eq!(p.text, "left [unk]");
        assert_eq!(p.words, vec![("left".to_string(), 1.0), ("[unk]".to_string(), 0.6)]);
        assert_eq!(names(&hits(&EN, &p)), ["left"]);
        let p = parse(r#"{"partial" : "down up"}"#);
        assert_eq!(names(&hits(&EN, &p)), ["down", "up"]);
        let p = parse(r#"{"result":[{"conf":0.81,"end":2.0,"start":1.6,"word":"right"}],"text":"right"}"#);
        assert_eq!(hits(&EN, &p), vec![Hit { command: "right", word: "right", confidence: 0.81 }]);
        assert_eq!(parse(r#"{"text" : ""}"#), Parsed::default());
        assert_eq!(parse("not json"), Parsed::default());
    }

    #[test]
    fn each_language_maps_only_its_own_words() {
        for (word, command) in [("up", "up"), ("down", "down"), ("left", "left"), ("right", "right")] {
            assert_eq!(EN.lookup(word), Some((command, word)));
        }
        for (word, command) in [("hoch", "up"), ("oben", "up"), ("runter", "down"), ("unten", "down"), ("links", "left"), ("rechts", "right")] {
            assert_eq!(DE.lookup(word), Some((command, word)));
        }
        for w in ["[unk]", "let", "start", "pause", "hoch", "links", ""] {
            assert_eq!(EN.lookup(w), None);
        }
        for w in ["[unk]", "up", "left", "rechnen", "start", "los", ""] {
            assert_eq!(DE.lookup(w), None);
        }
        let p = parse(r#"{"partial" : "links [unk] hoch unten"}"#);
        let found: Vec<_> = hits(&DE, &p).iter().map(|h| (h.command, h.word)).collect();
        assert_eq!(found, [("left", "links"), ("up", "hoch"), ("down", "unten")]);
        assert!(hits(&EN, &p).is_empty());
        for lang in [&EN, &DE] {
            for c in COMMANDS {
                assert!(lang.words.iter().any(|(_, k)| *k == c), "{} has a word for {c}", lang.code);
            }
        }
    }

    #[test]
    fn language_choice() {
        for (code, want) in [("de", "de"), ("de-DE", "de"), ("DE", "de"), (" de ", "de"), ("en", "en"), ("en-GB", "en"), ("", "en"), ("auto", "en"), ("fr", "en"), ("d", "en")] {
            assert_eq!(Lang::pick(code).code, want, "{code:?}");
        }
        assert_eq!(DE.model.dir, "vosk-model-small-de-0.15");
        assert_eq!(EN.model.dir, "vosk-model-small-en-us-0.15");
    }

    #[test]
    fn grammar_drops_unknown_words_but_needs_every_direction() {
        let commands_only = |g: Vec<&'static str>| g.into_iter().filter(|w| DE.lookup(w).is_some()).collect::<Vec<_>>();
        assert_eq!(commands_only(grammar(&DE, |_| true).unwrap()), ["hoch", "oben", "runter", "unten", "links", "rechts"]);
        assert_eq!(commands_only(grammar(&DE, |w| w != "oben").unwrap()), ["hoch", "runter", "unten", "links", "rechts"]);
        // Decoys the model does not know are left out, decoys never map to a command.
        assert_eq!(grammar(&DE, |_| true).unwrap().len(), DE.words.len() + DE.decoys.len());
        assert!(!grammar(&DE, |w| w != "doch").unwrap().contains(&"doch"));
        assert!(DE.decoys.iter().all(|d| DE.lookup(d).is_none()));
        assert_eq!(grammar(&DE, |w| w != "rechts"), Err(vec!["right"]));
        assert_eq!(grammar(&EN, |_| true).unwrap(), ["up", "down", "left", "right"]);
        assert_eq!(grammar(&EN, |_| false), Err(COMMANDS.to_vec()));
    }

    #[test]
    fn german_spam_fires_with_the_spoken_words() {
        let said = ["runter", "unten", "runter", "hoch", "oben", "hoch"];
        let mut u = Utterance::default();
        let mut fired = Vec::new();
        let mut t = 0;
        let hits_de = |n: usize| -> Vec<Hit> {
            said[..n].iter().map(|w| { let (command, word) = DE.lookup(w).unwrap(); Hit { command, word, confidence: 1.0 } }).collect()
        };
        for n in 1..=said.len() {
            for _ in 0..5 {
                t += 50;
                fired.extend(u.partial(hits_de(n), t));
                if n == 1 {
                    assert_eq!(u.pending(), Some("runter").filter(|_| fired.is_empty()));
                }
            }
        }
        fired.extend(u.finish(hits_de(said.len())).new);
        assert_eq!(fired.iter().map(|h| h.word).collect::<Vec<_>>(), said);
        assert_eq!(names(&fired), ["down", "down", "down", "up", "up", "up"]);
        // "hoch" flipping to "oben" at the same position is a new pending word.
        let mut u = Utterance::default();
        let one = |w: &str| { let (command, word) = DE.lookup(w).unwrap(); vec![Hit { command, word, confidence: 1.0 }] };
        assert!(u.partial(one("hoch"), 0).is_empty());
        assert!(u.partial(one("oben"), 250).is_empty());
        assert_eq!(u.pending(), Some("oben"));
        assert_eq!(u.partial(one("oben"), 550).iter().map(|h| h.word).collect::<Vec<_>>(), ["oben"]);
    }

    #[test]
    fn meter_levels_and_no_signal() {
        let mut m = Meter::new(16_000);
        // 1 s of speech-like signal: levels, never a no-signal hint.
        let tone: Vec<i16> = (0..16_000).map(|i| ((i as f32 * 0.06).sin() * 6000.0) as i16).collect();
        let events = m.push(&tone);
        assert!(events.iter().all(|e| matches!(e, SnakeEvent::Level { value } if *value > 50)));
        assert_eq!(events.len(), 1000 / LEVEL_MS as usize);
        // Quiet room noise is not "no signal".
        let noise: Vec<i16> = (0..16_000 * 5).map(|i| if i % 7 == 0 { 6 } else { -4 }).collect();
        assert!(!m.push(&noise).iter().any(|e| matches!(e, SnakeEvent::Signal { .. })));
        // Digital zeros for 4 s are, exactly once.
        let zeros = vec![0i16; 16_000 * 6];
        let signals = m.push(&zeros).into_iter().filter(|e| matches!(e, SnakeEvent::Signal { .. })).count();
        assert_eq!(signals, 1);
        assert!(!m.push(&zeros).iter().any(|e| matches!(e, SnakeEvent::Signal { .. })));
    }

    #[test]
    fn events_serialize_for_the_frontend() {
        let json = |e: SnakeEvent| serde_json::to_value(Message { session: "s1", event: &e }).unwrap();
        assert_eq!(
            json(SnakeEvent::Heard { command: "left".into(), confidence: 0.5, word: "links".into() }),
            serde_json::json!({ "session": "s1", "kind": "heard", "command": "left", "confidence": 0.5, "word": "links" })
        );
        assert_eq!(json(SnakeEvent::Closed), serde_json::json!({ "session": "s1", "kind": "closed" }));
        assert_eq!(
            json(SnakeEvent::Ready { cultures: vec!["en-US".into()], feed: false }),
            serde_json::json!({ "session": "s1", "kind": "ready", "cultures": ["en-US"], "feed": false })
        );
        assert_eq!(
            json(SnakeEvent::Download { stage: "download".into(), progress: 0.5, label: "English voice model".into(), mb: 56 }),
            serde_json::json!({ "session": "s1", "kind": "download", "stage": "download", "progress": 0.5, "label": "English voice model", "mb": 56 })
        );
        assert_eq!(
            json(SnakeEvent::Error { code: "download-failed".into(), detail: "x".into() }),
            serde_json::json!({ "session": "s1", "kind": "error", "code": "download-failed", "detail": "x" })
        );
        assert_eq!(json(SnakeEvent::Partial { text: "left".into() }), serde_json::json!({ "session": "s1", "kind": "partial", "text": "left" }));
        assert_eq!(json(SnakeEvent::Level { value: 42 }), serde_json::json!({ "session": "s1", "kind": "level", "value": 42 }));
        assert_eq!(json(SnakeEvent::Rejected), serde_json::json!({ "session": "s1", "kind": "rejected" }));
        assert_eq!(
            json(SnakeEvent::Signal { problem: "NoSignal".into() }),
            serde_json::json!({ "session": "s1", "kind": "signal", "problem": "NoSignal" })
        );
    }

    // -------------------------------------------------------------- end to end (silent)

    /// Download (once, into the real data folder) and load the model of `lang`.
    fn model(lang: &Lang) -> Arc<vosk::Model> {
        let mut last = -1i32;
        vosk::install(&assets(lang).unwrap(), &AtomicBool::new(false), &mut |s| {
            let pct = (s.progress * 100.0) as i32;
            if pct / 20 != last / 20 {
                last = pct;
                println!("{} {} {pct} % of {} MB", s.stage, s.label, s.total / 1_000_000);
            }
        })
        .expect("install");
        let api = vosk::api().expect("library");
        let t = std::time::Instant::now();
        let model = vosk::Model::load(&api, &vosk::path(lang.model)).expect("model");
        println!("{} model loaded in {:?}", lang.code, t.elapsed());
        for word in lang.words.iter().map(|(w, _)| *w).chain(["[unk]", "<unk>", "<UNK>"]) {
            println!("  {} '{word}' in vocabulary: {}", lang.code, model.knows(word));
        }
        model
    }

    /// One TTS word or phrase per file, written into a temp folder (nothing is played).
    #[cfg(windows)]
    fn synthesize(words: &[&str], rate: u32) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("spechy-vosk-wavs-{rate}"));
        std::fs::create_dir_all(&dir).unwrap();
        let list = words.iter().map(|w| format!("'{w}'")).collect::<Vec<_>>().join(",");
        let script = format!(
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
             $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo -ArgumentList {rate}, 'Sixteen', 'Mono'; \
             foreach ($v in $s.GetInstalledVoices()) {{ $s.SelectVoice($v.VoiceInfo.Name); \
               foreach ($w in {list}) {{ \
                 $s.SetOutputToWaveFile((Join-Path '{dir}' ($v.VoiceInfo.Name.Split(' ')[1] + '_' + $w + '.wav')), $f); \
                 $s.Speak($w) }} }}; \
             $s.SetOutputToNull(); $s.Dispose()",
            dir = dir.display()
        );
        let status = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]).status().unwrap();
        assert!(status.success());
        dir
    }

    /// Voice names of the `<voice>_<word>.wav` files in `dir`.
    fn voices_in(dir: &std::path::Path) -> Vec<String> {
        let mut voices: Vec<String> = std::fs::read_dir(dir)
            .map(|d| d.flatten().filter_map(|e| e.file_name().to_string_lossy().split_once('_').map(|(a, _)| a.to_string())).collect())
            .unwrap_or_default();
        voices.sort();
        voices.dedup();
        voices
    }

    /// Samples of a WAV with the silence at both ends cut off, and its sample rate.
    fn trimmed(path: &std::path::Path) -> (Vec<i16>, u32) {
        let mut reader = hound::WavReader::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let rate = reader.spec().sample_rate;
        let s: Vec<i16> = reader.samples::<i16>().map(|x| x.unwrap()).collect();
        let loud = |x: &i16| x.unsigned_abs() > 300;
        let a = s.iter().position(loud).unwrap_or(0);
        let b = s.iter().rposition(loud).map(|i| i + 1).unwrap_or(s.len());
        (s[a..b].to_vec(), rate)
    }

    /// Quiet noise instead of digital zeros, like a real room (about -66 dB).
    fn noise(n: usize, seed: &mut u32) -> Vec<i16> {
        (0..n)
            .map(|_| {
                *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((*seed >> 16) as i16 % 33) - 16
            })
            .collect()
    }

    struct Clip {
        name: String,
        samples: Vec<i16>,
        expected: Vec<&'static str>,
        /// End of each spoken command in ms.
        ends: Vec<u64>,
    }

    /// Lead-in, words separated by `gap_ms` of room noise, tail.
    fn clip(name: String, words: &[(Vec<i16>, Option<&'static str>)], rate: u32, gap_ms: u32) -> Clip {
        let mut seed = 7;
        let ms = |n: u32| (rate * n / 1000) as usize;
        let mut samples = noise(ms(600), &mut seed);
        let (mut expected, mut ends) = (Vec::new(), Vec::new());
        for (i, (word, command)) in words.iter().enumerate() {
            if i > 0 {
                samples.extend(noise(ms(gap_ms), &mut seed));
            }
            samples.extend_from_slice(word);
            if let Some(c) = command {
                expected.push(*c);
                ends.push(samples.len() as u64 * 1000 / rate as u64);
            }
        }
        samples.extend(noise(ms(1500), &mut seed));
        Clip { name, samples, expected, ends }
    }

    /// Clips for one voice: every command word alone, every other word alone (must not
    /// fire) and three spam sequences.
    fn clips_for(
        voice: &str,
        lang: &Lang,
        word: &dyn Fn(&str) -> Vec<i16>,
        others: &[&str],
        spam: &[(&str, u32)],
        rate: u32,
    ) -> Vec<Clip> {
        let mut clips = Vec::new();
        for (w, c) in lang.words {
            clips.push(clip(format!("{voice} {w}"), &[(word(w), Some(*c))], rate, 0));
        }
        for o in others {
            let short: String = o.chars().take(24).collect();
            clips.push(clip(format!("{voice} \"{short}\" (no command)"), &[(word(o), None)], rate, 0));
        }
        for (sequence, gap) in spam {
            let words: Vec<_> = sequence.split(' ').map(|w| (word(w), lang.lookup(w).map(|(c, _)| c))).collect();
            clips.push(clip(format!("{voice} {sequence}"), &words, rate, *gap));
        }
        clips
    }

    struct Run {
        heard: Vec<(String, u64)>,
        rejected: usize,
        revised: usize,
        secs: f64,
    }

    /// Feed a clip in 50 ms blocks, exactly like the microphone loop.
    fn run_clip(lang: &'static Lang, model: &Arc<vosk::Model>, clip: &Clip, rate: u32) -> Run {
        let mut engine = Engine::new(lang, model, rate).unwrap();
        let block = (rate * BLOCK_MS / 1000) as usize;
        let mut run = Run { heard: Vec::new(), rejected: 0, revised: 0, secs: 0.0 };
        let take = |events: Vec<SnakeEvent>, at: u64, run: &mut Run| {
            for e in events {
                match e {
                    SnakeEvent::Heard { command, word, .. } => run.heard.push((format!("{command}:{word}"), at)),
                    SnakeEvent::Rejected => run.rejected += 1,
                    _ => {}
                }
            }
        };
        for chunk in clip.samples.chunks(block) {
            let t = std::time::Instant::now();
            let events = engine.feed(chunk);
            run.secs += t.elapsed().as_secs_f64();
            take(events, engine.now_ms(), &mut run);
        }
        let now = engine.now_ms();
        take(engine.finish(), now, &mut run);
        run.revised = engine.revised;
        run
    }

    struct Score {
        hit: usize,
        expected: usize,
        fired_on_other: usize,
        other: usize,
    }

    /// Run every clip, print one line per clip and a summary.
    fn evaluate(label: &str, lang: &'static Lang, model: &Arc<vosk::Model>, clips: &[Clip], rate: u32) -> Score {
        let mut score = Score { hit: 0, expected: 0, fired_on_other: 0, other: 0 };
        let (mut extra, mut secs, mut audio, mut revised, mut delays) = (0usize, 0f64, 0f64, 0usize, Vec::<i64>::new());
        println!("--- {label}");
        for clip in clips {
            let run = run_clip(lang, model, clip, rate);
            audio += clip.samples.len() as f64 / rate as f64;
            secs += run.secs;
            revised += run.revised;
            // In-order match of fired commands against the expected ones.
            let (mut j, mut matched) = (0, 0);
            for (i, want) in clip.expected.iter().enumerate() {
                while j < run.heard.len() && !run.heard[j].0.starts_with(&format!("{want}:")) {
                    j += 1;
                }
                if j < run.heard.len() {
                    delays.push(run.heard[j].1 as i64 - clip.ends[i] as i64);
                    matched += 1;
                    j += 1;
                }
            }
            score.expected += clip.expected.len();
            score.hit += matched;
            extra += run.heard.len() - matched;
            if clip.expected.is_empty() {
                score.other += 1;
                score.fired_on_other += !run.heard.is_empty() as usize;
            }
            let ok = matched == clip.expected.len() && run.heard.len() == matched;
            println!(
                "{:<5} {:<48} heard [{}] rejected {} revised {}",
                if ok { "ok" } else { "MISS" },
                clip.name,
                run.heard.iter().map(|(c, t)| format!("{c}@{t}")).collect::<Vec<_>>().join(" "),
                run.rejected,
                run.revised
            );
        }
        delays.sort();
        let mean = delays.iter().sum::<i64>() as f64 / delays.len().max(1) as f64;
        println!(
            "{label}, {rate} Hz: hits {}/{} ({:.0} %), extra fires {extra}, other speech firing {}/{}, fired then revised {revised}; \
             delay after word end: mean {mean:.0} ms, median {} ms, max {} ms; CPU {:.1} % of one core",
            score.hit,
            score.expected,
            100.0 * score.hit as f64 / score.expected.max(1) as f64,
            score.fired_on_other,
            score.other,
            delays.get(delays.len() / 2).unwrap_or(&0),
            delays.last().unwrap_or(&0),
            100.0 * secs / audio
        );
        score
    }

    const EN_OTHERS: [&str; 11] = [
        "let", "light", "write", "dawn", "app", "hello", "banana", "start", "pause",
        "Ich gehe heute Abend mit meinen Freunden in die Stadt",
        "Das Wetter ist schoen und wir trinken Kaffee",
    ];
    const EN_SPAM: [(&str, u32); 3] = [("down down down up up up", 120), ("left right left right", 120), ("down up down up", 40)];

    /// Silent end-to-end check with the real Vosk engine, English: Windows TTS words
    /// (written to files, never played) are stitched into clips with room noise. Reports
    /// hit rate, fires on other words (near misses like "let" are expected to land on a
    /// direction), the delay from the end of each word to its command (audio time) and CPU.
    /// `SNAKE_RATE` sets the sample rate (default 48000, like most microphones).
    /// `cargo test --lib snake_vosk -- --ignored --nocapture --test-threads=1`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn snake_vosk_recognizes_english_tts() {
        let rate: u32 = std::env::var("SNAKE_RATE").ok().and_then(|r| r.parse().ok()).unwrap_or(48_000);
        let model = model(&EN);
        let all: Vec<&str> = EN.words.iter().map(|(w, _)| *w).chain(EN_OTHERS).collect();
        let dir = synthesize(&all, rate);
        let mut clips = Vec::new();
        for voice in voices_in(&dir) {
            let word = |w: &str| trimmed(&dir.join(format!("{voice}_{w}.wav"))).0;
            clips.extend(clips_for(&voice, &EN, &word, &EN_OTHERS, &EN_SPAM, rate));
        }
        let score = evaluate("English", &EN, &model, &clips, rate);
        assert!(score.hit * 10 >= score.expected * 9, "hit rate below 90 %");
    }

    /// German end-to-end check. No German Windows voice exists, so the WAVs come from a
    /// folder (`SNAKE_DE_WAV_DIR`, default `%TEMP%\spechy-vosk-wavs-de`, files
    /// `<voice>_<word>.wav`, mono 16 bit, e.g. made with edge-tts from the command words
    /// only). Without that folder only the model, its vocabulary and the grammar are
    /// checked. In every case the English TTS commands run through the German grammar and
    /// must not fire.
    /// `cargo test --lib snake_vosk -- --ignored --nocapture --test-threads=1`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn snake_vosk_recognizes_german() {
        let model = model(&DE);
        assert!(DE.words.iter().all(|(w, _)| model.knows(w)), "every German command word is in the vocabulary");
        let unknown: Vec<_> = DE.decoys.iter().filter(|w| !model.knows(w)).collect();
        println!("decoys not in the vocabulary (left out): {unknown:?}");
        // The test words below are kept apart from the decoys, so the decoys are not tuned to them.
        let others = ["hallo", "banane", "lecker", "rechnen", "linsen", "hocker", "start", "pause"];
        let spam = [("runter runter runter hoch hoch hoch", 120), ("links rechts links rechts", 120), ("unten oben unten oben", 40)];
        let dir = std::env::var("SNAKE_DE_WAV_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("spechy-vosk-wavs-de"));
        let voices = voices_in(&dir);
        if voices.is_empty() {
            println!("no German WAVs in {}, only the model and grammar were checked", dir.display());
        } else {
            let rate = trimmed(&dir.join(format!("{}_hoch.wav", voices[0]))).1;
            let mut clips = Vec::new();
            for voice in &voices {
                let word = |w: &str| {
                    let (samples, r) = trimmed(&dir.join(format!("{voice}_{w}.wav")));
                    assert_eq!(r, rate, "all German WAVs need the same sample rate");
                    samples
                };
                clips.extend(clips_for(voice, &DE, &word, &others, &spam, rate));
            }
            let score = evaluate("German", &DE, &model, &clips, rate);
            assert!(score.hit * 10 >= score.expected * 9, "hit rate below 90 %");
        }

        // English commands and phrases must not steer a German game.
        let rate = 48_000;
        let all: Vec<&str> = EN.words.iter().map(|(w, _)| *w).chain(EN_OTHERS).collect();
        let en_dir = synthesize(&all, rate);
        let mut clips = Vec::new();
        for voice in voices_in(&en_dir) {
            let word = |w: &str| trimmed(&en_dir.join(format!("{voice}_{w}.wav"))).0;
            for w in &all {
                clips.push(clip(format!("{voice} \"{}\" (English)", w.chars().take(24).collect::<String>()), &[(word(w), None)], rate, 0));
            }
        }
        let score = evaluate("English speech into the German grammar", &DE, &model, &clips, rate);
        println!("English speech fired German commands in {}/{} clips", score.fired_on_other, score.other);
    }

    /// Lifecycle with the real microphone (nothing is played or stored): a session gets
    /// ready, a second start replaces it, stop ends it with `closed` and releases the mic.
    /// `cargo test --lib snake_session_lifecycle -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn snake_session_lifecycle() {
        let _ = model(&EN);
        let _ = model(&DE);
        let (tx, rx) = mpsc::channel::<(String, SnakeEvent)>();
        let emitter = |id: &str| -> Emit {
            let tx = Mutex::new(tx.clone());
            let id = id.to_string();
            Arc::new(move |e| {
                let _ = tx.lock().unwrap().send((id.clone(), e));
            })
        };
        let wait = |want: &str, session: &str| loop {
            let (id, e) = rx.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| panic!("no {want} for {session}"));
            if let SnakeEvent::Error { code, detail } = &e {
                panic!("{code}: {detail}");
            }
            if let SnakeEvent::Ready { cultures, .. } = &e {
                println!("{id} ready in {cultures:?}");
            }
            let kind = serde_json::to_value(&e).unwrap()["kind"].as_str().unwrap().to_string();
            if id == session && kind == want {
                break;
            }
        };
        let t = std::time::Instant::now();
        start_session("a".into(), &EN, emitter("a")).unwrap();
        wait("ready", "a");
        println!("ready after {:?}", t.elapsed());
        start_session("b".into(), &DE, emitter("b")).unwrap();
        wait("closed", "a");
        wait("ready", "b");
        snake_stop("a".into());
        assert!(slot().as_ref().is_some_and(|l| l.session == "b"), "stopping an old session must not touch the current one");
        let t = std::time::Instant::now();
        stop_all();
        println!("stop_all took {:?}", t.elapsed());
        wait("closed", "b");
        assert!(slot().is_none());
    }
}
