//! Global hotkey chords via a WH_KEYBOARD_LL hook on its own message-loop thread.
//!
//! Layout:
//! - `Engine` is the whole decision logic as a plain state machine: it gets one
//!   key event at a time and answers with a `Decision` (swallow the key, send the
//!   Start-menu mask, messages for the worker). No Win32 in there, so every
//!   critical key sequence is covered by unit tests at the bottom of this file.
//! - The hook callback only feeds the engine and hands messages to a worker
//!   thread through a channel. It never waits on a lock, never logs and never
//!   calls into the pipeline, so Windows cannot drop the hook for being slow.
//! - The engine tracks which keys are physically held from the hook's own
//!   events. Spechy's own injected input (paste, copy, the mask key) is tagged
//!   and ignored, so it can never end or start a chord.
//! - A timer on the hook thread reconciles the tracked keys with
//!   `GetAsyncKeyState` (a key-up can be missed on the secure desktop or while the
//!   hook was briefly gone) and re-installs the hook once per second.
//!
//! Start menu: Windows opens it when a Win press ends without another key in
//! between. Only a Win press that actually drove one of our chords gets the
//! unassigned mask key; a bare Win press is never touched, whatever state a
//! dictation is in. The Win key-up itself is never swallowed.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Mutex, OnceLock, RwLock};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyEvent {
    PttDown,
    PttUp,
    HandsFreeToggle,
    CommandDown,
    CommandUp,
    PromptDown,
    PromptUp,
    Escape,
    PasteLast,
}

#[derive(Debug, Clone, Default)]
pub struct HotkeyConfig {
    pub push_to_talk: String,
    pub hands_free: String,
    pub command: String,
    pub prompt: String,
    pub paste_last: String,
}

/// `dwExtraInfo` of every key event Spechy injects itself (paste, copy, mask key).
/// The hook recognises its own input by it and leaves the chord state alone.
pub const INJECT_TAG: usize = 0x5350_4543; // "SPEC"

// ---------------------------------------------------------------- chord parsing

/// Canonical virtual key codes. Left and right variants are folded into one code
/// so "Ctrl" means either Ctrl key and "Win" means either Windows key.
const VK_SHIFT_ANY: u16 = 0x10;
const VK_CTRL_ANY: u16 = 0x11;
const VK_ALT_ANY: u16 = 0x12;
const VK_WIN_ANY: u16 = 0x5B;
const VK_ESCAPE_KEY: u16 = 0x1B;
/// Unassigned virtual key sent while Win is held so Windows keeps the Start menu shut.
const VK_MASK: u16 = 0xE8;

fn is_modifier(vk: u16) -> bool {
    matches!(vk, VK_SHIFT_ANY | VK_CTRL_ANY | VK_ALT_ANY | VK_WIN_ANY)
}

/// Folds LCONTROL/RCONTROL/CONTROL (and the shift, alt, win variants) into one code.
fn canonical(vk: u32) -> u16 {
    match vk {
        0xA0 | 0xA1 | 0x10 => VK_SHIFT_ANY,
        0xA2 | 0xA3 | 0x11 => VK_CTRL_ANY,
        0xA4 | 0xA5 | 0x12 => VK_ALT_ANY,
        0x5B | 0x5C => VK_WIN_ANY,
        other => other as u16,
    }
}

/// "Ctrl+Win+Space" -> canonical VK codes. Used by the settings validation too.
pub fn parse_chord(chord: &str) -> Result<Vec<u16>, String> {
    let mut keys: Vec<u16> = Vec::new();
    for raw in chord.split('+') {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        let upper = part.to_uppercase();
        let vk: u16 = match upper.as_str() {
            "CTRL" | "CONTROL" | "STRG" => VK_CTRL_ANY,
            "SHIFT" | "UMSCHALT" => VK_SHIFT_ANY,
            "ALT" | "MENU" => VK_ALT_ANY,
            "WIN" | "WINDOWS" | "META" | "SUPER" | "CMD" => VK_WIN_ANY,
            "SPACE" | "LEER" => 0x20,
            "ESC" | "ESCAPE" => VK_ESCAPE_KEY,
            "TAB" => 0x09,
            "ENTER" | "RETURN" => 0x0D,
            "CAPSLOCK" => 0x14,
            "BACKSPACE" => 0x08,
            _ => {
                if let Some(number) = upper.strip_prefix('F') {
                    if let Ok(index) = number.parse::<u16>() {
                        if (1..=12).contains(&index) {
                            keys.push(0x6F + index);
                            continue;
                        }
                    }
                }
                let mut chars = upper.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) if c.is_ascii_alphanumeric() => c as u16,
                    _ => return Err(format!("Unknown key in the chord: {part}")),
                }
            }
        };
        if !keys.contains(&vk) {
            keys.push(vk);
        }
    }
    if keys.is_empty() {
        return Err("The chord is empty.".to_string());
    }
    Ok(keys)
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Chords {
    ptt: Vec<u16>,
    hands_free: Vec<u16>,
    command: Vec<u16>,
    prompt: Vec<u16>,
    paste_last: Vec<u16>,
}

impl Chords {
    fn from_config(config: &HotkeyConfig) -> Self {
        Chords {
            ptt: parse_chord(&config.push_to_talk).unwrap_or_default(),
            hands_free: parse_chord(&config.hands_free).unwrap_or_default(),
            command: parse_chord(&config.command).unwrap_or_default(),
            prompt: parse_chord(&config.prompt).unwrap_or_default(),
            paste_last: parse_chord(&config.paste_last).unwrap_or_default(),
        }
    }
}

fn config_cell() -> &'static RwLock<Chords> {
    static CHORDS: OnceLock<RwLock<Chords>> = OnceLock::new();
    CHORDS.get_or_init(|| RwLock::new(Chords::default()))
}
/// Bumped on every config change; the hook thread picks the new chords up
/// without ever blocking on the lock.
static CONFIG_VERSION: AtomicU64 = AtomicU64::new(0);

