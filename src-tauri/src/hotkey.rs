//! Global hotkey chords via a WH_KEYBOARD_LL hook on its own message-loop thread.
//!
//! The hook callback itself does almost nothing: it normalizes the key, decides
//! which chord it belongs to and pushes a message into a queue. A worker thread
//! drains that queue and calls the user callback. Windows silently removes a
//! low-level hook when the installing thread is too slow, so the hook thread runs
//! at time-critical priority and re-installs the hook once per second (that also
//! heals the hook after an Explorer restart).
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyEvent {
    PttDown,
    PttUp,
    HandsFreeToggle,
    CommandDown,
    CommandUp,
    Escape,
    PasteLast,
}

#[derive(Debug, Clone, Default)]
pub struct HotkeyConfig {
    pub push_to_talk: String,
    pub hands_free: String,
    pub command: String,
    pub paste_last: String,
}

// ---------------------------------------------------------------- chord parsing

/// Canonical virtual key codes. Left and right variants are folded into one code
/// so "Ctrl" means either Ctrl key and "Win" means either Windows key.
const VK_SHIFT_ANY: u16 = 0x10;
const VK_CTRL_ANY: u16 = 0x11;
const VK_ALT_ANY: u16 = 0x12;
const VK_WIN_ANY: u16 = 0x5B;
const VK_ESCAPE_KEY: u16 = 0x1B;

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

#[derive(Debug, Clone, Default)]
struct Chords {
    ptt: Vec<u16>,
    hands_free: Vec<u16>,
    command: Vec<u16>,
    paste_last: Vec<u16>,
}

fn chords() -> &'static std::sync::RwLock<Chords> {
    static CHORDS: OnceLock<std::sync::RwLock<Chords>> = OnceLock::new();
    CHORDS.get_or_init(|| std::sync::RwLock::new(Chords::default()))
}

fn apply_config(config: &HotkeyConfig) {
    let parsed = Chords {
        ptt: parse_chord(&config.push_to_talk).unwrap_or_default(),
        hands_free: parse_chord(&config.hands_free).unwrap_or_default(),
        command: parse_chord(&config.command).unwrap_or_default(),
        paste_last: parse_chord(&config.paste_last).unwrap_or_default(),
    };
    if let Ok(mut guard) = chords().write() {
        *guard = parsed;
    }
}

pub fn update_config(config: HotkeyConfig) {
    apply_config(&config);
}

// ------------------------------------------------------------------ shared state

static ACTIVE: AtomicBool = AtomicBool::new(false);
static STARTED: AtomicBool = AtomicBool::new(false);
static SUSPENDED: AtomicBool = AtomicBool::new(false);

pub fn set_suspended(value: bool) {
    SUSPENDED.store(value, Ordering::SeqCst);
}

/// Hook-side latches.
static PTT_HELD: AtomicBool = AtomicBool::new(false);
static CMD_HELD: AtomicBool = AtomicBool::new(false);
static HANDS_FREE_LATCH: AtomicBool = AtomicBool::new(false);
static ESCAPE_LATCH: AtomicBool = AtomicBool::new(false);
static PASTE_LAST_LATCH: AtomicBool = AtomicBool::new(false);
/// Set when a longer chord (hands-free or command) fired; blocks the shorter
/// push-to-talk chord until every one of its keys has been released.
static SUPPRESS_PTT: AtomicBool = AtomicBool::new(false);
/// Bumped whenever a pending push-to-talk press becomes invalid.
static PTT_GENERATION: AtomicU64 = AtomicU64::new(0);
/// True while a PttDown has actually been handed to the user callback.
static PTT_EMITTED: AtomicBool = AtomicBool::new(false);

/// A pending press waits this long so that a longer chord (for example
/// Ctrl+Win+Shift) can still take over before push-to-talk starts.
const PTT_GRACE_MS: u64 = 90;

#[derive(Debug, Clone, Copy)]
enum Message {
    PasteLast,
    PttPending(u64),
    PttReleased,
    HandsFree,
    CommandDown,
    CommandUp,
    Escape,
}

fn queue() -> &'static Mutex<VecDeque<Message>> {
    static QUEUE: OnceLock<Mutex<VecDeque<Message>>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

static WORKER: OnceLock<std::thread::Thread> = OnceLock::new();

fn push(message: Message) {
    if let Ok(mut guard) = queue().lock() {
        guard.push_back(message);
    }
    if let Some(worker) = WORKER.get() {
        worker.unpark();
    }
}

pub fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::SeqCst);
}

// ------------------------------------------------------------------ key state

#[cfg(windows)]
unsafe fn physically_down(vk: u16) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    let down = |code: i32| (GetAsyncKeyState(code) as u16 & 0x8000) != 0;
    match vk {
        VK_CTRL_ANY => down(0xA2) || down(0xA3),
        VK_SHIFT_ANY => down(0xA0) || down(0xA1),
        VK_ALT_ANY => down(0xA4) || down(0xA5),
        VK_WIN_ANY => down(0x5B) || down(0x5C),
        other => down(other as i32),
    }
}

