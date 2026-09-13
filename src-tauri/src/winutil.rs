//! Small Win32 helpers around the foreground window: which app is focused,
//! what its window title is and which category it belongs to.
#![cfg_attr(not(windows), allow(dead_code))]

#[derive(Debug, Clone, Default)]
pub struct ForegroundApp {
    /// Lowercase executable file name, e.g. "code.exe".
    pub process_name: String,
    pub title: String,
    pub hwnd: isize,
}

#[cfg(windows)]
pub fn foreground_app() -> ForegroundApp {
    use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0.is_null() {
            return ForegroundApp::default();
        }

        // Window title.
        let len = GetWindowTextLengthW(hwnd);
        let mut title = String::new();
        if len > 0 {
            let mut buffer = vec![0u16; len as usize + 1];
            let written = GetWindowTextW(hwnd, &mut buffer);
            if written > 0 {
                title = String::from_utf16_lossy(&buffer[..written as usize]);
            }
        }

        // Process image name.
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut process_name = String::new();
        if pid != 0 {
            if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buffer = vec![0u16; MAX_PATH as usize];
                let mut size = buffer.len() as u32;
                let ok = QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_FORMAT(0),
                    windows::core::PWSTR(buffer.as_mut_ptr()),
                    &mut size,
                );
                if ok.is_ok() && size > 0 {
                    let full = String::from_utf16_lossy(&buffer[..size as usize]);
                    process_name = full
                        .rsplit(|c| c == '\u{5c}' || c == '/')
                        .next()
                        .unwrap_or(&full)
                        .to_lowercase();
                }
                let _ = CloseHandle(handle);
            }
        }

        ForegroundApp {
            process_name,
            title,
            hwnd: hwnd.0 as isize,
        }
    }
}

#[cfg(not(windows))]
pub fn foreground_app() -> ForegroundApp {
    ForegroundApp::default()
}

#[cfg(windows)]
pub fn focus_hwnd(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::System::Threading::AttachThreadInput;
    use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
    };

    if hwnd == 0 {
        return;
    }
    let target = HWND(hwnd as *mut core::ffi::c_void);
    unsafe {
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        // Attaching to the foreground thread lifts the foreground lock, otherwise
        // Windows only flashes the taskbar button instead of focusing the window.
        let foreground = GetForegroundWindow();
        let current = GetCurrentThreadId();
        let other = GetWindowThreadProcessId(foreground, None);
        let attached = other != 0 && other != current && AttachThreadInput(current, other, true).as_bool();
        let _ = SetForegroundWindow(target);
        let _ = SetFocus(target);
        if attached {
            let _ = AttachThreadInput(current, other, false);
        }
    }
}

#[cfg(not(windows))]
pub fn focus_hwnd(_hwnd: isize) {}

/// Rough bucket for the statistics view.
pub fn app_category(process_name: &str, title: &str) -> &'static str {
    let process = process_name.to_lowercase();
    let title_lower = title.to_lowercase();

    // AI chat clients. Goetia and Cursor are AI-driven but used for coding, so
    // they live in the coding list below.
    let ai = ["claude.exe", "chatgpt.exe", "perplexity.exe", "copilot.exe"];
    if ai.contains(&process.as_str()) {
        return "ai";
    }

    let coding = [
        "code.exe",
        "cursor.exe",
        "goetia.exe",
        "code - insiders.exe",
        "windowsterminal.exe",
        "wt.exe",
        "powershell.exe",
        "pwsh.exe",
        "cmd.exe",
        "conhost.exe",
        "idea64.exe",
        "idea.exe",
        "rider64.exe",
        "rider.exe",
        "pycharm64.exe",
        "clion64.exe",
        "webstorm64.exe",
        "devenv.exe",
        "sublime_text.exe",
        "zed.exe",
        "neovide.exe",
        "alacritty.exe",
        "studio64.exe",
        "robloxstudiobeta.exe",
    ];
    if coding.contains(&process.as_str()) {
        return "coding";
    }

    let messages = [
        "discord.exe",
        "slack.exe",
        "ms-teams.exe",
        "teams.exe",
        "whatsapp.exe",
        "telegram.exe",
        "signal.exe",
        "element.exe",
    ];
    if messages.contains(&process.as_str()) {
        return "messages";
    }

    let documents = [
        "winword.exe",
        "notepad.exe",
        "notepad++.exe",
        "obsidian.exe",
        "notion.exe",
        "onenote.exe",
        "powerpnt.exe",
        "excel.exe",
        "wordpad.exe",
        "acrobat.exe",
    ];
    if documents.contains(&process.as_str()) {
        return "documents";
    }

    let email = ["outlook.exe", "thunderbird.exe", "mailspring.exe", "hey.exe"];
    if email.contains(&process.as_str()) {
        return "email";
    }

    // Browsers are decided by what the tab is showing.
    let browsers = [
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "brave.exe",
        "opera.exe",
        "vivaldi.exe",
        "arc.exe",
    ];
    if browsers.contains(&process.as_str()) {
        if title_lower.contains("gmail")
            || title_lower.contains("outlook")
            || title_lower.contains("posteingang")
            || title_lower.contains("inbox")
        {
            return "email";
        }
        if title_lower.contains("chatgpt")
            || title_lower.contains("claude")
            || title_lower.contains("gemini")
            || title_lower.contains("perplexity")
        {
            return "ai";
        }
        if title_lower.contains("github")
            || title_lower.contains("gitlab")
            || title_lower.contains("stack overflow")
        {
            return "coding";
        }
        if title_lower.contains("whatsapp")
            || title_lower.contains("discord")
            || title_lower.contains("slack")
        {
            return "messages";
        }
        return "other";
    }

    // Last resort: a mail-ish window title on an unknown app.
    if title_lower.contains("mail") || title_lower.contains("posteingang") {
        return "email";
    }
    "other"
}