fn apply_config(config: &HotkeyConfig) {
    let parsed = Chords::from_config(config);
    if let Ok(mut guard) = config_cell().write() {
        *guard = parsed;
    }
    CONFIG_VERSION.fetch_add(1, Ordering::SeqCst);
}

pub fn update_config(config: HotkeyConfig) {
    apply_config(&config);
}

// ------------------------------------------------------------------ shared state

/// Written by the pipeline, read by the hook.
static ACTIVE: AtomicBool = AtomicBool::new(false);
static HANDS_FREE_RUNNING: AtomicBool = AtomicBool::new(false);
/// Monotonic ms until which the hotkeys stay paused (0 = not paused). The pause
/// runs out on its own, so a settings window that closes while a shortcut is
/// being recorded can never leave the hotkeys dead.
static SUSPENDED_UNTIL: AtomicU64 = AtomicU64::new(0);
const SUSPEND_MAX_MS: u64 = 120_000;
static STARTED: AtomicBool = AtomicBool::new(false);

/// Published by the hook for the worker and the pipeline.
static PTT_GENERATION: AtomicU64 = AtomicU64::new(0);
static PTT_HELD: AtomicBool = AtomicBool::new(false);
/// 0 none, 1 push-to-talk, 2 command, 3 prompt: the hold chord that is down.
static HOLD: AtomicU8 = AtomicU8::new(0);
/// Worker side: a PttDown has been handed to the callback and awaits its PttUp.
static PTT_EMITTED: AtomicBool = AtomicBool::new(false);

/// A pending press waits this long so that a longer chord (for example
/// Ctrl+Win+Shift) can still take over before push-to-talk starts.
const PTT_GRACE_MS: u64 = 90;
/// The reconcile only trusts GetAsyncKeyState for keys whose last real event is
/// at least this old (the state lags behind the hook by a moment).
const RECONCILE_GRACE_MS: u64 = 300;
/// After Spechy injected a key-up for a key the user still holds, the system key
/// state says "up" although the finger is down. The reconcile leaves such a key
/// alone for this long; a real event of that key ends the doubt earlier.
const POLLUTION_MS: u64 = 60_000;
/// Timer period of the hook thread (reconcile), and the hook is re-installed
/// every `REINSTALL_TICKS` ticks.
const TICK_MS: u32 = 250;
const REINSTALL_TICKS: u32 = 4;