#[cfg(windows)]
unsafe fn all_held(chord: &[u16], just_pressed: u16) -> bool {
    // The key that triggered this event is not visible through GetAsyncKeyState
    // yet in every case, so treat it as held.
    chord
        .iter()
        .all(|vk| *vk == just_pressed || physically_down(*vk))
}

#[cfg(windows)]
unsafe fn any_held(chord: &[u16]) -> bool {
    chord.iter().any(|vk| physically_down(*vk))
}

// ------------------------------------------------------------------ the hook

#[cfg(windows)]
unsafe extern "system" fn keyboard_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    if code >= 0 {
        let message = wparam.0 as u32;
        let is_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let is_up = message == WM_KEYUP || message == WM_SYSKEYUP;
        let info = *(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk = canonical(info.vkCode);

        if (is_down || is_up) && handle_key(vk, is_down) {
            return LRESULT(1);
        }
    }

    CallNextHookEx(None, code, wparam, lparam)
}

/// Press and release an unassigned virtual key (0xE8) so Windows does not treat the
/// following Win key release as a bare tap that opens the Start menu.
#[cfg(windows)]
unsafe fn inject_dummy_key() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    let make = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0xE8), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    };
    let inputs = [make(Default::default()), make(KEYEVENTF_KEYUP)];
    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

/// Returns true when the key press should be swallowed.
#[cfg(windows)]
unsafe fn handle_key(vk: u16, is_down: bool) -> bool {
    if SUSPENDED.load(Ordering::SeqCst) { return false; }
    let is_up = !is_down;
    let guard = match chords().read() {
        Ok(guard) => guard,
        Err(_) => return false,
    };
    let ptt = guard.ptt.clone();
    let hands_free = guard.hands_free.clone();
    let command = guard.command.clone();
    let paste_last = guard.paste_last.clone();
    drop(guard);

    // Fire once per press and consume the main key so it cannot type a stray Z.
    // The worker performs the clipboard operation outside the hook callback.
    if paste_last.contains(&vk) {
        if is_down && !is_modifier(vk) && PASTE_LAST_LATCH.load(Ordering::SeqCst) {
            return true;
        }
        if is_down && all_held(&paste_last, vk) {
            if !PASTE_LAST_LATCH.swap(true, Ordering::SeqCst) {
                PTT_GENERATION.fetch_add(1, Ordering::SeqCst);
                push(Message::PasteLast);
            }
            return true;
        }
        if is_up && PASTE_LAST_LATCH.load(Ordering::SeqCst) {
            if !is_modifier(vk) {
                PASTE_LAST_LATCH.store(false, Ordering::SeqCst);
                return true;
            }
        }
    }

    // Start-menu guard: Windows opens the Start menu when a Win key is released
    // without any other key having been pressed while it was held. If our chord
    // was engaged (Ctrl pressed before Win, then Win released first), inject a
    // harmless unassigned key while Win is still down so Windows sees "another key".
    if is_up
        && vk == VK_WIN_ANY
        && (PTT_HELD.load(Ordering::SeqCst)
            || PTT_EMITTED.load(Ordering::SeqCst)
            || CMD_HELD.load(Ordering::SeqCst)
            || HANDS_FREE_LATCH.load(Ordering::SeqCst)
            || ACTIVE.load(Ordering::SeqCst))
    {
        inject_dummy_key();
    }

    // Escape cancels a running dictation and is swallowed while one is active.
    if vk == VK_ESCAPE_KEY && ACTIVE.load(Ordering::SeqCst) {
        let modifiers_clear = !physically_down(VK_CTRL_ANY)
            && !physically_down(VK_ALT_ANY)
            && !physically_down(VK_WIN_ANY)
            && !physically_down(VK_SHIFT_ANY);
        if modifiers_clear {
            if is_down {
                if !ESCAPE_LATCH.swap(true, Ordering::SeqCst) {
                    push(Message::Escape);
                }
                return true;
            }
            ESCAPE_LATCH.store(false, Ordering::SeqCst);
            return true;
        }
    }

    // Hands-free chord. Swallowed on the way down so Windows does not switch the
    // keyboard layout on Win+Space.
    if !hands_free.is_empty() && hands_free.contains(&vk) {
        if is_down && all_held(&hands_free, vk) {
            if !HANDS_FREE_LATCH.swap(true, Ordering::SeqCst) {
                SUPPRESS_PTT.store(true, Ordering::SeqCst);
                PTT_GENERATION.fetch_add(1, Ordering::SeqCst);
                if PTT_HELD.swap(false, Ordering::SeqCst) {
                    push(Message::PttReleased);
                }
                push(Message::HandsFree);
            }
            return true;
        }
        if is_up && HANDS_FREE_LATCH.load(Ordering::SeqCst) && !is_modifier(vk) {
            HANDS_FREE_LATCH.store(false, Ordering::SeqCst);
            return true;
        }
        if is_up && !is_modifier(vk) {
            HANDS_FREE_LATCH.store(false, Ordering::SeqCst);
        }
    }

    // Command chord. Only modifiers by default, so nothing is swallowed here.
    if !command.is_empty() && command.contains(&vk) {
        if is_down && !CMD_HELD.load(Ordering::SeqCst) && all_held(&command, vk) {
            CMD_HELD.store(true, Ordering::SeqCst);
            SUPPRESS_PTT.store(true, Ordering::SeqCst);
            PTT_GENERATION.fetch_add(1, Ordering::SeqCst);
            if PTT_HELD.swap(false, Ordering::SeqCst) {
                push(Message::PttReleased);
            }
            push(Message::CommandDown);
        } else if is_up && CMD_HELD.swap(false, Ordering::SeqCst) {
            push(Message::CommandUp);
        }
    }

    // Push-to-talk. Never swallowed: other apps must keep seeing the modifiers.
    if !ptt.is_empty() && ptt.contains(&vk) {
        if is_down
            && !PTT_HELD.load(Ordering::SeqCst)
            && !CMD_HELD.load(Ordering::SeqCst)
            && !HANDS_FREE_LATCH.load(Ordering::SeqCst)
            && !SUPPRESS_PTT.load(Ordering::SeqCst)
            && all_held(&ptt, vk)
        {
            PTT_HELD.store(true, Ordering::SeqCst);
            let generation = PTT_GENERATION.load(Ordering::SeqCst);
            push(Message::PttPending(generation));
        } else if is_up && PTT_HELD.swap(false, Ordering::SeqCst) {
            PTT_GENERATION.fetch_add(1, Ordering::SeqCst);
            push(Message::PttReleased);
        }
    }

    // The suppression ends once the chord is physically free again.
    if is_up && SUPPRESS_PTT.load(Ordering::SeqCst) && !ptt.is_empty() && !any_held(&ptt) {
        SUPPRESS_PTT.store(false, Ordering::SeqCst);
    }

    false
}

