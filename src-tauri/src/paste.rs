//! Getting text into the focused application: clipboard plus a synthetic Ctrl+V,
//! with a Unicode typing fallback.
#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
use std::time::{Duration, Instant};

/// How long we leave our text on the clipboard before putting the old content back.
#[cfg(windows)]
const RESTORE_DELAY_MS: u64 = 400;

// ---------------------------------------------------------------- clipboard

#[cfg(windows)]
unsafe fn open_clipboard_with_retry() -> Result<(), String> {
    use windows::Win32::System::DataExchange::OpenClipboard;
    for attempt in 0..20 {
        if OpenClipboard(None).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10 + attempt * 2));
    }
    Err("Could not open the clipboard.".to_string())
}

#[cfg(windows)]
pub fn get_clipboard_text() -> Option<String> {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData};
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if open_clipboard_with_retry().is_err() {
            return None;
        }
        let handle: HANDLE = match GetClipboardData(CF_UNICODETEXT.0 as u32) {
            Ok(handle) => handle,
            Err(_) => {
                let _ = CloseClipboard();
                return None;
            }
        };
        let global = HGLOBAL(handle.0);
        let pointer = GlobalLock(global) as *const u16;
        if pointer.is_null() {
            let _ = CloseClipboard();
            return None;
        }
        let mut length = 0usize;
        while *pointer.add(length) != 0 && length < 8 * 1024 * 1024 {
            length += 1;
        }
        let slice = std::slice::from_raw_parts(pointer, length);
        let text = String::from_utf16_lossy(slice);
        let _ = GlobalUnlock(global);
        let _ = CloseClipboard();
        Some(text)
    }
}

#[cfg(windows)]
pub fn set_clipboard(text: &str) -> Result<(), String> {
    use std::{mem, ptr};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        open_clipboard_with_retry()?;
        EmptyClipboard().map_err(|e| e.to_string())?;

        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let byte_len = wide.len() * mem::size_of::<u16>();
        let handle = GlobalAlloc(GMEM_MOVEABLE, byte_len).map_err(|e| e.to_string())?;
        let target = GlobalLock(handle);
        if target.is_null() {
            let _ = CloseClipboard();
            return Err("Could not lock clipboard memory.".to_string());
        }
        ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, target as *mut u8, byte_len);
        let _ = GlobalUnlock(handle);
        SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(handle.0))
            .map_err(|e| e.to_string())?;
        CloseClipboard().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ------------------------------------------------------------------- input

#[cfg(windows)]
fn key_input(vk: u16, up: bool) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(windows)]
fn unicode_input(unit: u16, up: bool) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY,
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: if up {
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                } else {
                    KEYEVENTF_UNICODE
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(windows)]
fn send(inputs: &[windows::Win32::UI::Input::KeyboardAndMouse::INPUT]) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT};
    unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// The user just let go of the hotkey, but Windows may still see Ctrl or Win as
/// held. Sending a key-up for every physically held modifier first makes the
/// synthetic Ctrl+V arrive as a plain Ctrl+V.
#[cfg(windows)]
fn release_held_modifiers() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_RCONTROL, VK_RMENU,
        VK_RSHIFT, VK_RWIN,
    };
    let modifiers = [
        VK_LCONTROL,
        VK_RCONTROL,
        VK_LSHIFT,
        VK_RSHIFT,
        VK_LMENU,
        VK_RMENU,
        VK_LWIN,
        VK_RWIN,
    ];
    let mut inputs = Vec::new();
    unsafe {
        for vk in modifiers {
            if (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 {
                inputs.push(key_input(vk.0, true));
            }
        }
    }
    if !inputs.is_empty() {
        send(&inputs);
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
pub fn paste_text(text: &str) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_CONTROL, VK_V};

    if text.is_empty() {
        return Ok(());
    }
    let previous = get_clipboard_text();
    set_clipboard(text)?;
    release_held_modifiers();

    send(&[
        key_input(VK_CONTROL.0, false),
        key_input(VK_V.0, false),
        key_input(VK_V.0, true),
        key_input(VK_CONTROL.0, true),
    ]);

    // Give the target app time to read the clipboard, then hand the old content back.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(RESTORE_DELAY_MS));
        if let Some(old) = previous {
            if !old.is_empty() {
                let _ = set_clipboard(&old);
            }
        }
    });

    Ok(())
}

#[cfg(windows)]
pub fn type_text(text: &str) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_RETURN;

    release_held_modifiers();
    let mut inputs = Vec::with_capacity(text.len() * 2);
    for ch in text.chars() {
        if ch == '\u{000a}' {
            inputs.push(key_input(VK_RETURN.0, false));
            inputs.push(key_input(VK_RETURN.0, true));
            continue;
        }
        if ch == '\u{000d}' {
            continue;
        }
        let mut buffer = [0u16; 2];
        // Surrogate pairs are sent as two separate unicode events.
        for unit in ch.encode_utf16(&mut buffer).iter().copied() {
            inputs.push(unicode_input(unit, false));
            inputs.push(unicode_input(unit, true));
        }
        // SendInput takes a limited batch; flush regularly to stay responsive.
        if inputs.len() >= 256 {
            send(&inputs);
            inputs.clear();
        }
    }
    if !inputs.is_empty() {
        send(&inputs);
    }
    Ok(())
}

#[cfg(windows)]
pub fn copy_selection() -> Option<String> {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_C, VK_CONTROL};

    let previous = get_clipboard_text();
    let before = unsafe { GetClipboardSequenceNumber() };

    release_held_modifiers();
    send(&[
        key_input(VK_CONTROL.0, false),
        key_input(VK_C.0, false),
        key_input(VK_C.0, true),
        key_input(VK_CONTROL.0, true),
    ]);

    let deadline = Instant::now() + Duration::from_millis(300);
    let mut selection = None;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(15));
        if unsafe { GetClipboardSequenceNumber() } != before {
            selection = get_clipboard_text();
            break;
        }
    }

    if let Some(old) = previous {
        let _ = set_clipboard(&old);
    }
    selection.filter(|s| !s.is_empty())
}

// ------------------------------------------------------------ non-Windows

#[cfg(not(windows))]
pub fn get_clipboard_text() -> Option<String> {
    None
}
#[cfg(not(windows))]
pub fn set_clipboard(_text: &str) -> Result<(), String> {
    Err("Clipboard is only implemented on Windows.".to_string())
}
#[cfg(not(windows))]
pub fn paste_text(_text: &str) -> Result<(), String> {
    Err("Pasting is only implemented on Windows.".to_string())
}
#[cfg(not(windows))]
pub fn type_text(_text: &str) -> Result<(), String> {
    Err("Typing is only implemented on Windows.".to_string())
}
#[cfg(not(windows))]
pub fn copy_selection() -> Option<String> {
    None
}