fn now_ms() -> u64 {
    static BASE: OnceLock<Instant> = OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

pub fn set_suspended(value: bool) {
    SUSPENDED_UNTIL.store(if value { now_ms() + SUSPEND_MAX_MS } else { 0 }, Ordering::SeqCst);
}

fn suspended_at(now: u64) -> bool {
    let until = SUSPENDED_UNTIL.load(Ordering::SeqCst);
    until != 0 && now < until
}

/// True while a dictation records. Only Escape looks at it: the Start-menu
/// guard deliberately does not, so a hanging dictation cannot kill the Win key.
pub fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::SeqCst);
    if !active {
        HANDS_FREE_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Told by the pipeline whenever a hands-free dictation starts or ends.
pub fn set_hands_free_running(running: bool) {
    HANDS_FREE_RUNNING.store(running, Ordering::SeqCst);
}

/// True while one of the hold chords (push-to-talk, command, prompt) is down.
/// The pipeline's watchdog ends a held dictation once this stays false.
pub fn hold_active() -> bool {
    HOLD.load(Ordering::SeqCst) != 0
}

// ------------------------------------------------------------------ engine

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Message {
    PasteLast,
    /// The push-to-talk chord while hands-free records: submit without waiting.
    PttSubmit,
    PttPending(u64),
    PttReleased,
    /// A longer chord took over a push-to-talk press: the running dictation
    /// continues in the new mode instead of being stopped and restarted.
    PttAbsorbed,
    HandsFree,
    CommandDown,
    CommandUp,
    PromptDown,
    PromptUp,
    Escape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hold {
    Ptt,
    Command,
    Prompt,
}

impl Hold {
    fn code(self) -> u8 {
        match self {
            Hold::Ptt => 1,
            Hold::Command => 2,
            Hold::Prompt => 3,
        }
    }
    fn chord(self, chords: &Chords) -> &[u16] {
        match self {
            Hold::Ptt => &chords.ptt,
            Hold::Command => &chords.command,
            Hold::Prompt => &chords.prompt,
        }
    }
    fn up_message(self) -> Message {
        match self {
            Hold::Ptt => Message::PttReleased,
            Hold::Command => Message::CommandUp,
            Hold::Prompt => Message::PromptUp,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct KeyState {
    /// Time of the last real (not self-injected) event of this key.
    last_real_ms: u64,
    /// Set when Spechy injected a key-up for this key while it is held.
    polluted_ms: Option<u64>,
}

/// What the outside world looks like for one decision.
#[derive(Debug, Clone, Copy, Default)]
struct Env {
    now_ms: u64,
    /// A dictation records (Escape cancels it).
    active: bool,
    hands_free_running: bool,
    suspended: bool,
}

#[derive(Debug, Default, PartialEq)]
struct Decision {
    /// Keep the key from the focused app.
    swallow: bool,
    /// Send the unassigned mask key (keeps the Start menu shut).
    mask: bool,
    messages: Vec<Message>,
}

#[derive(Debug, Default)]
struct Engine {
    chords: Chords,
    config_version: u64,
    /// Keys the user physically holds, by canonical code.
    down: BTreeMap<u16, KeyState>,
    hold: Option<Hold>,
    ptt_generation: u64,
    /// A longer chord or a submit used this press: push-to-talk stays off
    /// until every push-to-talk key is up again.
    suppress_ptt: bool,
    /// The push-to-talk chord submitted a hands-free dictation in this press.
    submit_latch: bool,
    hands_free_latch: bool,
    escape_latch: bool,
    paste_latch: bool,
    /// The current Win press drove one of our chords; its release gets the mask.
    win_engaged: bool,
}

impl Engine {
    #[cfg(test)]
    fn new(chords: Chords) -> Self {
        Engine { chords, ..Engine::default() }
    }

    fn held(&self, vk: u16) -> bool {
        self.down.contains_key(&vk)
    }

    fn all_held(&self, chord: &[u16]) -> bool {
        !chord.is_empty() && chord.iter().all(|vk| self.held(*vk))
    }

    fn any_held(&self, chord: &[u16]) -> bool {
        chord.iter().any(|vk| self.held(*vk))
    }

    fn any_modifier_held(&self) -> bool {
        [VK_CTRL_ANY, VK_SHIFT_ANY, VK_ALT_ANY, VK_WIN_ANY].iter().any(|vk| self.held(*vk))
    }

    /// Invalidate a push-to-talk press that is still inside its grace period.
    fn bump(&mut self) {
        self.ptt_generation += 1;
    }

    /// One of our chords engaged. With Win held, the mask goes out right away,
    /// also when the engaging key is Win itself (Ctrl, then Win): SendInput from
    /// inside the hook is processed after the event being handled, so a mask
    /// sent on the Win key-up alone lands behind that key-up and the Start menu
    /// opens anyway. Sent now, it sits between Win down and Win up. The Win
    /// press is marked as well, so its release gets a second mask.
    fn engage(&mut self, _vk: u16, decision: &mut Decision) {
        if self.held(VK_WIN_ANY) {
            self.win_engaged = true;
            decision.mask = true;
        }
    }

    /// Feed one key event. `ours` marks input Spechy injected itself.
    fn on_key(&mut self, vk: u16, is_down: bool, ours: bool, env: Env) -> Decision {
        if vk == VK_MASK {
            return Decision::default();
        }
        if ours {
            // Our own synthetic input never drives a chord. A synthetic key-up of
            // a key the user still holds leaves the system key state wrong, so
            // the reconcile must not trust it for a while.
            if let Some(state) = self.down.get_mut(&vk) {
                state.polluted_ms = if is_down { None } else { Some(env.now_ms) };
            }
            return Decision::default();
        }
        if is_down {
            self.key_down(vk, env)
        } else {
            self.key_up(vk, env)
        }
    }

    fn key_down(&mut self, vk: u16, env: Env) -> Decision {
        let repeat = self.held(vk);
        self.down.insert(vk, KeyState { last_real_ms: env.now_ms, polluted_ms: None });
        if vk == VK_WIN_ANY && !repeat {
            self.win_engaged = false;
        }
        let mut d = Decision::default();
        if env.suspended {
            return d;
        }
        let chords = self.chords.clone();

        // Paste last dictation: once per press, the main key never reaches the app.
        if chords.paste_last.contains(&vk) {
            if self.paste_latch && !is_modifier(vk) {
                d.swallow = true;
                return d;
            }
            if self.all_held(&chords.paste_last) {
                if !self.paste_latch {
                    self.paste_latch = true;
                    self.bump();
                    d.messages.push(Message::PasteLast);
                    self.engage(vk, &mut d);
                }
                d.swallow = !is_modifier(vk);
                return d;
            }
        }

        // Escape cancels a running dictation and is swallowed while one runs.
        if vk == VK_ESCAPE_KEY && (self.escape_latch || (env.active && !self.any_modifier_held())) {
            if !self.escape_latch {
                self.escape_latch = true;
                d.messages.push(Message::Escape);
            }
            d.swallow = true;
            return d;
        }

        // Hands-free. Its main key is swallowed so Win+Space cannot switch the
        // keyboard layout.
        if chords.hands_free.contains(&vk) {
            if self.hands_free_latch && !is_modifier(vk) {
                d.swallow = true;
                return d;
            }
            if self.all_held(&chords.hands_free) {
                if !self.hands_free_latch {
                    self.hands_free_latch = true;
                    self.suppress_ptt = true;
                    self.bump();
                    // This press already submitted the running hands-free
                    // dictation through the push-to-talk chord: no second toggle.
                    if !self.submit_latch {
                        if self.hold == Some(Hold::Ptt) {
                            self.hold = None;
                            d.messages.push(Message::PttAbsorbed);
                        }
                        d.messages.push(Message::HandsFree);
                    }
                    self.engage(vk, &mut d);
                }
                d.swallow = !is_modifier(vk);
                return d;
            }
        }

        // Command and prompt: held like push-to-talk, longer chords.
        for kind in [Hold::Command, Hold::Prompt] {
            let chord = kind.chord(&chords);
            if !chord.contains(&vk) {
                continue;
            }
            if self.hold == Some(kind) {
                d.swallow = !is_modifier(vk);
                return d;
            }
            if self.all_held(chord) && !self.submit_latch && !self.hands_free_latch {
                match self.hold {
                    Some(Hold::Ptt) => d.messages.push(Message::PttAbsorbed),
                    Some(other) => d.messages.push(other.up_message()),
                    None => {}
                }
                self.hold = Some(kind);
                self.suppress_ptt = true;
                self.bump();
                d.messages.push(if kind == Hold::Command { Message::CommandDown } else { Message::PromptDown });
                self.engage(vk, &mut d);
                d.swallow = !is_modifier(vk);
                return d;
            }
        }

        // Push-to-talk. Never swallowed: other apps keep seeing the modifiers.
        if chords.ptt.contains(&vk) && self.all_held(&chords.ptt) {
            if env.hands_free_running && !self.hands_free_latch && !self.submit_latch && self.hold.is_none() {
                // A running hands-free dictation ends on this chord alone, at once.
                self.submit_latch = true;
                self.suppress_ptt = true;
                self.bump();
                d.messages.push(Message::PttSubmit);
                self.engage(vk, &mut d);
                return d;
            }
            if self.hold.is_none() && !self.suppress_ptt && !self.hands_free_latch && !self.submit_latch {
                self.hold = Some(Hold::Ptt);
                d.messages.push(Message::PttPending(self.ptt_generation));
                self.engage(vk, &mut d);
                return d;
            }
            if self.hold.is_some() || self.submit_latch || self.hands_free_latch {
                // Win pressed again inside a running chord: still ours.
                self.engage(vk, &mut d);
            }
            return d;
        }

        // Any other key during a pending push-to-talk means a Windows shortcut
        // such as Ctrl+Win+D: the pending start is dropped.
        if self.hold == Some(Hold::Ptt) && !repeat {
            self.bump();
        }
        d
    }

    fn key_up(&mut self, vk: u16, env: Env) -> Decision {
        let _ = env;
        self.down.remove(&vk);
        let mut d = Decision::default();
        let chords = self.chords.clone();

        // The Win key-up always reaches Windows; it is only masked when this
        // Win press drove one of our chords.
        if vk == VK_WIN_ANY {
            d.mask = self.win_engaged;
            self.win_engaged = false;
        }

        // Releases are handled even while suspended, so nothing hangs.
        if self.paste_latch {
            if chords.paste_last.contains(&vk) && !is_modifier(vk) {
                self.paste_latch = false;
                d.swallow = true;
            } else if !self.any_held(&chords.paste_last) {
                self.paste_latch = false;
            }
        }
        if vk == VK_ESCAPE_KEY && self.escape_latch {
            self.escape_latch = false;
            d.swallow = true;
        }
        if self.hands_free_latch {
            if chords.hands_free.contains(&vk) && !is_modifier(vk) {
                self.hands_free_latch = false;
                d.swallow = true;
            } else if !self.any_held(&chords.hands_free) {
                self.hands_free_latch = false;
            }
        }
        if let Some(kind) = self.hold {
            if kind.chord(&chords).contains(&vk) {
                self.hold = None;
                if kind == Hold::Ptt {
                    self.bump();
                } else if !is_modifier(vk) {
                    d.swallow = true;
                }
                d.messages.push(kind.up_message());
            }
        }
        if !self.any_held(&chords.ptt) {
            self.suppress_ptt = false;
            self.submit_latch = false;
        }
        d
    }

    /// Compare the tracked keys with the system key state and release every key
    /// the system says is up although no key-up arrived.
    fn reconcile(&mut self, is_down: impl Fn(u16) -> bool, env: Env) -> Decision {
        let stale: Vec<u16> = self
            .down
            .iter()
            .filter(|(vk, state)| {
                let polluted = state.polluted_ms.is_some_and(|at| env.now_ms.saturating_sub(at) < POLLUTION_MS);
                !polluted && env.now_ms.saturating_sub(state.last_real_ms) >= RECONCILE_GRACE_MS && !is_down(**vk)
            })
            .map(|(vk, _)| *vk)
            .collect();
        let mut merged = Decision::default();
        for vk in stale {
            let d = self.key_up(vk, env);
            merged.messages.extend(d.messages);
        }
        // Nothing to swallow and no Win press to mask: these keys are long up.
        merged
    }

    fn publish(&self) {
        PTT_GENERATION.store(self.ptt_generation, Ordering::SeqCst);
        PTT_HELD.store(self.hold == Some(Hold::Ptt), Ordering::SeqCst);
        HOLD.store(self.hold.map(Hold::code).unwrap_or(0), Ordering::SeqCst);
    }
}

fn current_env() -> Env {
    let now = now_ms();
    Env {
        now_ms: now,
        active: ACTIVE.load(Ordering::SeqCst),
        hands_free_running: HANDS_FREE_RUNNING.load(Ordering::SeqCst),
        suspended: suspended_at(now),
    }
}

// ------------------------------------------------------------------ worker channel

static SENDER: OnceLock<Mutex<Option<mpsc::Sender<Message>>>> = OnceLock::new();

thread_local! {
    /// The hook thread's own clone of the sender: sending never takes a lock.
    static LOCAL_SENDER: std::cell::RefCell<Option<mpsc::Sender<Message>>> = const { std::cell::RefCell::new(None) };
}

fn dispatch(messages: Vec<Message>) {
    if messages.is_empty() {
        return;
    }
    LOCAL_SENDER.with(|cell| {
        let Ok(mut slot) = cell.try_borrow_mut() else { return };
        if slot.is_none() {
            // Only happens once per thread, before the first key event.
            if let Some(shared) = SENDER.get().and_then(|m| m.try_lock().ok()) {
                *slot = shared.clone();
            }
        }
        if let Some(sender) = slot.as_ref() {
            for message in messages {
                let _ = sender.send(message);
            }
        }
    });
}

// ------------------------------------------------------------------ the hook

#[cfg(windows)]
thread_local! {
    static ENGINE: std::cell::RefCell<Engine> = std::cell::RefCell::new(Engine::default());
}

/// Run `f` on the hook thread's engine with fresh chords. Returns `None` when the
/// engine is busy (a re-entrant call from our own SendInput); the event then
/// simply passes through.
#[cfg(windows)]
fn with_engine(f: impl FnOnce(&mut Engine) -> Decision) -> Option<Decision> {
    ENGINE.with(|cell| {
        let mut engine = cell.try_borrow_mut().ok()?;
        let version = CONFIG_VERSION.load(Ordering::SeqCst);
        if engine.config_version != version {
            if let Ok(chords) = config_cell().try_read() {
                engine.chords = chords.clone();
                engine.config_version = version;
            }
        }
        let decision = f(&mut engine);
        engine.publish();
        Some(decision)
    })
}

#[cfg(windows)]
unsafe extern "system" fn keyboard_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    if code >= 0 {
        let message = wparam.0 as u32;
        let is_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let is_up = message == WM_KEYUP || message == WM_SYSKEYUP;
        if is_down || is_up {
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let ours = (info.flags.0 & LLKHF_INJECTED.0) != 0 && info.dwExtraInfo == INJECT_TAG;
            let vk = canonical(info.vkCode);
            let env = current_env();
            if let Some(decision) = with_engine(|engine| engine.on_key(vk, is_down, ours, env)) {
                // The engine borrow is released here: SendInput may re-enter
                // this callback for the mask key, which then passes untouched.
                if decision.mask {
                    inject_mask_key();
                }
                dispatch(decision.messages);
                if decision.swallow {
                    return LRESULT(1);
                }
            }
        }
    }

    CallNextHookEx(None, code, wparam, lparam)
}

/// Press and release the unassigned key 0xE8 so Windows does not treat the
/// Win key release as a bare tap that opens the Start menu.
#[cfg(windows)]
fn inject_mask_key() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    let make = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(VK_MASK), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: INJECT_TAG },
        },
    };
    let inputs = [make(Default::default()), make(KEYEVENTF_KEYUP)];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(windows)]