// ------------------------------------------------------------------ start

#[cfg(windows)]
pub fn start(
    config: HotkeyConfig,
    on_event: impl Fn(HotkeyEvent) + Send + 'static,
) -> Result<(), String> {
    use std::sync::mpsc;
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

    // Worker thread: owns the user callback, sleeps until the hook wakes it.
    let worker = thread::spawn(move || loop {
        thread::park();
        loop {
            let next = queue().lock().ok().and_then(|mut q| q.pop_front());
            let Some(message) = next else { break };
            match message {
                Message::PasteLast => on_event(HotkeyEvent::PasteLast),
                Message::PttPending(generation) => {
                    thread::sleep(Duration::from_millis(PTT_GRACE_MS));
                    if PTT_GENERATION.load(Ordering::SeqCst) == generation
                        && !SUPPRESS_PTT.load(Ordering::SeqCst)
                        && PTT_HELD.load(Ordering::SeqCst)
                    {
                        PTT_EMITTED.store(true, Ordering::SeqCst);
                        on_event(HotkeyEvent::PttDown);
                    }
                }
                Message::PttReleased => {
                    if PTT_EMITTED.swap(false, Ordering::SeqCst) {
                        on_event(HotkeyEvent::PttUp);
                    }
                }
                Message::HandsFree => on_event(HotkeyEvent::HandsFreeToggle),
                Message::CommandDown => on_event(HotkeyEvent::CommandDown),
                Message::CommandUp => on_event(HotkeyEvent::CommandUp),
                Message::Escape => on_event(HotkeyEvent::Escape),
            }
        }
    });
    let _ = WORKER.set(worker.thread().clone());

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || unsafe {
        // Windows skips a low-level hook whose owning thread does not answer
        // inside LowLevelHooksTimeout, so this thread must always get the CPU.
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

        let module = GetModuleHandleW(None).unwrap_or_default();
        let instance = HINSTANCE(module.0);

        let mut hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), instance, 0)
        {
            Ok(hook) => {
                let _ = sender.send(Ok(()));
                hook
            }
            Err(error) => {
                let _ = sender.send(Err(error.to_string()));
                return;
            }
        };

        // Watchdog: Windows drops a timed-out hook silently, and an Explorer
        // restart can take it down too. Re-installing once per second heals both.
        let _ = SetTimer(None, 1, 1000, None);

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            if message.message == WM_TIMER {
                // Install the fresh hook first: the other order leaves a tiny
                // window with no hook at all.
                if let Ok(fresh) =
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), instance, 0)
                {
                    let _ = UnhookWindowsHookEx(hook);
                    hook = fresh;
                }
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        let _ = UnhookWindowsHookEx(hook);
    });

    match receiver.recv() {
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