fn system_key_down(vk: u16) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    let down = |code: i32| unsafe { (GetAsyncKeyState(code) as u16 & 0x8000) != 0 };
    match vk {
        VK_CTRL_ANY => down(0xA2) || down(0xA3),
        VK_SHIFT_ANY => down(0xA0) || down(0xA1),
        VK_ALT_ANY => down(0xA4) || down(0xA5),
        VK_WIN_ANY => down(0x5B) || down(0x5C),
        other => down(other as i32),
    }
}

// ------------------------------------------------------------------ start

#[cfg(windows)]
pub fn start(
    config: HotkeyConfig,
    on_event: impl Fn(HotkeyEvent) + Send + 'static,
) -> Result<(), String> {
    use std::thread;
    use std::time::Duration;
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, SetTimer, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WM_TIMER,
    };

    apply_config(&config);
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let (sender, receiver) = mpsc::channel::<Message>();
    let _ = SENDER.set(Mutex::new(Some(sender)));

    // Worker thread: owns the user callback. Everything slow happens here.
    thread::spawn(move || {
        for message in receiver {
            log::info!("hotkey: {message:?}");
            match message {
                Message::PasteLast => on_event(HotkeyEvent::PasteLast),
                Message::PttSubmit => on_event(HotkeyEvent::PttDown),
                Message::PttPending(generation) => {
                    thread::sleep(Duration::from_millis(PTT_GRACE_MS));
                    if PTT_GENERATION.load(Ordering::SeqCst) == generation && PTT_HELD.load(Ordering::SeqCst) {
                        PTT_EMITTED.store(true, Ordering::SeqCst);
                        on_event(HotkeyEvent::PttDown);
                    }
                }
                Message::PttReleased => {
                    if PTT_EMITTED.swap(false, Ordering::SeqCst) {
                        on_event(HotkeyEvent::PttUp);
                    }
                }
                Message::PttAbsorbed => {
                    // The dictation continues under the longer chord.
                    PTT_EMITTED.store(false, Ordering::SeqCst);
                }
                Message::HandsFree => on_event(HotkeyEvent::HandsFreeToggle),
                Message::CommandDown => on_event(HotkeyEvent::CommandDown),
                Message::CommandUp => on_event(HotkeyEvent::CommandUp),
                Message::PromptDown => on_event(HotkeyEvent::PromptDown),
                Message::PromptUp => on_event(HotkeyEvent::PromptUp),
                Message::Escape => on_event(HotkeyEvent::Escape),
            }
        }
    });

    let (ready_tx, ready_rx) = mpsc::channel();
    thread::spawn(move || unsafe {
        // Windows skips a low-level hook whose owning thread does not answer
        // inside LowLevelHooksTimeout, so this thread must always get the CPU.
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

        // Take the sender clone now so the hook callback never has to.
        LOCAL_SENDER.with(|cell| {
            if let (Ok(mut slot), Some(shared)) = (cell.try_borrow_mut(), SENDER.get()) {
                if let Ok(shared) = shared.lock() {
                    *slot = shared.clone();
                }
            }
        });

        let module = GetModuleHandleW(None).unwrap_or_default();
        let instance = HINSTANCE(module.0);

        let mut hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), instance, 0) {
            Ok(hook) => {
                let _ = ready_tx.send(Ok(()));
                hook
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error.to_string()));
                return;
            }
        };

        let _ = SetTimer(None, 1, TICK_MS, None);
        let mut ticks: u32 = 0;
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            if message.message == WM_TIMER {
                ticks = ticks.wrapping_add(1);
                // Missed key-ups (secure desktop, a hook gap) would leave a chord
                // "held" forever; the system key state settles that.
                let env = current_env();
                if let Some(decision) = with_engine(|engine| engine.reconcile(system_key_down, env)) {
                    dispatch(decision.messages);
                }
                // Windows drops a timed-out hook silently, and an Explorer restart
                // can take it down too. Re-installing heals both. Fresh hook first:
                // the other order leaves a moment with no hook at all.
                if ticks.is_multiple_of(REINSTALL_TICKS) {
                    if let Ok(fresh) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), instance, 0) {
                        let _ = UnhookWindowsHookEx(hook);
                        hook = fresh;
                    }
                }
                continue;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        let _ = UnhookWindowsHookEx(hook);
    });

    match ready_rx.recv() {
        Ok(result) => result.map_err(|error| format!("Could not start the hotkey hook: {error}")),
        Err(error) => Err(format!("Could not start the hotkey hook: {error}")),
    }
}

#[cfg(not(windows))]
pub fn start(
    config: HotkeyConfig,
    _on_event: impl Fn(HotkeyEvent) + Send + 'static,
) -> Result<(), String> {
    apply_config(&config);
    Err("Global hotkeys are only implemented on Windows.".to_string())
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    const CTRL: u16 = VK_CTRL_ANY;
    const WIN: u16 = VK_WIN_ANY;
    const SHIFT: u16 = VK_SHIFT_ANY;
    const ALT: u16 = VK_ALT_ANY;
    const SPACE: u16 = 0x20;
    const ESC: u16 = VK_ESCAPE_KEY;
    const Z: u16 = b'Z' as u16;
    const D: u16 = b'D' as u16;

    fn engine() -> Engine {
        Engine::new(Chords::from_config(&HotkeyConfig {
            push_to_talk: "Ctrl+Win".into(),
            hands_free: "Ctrl+Win+Space".into(),
            command: "Ctrl+Win+Shift".into(),
            prompt: "Ctrl+Win+Alt".into(),
            paste_last: "Shift+Alt+Z".into(),
        }))
    }

    /// Drives an engine with a clock that moves 20 ms per event.
    struct Rig {
        engine: Engine,
        env: Env,
        messages: Vec<Message>,
        masks: usize,
    }

    impl Rig {
        fn new() -> Self {
            Rig { engine: engine(), env: Env { now_ms: 1000, ..Env::default() }, messages: Vec::new(), masks: 0 }
        }
        fn event(&mut self, vk: u16, down: bool, ours: bool) -> Decision {
            self.env.now_ms += 20;
            let d = self.engine.on_key(vk, down, ours, self.env);
            self.messages.extend(d.messages.iter().copied());
            if d.mask {
                self.masks += 1;
            }
            d
        }
        fn down(&mut self, vk: u16) -> Decision {
            self.event(vk, true, false)
        }
        fn up(&mut self, vk: u16) -> Decision {
            self.event(vk, false, false)
        }
        fn take(&mut self) -> Vec<Message> {
            std::mem::take(&mut self.messages)
        }
        fn names(&mut self) -> Vec<&'static str> {
            self.take()
                .into_iter()
                .map(|m| match m {
                    Message::PasteLast => "paste",
                    Message::PttSubmit => "submit",
                    Message::PttPending(_) => "ptt",
                    Message::PttReleased => "ptt-up",
                    Message::PttAbsorbed => "absorbed",
                    Message::HandsFree => "hands-free",
                    Message::CommandDown => "command",
                    Message::CommandUp => "command-up",
                    Message::PromptDown => "prompt",
                    Message::PromptUp => "prompt-up",
                    Message::Escape => "escape",
                })
                .collect()
        }
    }

    #[test]
    fn win_alone_is_never_touched() {
        let mut rig = Rig::new();
        let down = rig.down(WIN);
        let up = rig.up(WIN);
        assert_eq!(down, Decision::default());
        assert_eq!(up, Decision::default());
        assert!(rig.take().is_empty());
    }

    #[test]
    fn win_alone_stays_free_while_a_dictation_runs_or_hangs() {
        // Hands-free recording, or a dictation stuck in any phase: the Start
        // menu must still open on a bare Win tap (the old guard hung on ACTIVE).
        let mut rig = Rig::new();
        rig.env.active = true;
        rig.env.hands_free_running = true;
        for _ in 0..3 {
            assert_eq!(rig.down(WIN), Decision::default());
            assert_eq!(rig.up(WIN), Decision::default());
        }
        assert!(rig.take().is_empty());
        assert_eq!(rig.masks, 0);
    }

    #[test]
    fn ctrl_win_hold_then_release_win_first() {
        let mut rig = Rig::new();
        rig.down(CTRL);
        let win_down = rig.down(WIN);
        assert!(!win_down.swallow);
        assert!(win_down.mask, "the mask must go out while Win is down, not only on its release");
        assert_eq!(rig.names(), vec!["ptt"]);
        assert!(rig.engine.hold == Some(Hold::Ptt));
        let win_up = rig.up(WIN);
        assert!(win_up.mask, "the Win release after Ctrl+Win must be masked");
        assert!(!win_up.swallow, "the Win key-up is never swallowed");
        assert_eq!(rig.names(), vec!["ptt-up"]);
        rig.up(CTRL);
        assert!(rig.take().is_empty());
    }

    #[test]
    fn ctrl_win_hold_then_release_ctrl_first_still_masks_win() {
        // Bug: Ctrl released first, then Win: the old guard saw no latch any
        // more and the Start menu opened, the text landed in its search box.
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        rig.up(CTRL);
        assert_eq!(rig.names(), vec!["ptt", "ptt-up"]);
        let win_up = rig.up(WIN);
        assert!(win_up.mask);
        assert!(!win_up.swallow);
    }

    #[test]
    fn win_first_then_ctrl_masks_at_once_and_on_release() {
        let mut rig = Rig::new();
        rig.down(WIN);
        let ctrl = rig.down(CTRL);
        assert!(ctrl.mask, "Win is already down, the mask can go out immediately");
        assert_eq!(rig.names(), vec!["ptt"]);
        rig.up(CTRL);
        assert!(rig.up(WIN).mask);
    }

    #[test]
    fn a_plain_win_press_after_a_chord_is_free_again() {
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        rig.up(WIN);
        rig.up(CTRL);
        rig.take();
        assert!(!rig.down(WIN).mask);
        assert!(!rig.up(WIN).mask);
        assert!(rig.take().is_empty());
    }

    #[test]
    fn autorepeat_does_not_restart_the_chord() {
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        for _ in 0..10 {
            rig.down(WIN);
        }
        assert_eq!(rig.names(), vec!["ptt"]);
    }

    #[test]
    fn our_own_injected_keys_never_end_or_start_a_chord() {
        // copy_selection and paste release the modifiers with synthetic key-ups
        // while the user still holds the chord; the old hook fired CommandUp.
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        rig.down(SHIFT);
        assert_eq!(rig.names(), vec!["ptt", "absorbed", "command"]);
        for vk in [CTRL, SHIFT, WIN] {
            let d = rig.event(vk, false, true);
            assert_eq!(d, Decision::default());
        }
        // Synthetic Ctrl+C.
        rig.event(CTRL, true, true);
        rig.event(b'C' as u16, true, true);
        rig.event(b'C' as u16, false, true);
        rig.event(CTRL, false, true);
        assert!(rig.take().is_empty());
        assert_eq!(rig.engine.hold, Some(Hold::Command));
        // The real release ends it.
        rig.up(SHIFT);
        assert_eq!(rig.names(), vec!["command-up"]);
    }

    #[test]
    fn the_mask_key_itself_is_ignored() {
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        rig.take();
        assert_eq!(rig.event(VK_MASK, true, true), Decision::default());
        assert_eq!(rig.event(VK_MASK, false, true), Decision::default());
        assert_eq!(rig.engine.hold, Some(Hold::Ptt));
    }

    #[test]
    fn hands_free_starts_and_swallows_space() {
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        let space = rig.down(SPACE);
        assert!(space.swallow, "Win+Space must not switch the keyboard layout");
        assert!(space.mask);
        assert_eq!(rig.names(), vec!["ptt", "absorbed", "hands-free"]);
        assert!(rig.down(SPACE).swallow, "autorepeat stays swallowed");
        assert!(rig.up(SPACE).swallow);
        rig.up(CTRL);
        assert!(rig.up(WIN).mask);
        assert!(rig.take().is_empty(), "releasing a hands-free chord sends nothing");
    }

    #[test]
    fn during_hands_free_win_alone_opens_the_start_menu() {
        let mut rig = Rig::new();
        rig.env.active = true;
        rig.env.hands_free_running = true;
        let down = rig.down(WIN);
        let up = rig.up(WIN);
        assert!(!down.mask && !down.swallow && !up.mask && !up.swallow);
        assert!(rig.take().is_empty());
    }

    #[test]
    fn during_hands_free_ctrl_win_submits_once() {
        let mut rig = Rig::new();
        rig.env.active = true;
        rig.env.hands_free_running = true;
        rig.down(CTRL);
        rig.down(WIN);
        assert_eq!(rig.names(), vec!["submit"]);
        // Space in the same press must not start a new hands-free dictation.
        assert!(rig.down(SPACE).swallow);
        assert!(rig.take().is_empty());
        rig.up(SPACE);
        assert!(rig.up(WIN).mask);
        rig.up(CTRL);
        assert!(rig.take().is_empty());
    }

    #[test]
    fn during_hands_free_ctrl_win_submit_masks_in_both_release_orders() {
        for ctrl_first in [true, false] {
            let mut rig = Rig::new();
            rig.env.active = true;
            rig.env.hands_free_running = true;
            rig.down(CTRL);
            rig.down(WIN);
            assert_eq!(rig.names(), vec!["submit"]);
            if ctrl_first {
                assert!(!rig.up(CTRL).mask);
                let win_up = rig.up(WIN);
                assert!(win_up.mask && !win_up.swallow, "ctrl first: Win release must be masked");
            } else {
                let win_up = rig.up(WIN);
                assert!(win_up.mask && !win_up.swallow, "win first: Win release must be masked");
                rig.up(CTRL);
            }
            assert!(rig.take().is_empty());
            // The dictation is over now; a bare Win tap opens the Start menu again.
            rig.env.active = false;
            rig.env.hands_free_running = false;
            assert_eq!(rig.down(WIN), Decision::default());
            assert_eq!(rig.up(WIN), Decision::default());
        }
    }

    #[test]
    fn injected_win_and_ctrl_events_never_touch_a_bare_win_tap() {
        // Paste and copy send tagged Ctrl/Win key-ups and the mask key; with no
        // chord held they must leave no trace, and Win alone stays free.
        let mut rig = Rig::new();
        for vk in [CTRL, WIN, SHIFT, ALT] {
            assert_eq!(rig.event(vk, true, true), Decision::default());
            assert_eq!(rig.event(vk, false, true), Decision::default());
        }
        assert!(rig.engine.down.is_empty());
        assert_eq!(rig.down(WIN), Decision::default());
        assert_eq!(rig.up(WIN), Decision::default());
        assert!(rig.take().is_empty());
        assert_eq!(rig.masks, 0);
    }

    #[test]
    fn win_alone_is_free_after_a_chord_whose_key_ups_were_missed() {
        // Ctrl+Win held, then both key-ups lost (secure desktop). The reconcile
        // clears them; the next bare Win tap must not be masked.
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        rig.take();
        let later = Env { now_ms: rig.env.now_ms + 1000, ..rig.env };
        rig.engine.reconcile(|_| false, later);
        rig.env.now_ms = later.now_ms;
        let masks_before = rig.masks;
        assert_eq!(rig.down(WIN), Decision::default());
        assert_eq!(rig.up(WIN), Decision::default());
        assert_eq!(rig.masks, masks_before);
        assert!(rig.take().is_empty());
    }

    #[test]
    fn a_hanging_pipeline_keeps_masking_only_our_chords() {
        // Dictation flags stuck on (pipeline hangs in any phase): chords still
        // mask, bare Win taps still open the Start menu, over and over.
        let mut rig = Rig::new();
        rig.env.active = true;
        rig.env.hands_free_running = false;
        for _ in 0..3 {
            rig.down(CTRL);
            rig.down(WIN);
            rig.up(CTRL);
            assert!(rig.up(WIN).mask);
            assert_eq!(rig.down(WIN), Decision::default());
            assert_eq!(rig.up(WIN), Decision::default());
        }
        assert_eq!(rig.names(), vec!["ptt", "ptt-up", "ptt", "ptt-up", "ptt", "ptt-up"]);
    }

    #[test]
    fn forge_takes_over_a_push_to_talk_press() {
        // Ctrl+Win first, Alt a moment later: the running press becomes a prompt
        // dictation instead of being stopped and restarted.
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        let alt = rig.down(ALT);
        assert!(!alt.swallow, "a modifier is never swallowed");
        assert!(alt.mask);
        assert_eq!(rig.names(), vec!["ptt", "absorbed", "prompt"]);
        assert_eq!(rig.engine.hold, Some(Hold::Prompt));
        rig.up(ALT);
        assert_eq!(rig.names(), vec!["prompt-up"]);
        assert!(rig.up(WIN).mask);
        rig.up(CTRL);
        assert!(rig.take().is_empty(), "push-to-talk stays suppressed until the chord is free");
    }

    #[test]
    fn forge_pressed_alt_first() {
        let mut rig = Rig::new();
        rig.down(ALT);
        rig.down(CTRL);
        rig.down(WIN);
        assert_eq!(rig.names(), vec!["prompt"]);
        rig.up(WIN);
        assert_eq!(rig.names(), vec!["prompt-up"]);
    }

    #[test]
    fn a_windows_shortcut_cancels_a_pending_push_to_talk() {
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        let generation = match rig.take()[..] {
            [Message::PttPending(g)] => g,
            ref other => panic!("unexpected {other:?}"),
        };
        rig.down(D);
        assert_ne!(rig.engine.ptt_generation, generation);
    }

    #[test]
    fn escape_cancels_only_while_active() {
        let mut rig = Rig::new();
        assert!(!rig.down(ESC).swallow);
        rig.up(ESC);
        rig.env.active = true;
        assert!(rig.down(ESC).swallow);
        assert!(rig.down(ESC).swallow);
        assert!(rig.up(ESC).swallow);
        assert_eq!(rig.names(), vec!["escape"]);
    }

    #[test]
    fn paste_last_fires_once_and_eats_the_letter() {
        let mut rig = Rig::new();
        rig.down(SHIFT);
        rig.down(ALT);
        assert!(rig.down(Z).swallow);
        assert!(rig.down(Z).swallow);
        assert!(rig.up(Z).swallow);
        rig.up(ALT);
        rig.up(SHIFT);
        assert_eq!(rig.names(), vec!["paste"]);
    }

    #[test]
    fn suspended_hotkeys_do_nothing_but_keep_track() {
        let mut rig = Rig::new();
        rig.env.suspended = true;
        rig.down(CTRL);
        rig.down(WIN);
        assert!(rig.take().is_empty());
        rig.env.suspended = false;
        rig.up(WIN);
        rig.up(CTRL);
        assert!(rig.take().is_empty());
        assert!(rig.engine.down.is_empty());
    }

    #[test]
    fn reconcile_releases_a_chord_whose_key_up_was_missed() {
        // For example Ctrl+Alt+Del in the middle of a push-to-talk press: the
        // key-ups happen on the secure desktop and never reach the hook.
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        rig.take();
        // Right away nothing happens: the system state may lag.
        let env = Env { now_ms: rig.env.now_ms + 50, ..rig.env };
        assert!(rig.engine.reconcile(|_| false, env).messages.is_empty());
        let later = Env { now_ms: rig.env.now_ms + 1000, ..rig.env };
        let d = rig.engine.reconcile(|_| false, later);
        assert_eq!(d.messages, vec![Message::PttReleased]);
        assert!(rig.engine.down.is_empty());
        assert!(rig.engine.hold.is_none());
    }

    #[test]
    fn reconcile_keeps_keys_that_are_really_down() {
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        rig.take();
        let later = Env { now_ms: rig.env.now_ms + 5000, ..rig.env };
        assert!(rig.engine.reconcile(|_| true, later).messages.is_empty());
        assert_eq!(rig.engine.hold, Some(Hold::Ptt));
    }

    #[test]
    fn reconcile_trusts_the_finger_over_our_own_synthetic_key_up() {
        // Command mode releases the held modifiers synthetically to copy the
        // selection; the system then says "up" while the user still holds them.
        let mut rig = Rig::new();
        rig.down(CTRL);
        rig.down(WIN);
        rig.down(SHIFT);
        rig.take();
        for vk in [CTRL, SHIFT, WIN] {
            rig.event(vk, false, true);
        }
        let later = Env { now_ms: rig.env.now_ms + 3000, ..rig.env };
        assert!(rig.engine.reconcile(|_| false, later).messages.is_empty());
        assert_eq!(rig.engine.hold, Some(Hold::Command));
        // Long after, the doubt ends and a key that is really up is released.
        let much_later = Env { now_ms: rig.env.now_ms + POLLUTION_MS + 1000, ..rig.env };
        let d = rig.engine.reconcile(|_| false, much_later);
        assert_eq!(d.messages, vec![Message::CommandUp]);
    }

    #[test]
    fn a_hanging_pipeline_never_blocks_the_next_chord() {
        // The pipeline may hang in any phase (network, microphone): the hook's
        // chord logic does not depend on it at all.
        let mut rig = Rig::new();
        rig.env.active = true;
        rig.down(CTRL);
        rig.down(WIN);
        rig.up(WIN);
        rig.up(CTRL);
        rig.down(CTRL);
        rig.down(WIN);
        assert_eq!(rig.names(), vec!["ptt", "ptt-up", "ptt"]);
    }

    #[test]
    fn suspension_runs_out_on_its_own() {
        set_suspended(true);
        let now = now_ms();
        assert!(suspended_at(now));
        assert!(!suspended_at(now + SUSPEND_MAX_MS + 1));
        set_suspended(false);
        assert!(!suspended_at(now_ms()));
    }

    #[test]
    fn parse_chord_folds_sides_and_rejects_junk() {
        assert_eq!(parse_chord("Ctrl+Win+Space").unwrap(), vec![CTRL, WIN, SPACE]);
        assert_eq!(parse_chord("Strg+Alt+F4").unwrap(), vec![CTRL, ALT, 0x73]);
        assert!(parse_chord("Ctrl+Nope").is_err());
        assert!(parse_chord("").is_err());
        assert_eq!(canonical(0xA3), CTRL);
        assert_eq!(canonical(0x5C), WIN);
    }
}
