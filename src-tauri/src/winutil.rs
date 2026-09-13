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
    let ai = [
        "claude.exe",
        "chatgpt.exe",
        "perplexity.exe",
        "copilot.exe",
        "gemini.exe",
        "grok.exe",
        "msty.exe",
        "lmstudio.exe",
        "ollama.exe",
        "jan.exe",
        "chatbox.exe",
    ];
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
        "phpstorm64.exe",
        "goland64.exe",
        "datagrip64.exe",
        "rustrover64.exe",
        "fleet.exe",
        "windsurf.exe",
        "trae.exe",
        "kiro.exe",
        "zed editor.exe",
        "wezterm-gui.exe",
        "kitty.exe",
        "tabby.exe",
        "hyper.exe",
        "mintty.exe",
        "git-bash.exe",
        "bash.exe",
        "ubuntu.exe",
        "wsl.exe",
        "putty.exe",
        "mobaxterm.exe",
        "postman.exe",
        "insomnia.exe",
        "dbeaver.exe",
        "ssms.exe",
        "unity.exe",
        "unrealeditor.exe",
        "godot.exe",
        "sourcetree.exe",
        "github desktop.exe",
        "githubdesktop.exe",
        "gitkraken.exe",
        "filezilla.exe",
        "winscp.exe",
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
        "messenger.exe",
        "instagram.exe",
        "skype.exe",
        "zoom.exe",
        "threema.exe",
        "viber.exe",
        "wechat.exe",
        "line.exe",
        "revolt.exe",
        "beeper.exe",
        "ferdium.exe",
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
        "acrord32.exe",
        "acrobat reader.exe",
        "folio.exe",
        "sumatrapdf.exe",
        "foxitpdfreader.exe",
        "libreoffice.exe",
        "soffice.exe",
        "swriter.exe",
        "scalc.exe",
        "simpress.exe",
        "wps.exe",
        "et.exe",
        "wpp.exe",
        "logseq.exe",
        "anytype.exe",
        "joplin.exe",
        "typora.exe",
        "marktext.exe",
        "zotero.exe",
        "scrivener.exe",
        "evernote.exe",
        "onenoteim.exe",
        "publisher.exe",
        "visio.exe",
    ];
    if documents.contains(&process.as_str()) {
        return "documents";
    }

    let email = [
        "outlook.exe",
        "olk.exe",
        "hxoutlook.exe",
        "hxmail.exe",
        "thunderbird.exe",
        "mailspring.exe",
        "hey.exe",
        "em client.exe",
        "mailbird.exe",
        "bluemail.exe",
        "spark.exe",
        "postbox.exe",
        "emclient.exe",
    ];
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
        "zen.exe",
        "librewolf.exe",
        "waterfox.exe",
        "chromium.exe",
        "floorp.exe",
        "thorium.exe",
        "iexplore.exe",
    ];
    if browsers.contains(&process.as_str()) {
        // Window titles of browsers end in the site name, so a keyword list is
        // enough here and costs nothing at dictation time.
        let hit = |needles: &[&str]| needles.iter().any(|needle| title_lower.contains(needle));

        if hit(&["gmail", "outlook", "posteingang", "inbox", "mail.google", "web.de", "gmx",
                 "proton mail", "protonmail", "roundcube", "zoho mail", "icloud mail", "yahoo mail",
                 "mailbox.org", "fastmail", "e-mail", "webmail"])
        {
            return "email";
        }
        if hit(&["chatgpt", "claude", "gemini", "perplexity", "copilot", "grok", "deepseek",
                 "mistral", "le chat", "poe.com", "openrouter", "huggingface", "hugging face",
                 "midjourney", "notebooklm", "qwen", "kimi", "t3.chat", "openai"])
        {
            return "ai";
        }
        if hit(&["github", "gitlab", "bitbucket", "stack overflow", "stackoverflow", "localhost",
                 "127.0.0.1", "vercel", "netlify", "cloudflare", "supabase", "railway", "render.com",
                 "codepen", "codesandbox", "stackblitz", "replit", "jira", "linear.app", "sentry",
                 "npm", "crates.io", "docs.rs", "mdn", "developer.mozilla", "jenkins", "grafana",
                 "aws console", "console.cloud.google", "azure portal", "digitalocean", "hostinger"])
        {
            return "coding";
        }
        if hit(&["whatsapp", "discord", "slack", "messenger", "instagram", "telegram", "teams",
                 "signal", "reddit", "twitter", " / x", "bluesky", "mastodon", "tiktok",
                 "facebook", "snapchat"])
        {
            return "messages";
        }
        if hit(&["google docs", "google drive", "google sheets", "google slides", "docs.google",
                 "notion", "obsidian", "confluence", "coda.io", "overleaf", "word", "excel",
                 "powerpoint", "onedrive", "dropbox", "sharepoint", "pdf", "wikipedia",
                 "moodle", "ilias", "studip", "stud.ip", "hisinone", "canvas"])
        {
            return "documents";
        }
        return "other";
    }

    // Last resort: a mail-ish window title on an unknown app.
    if title_lower.contains("mail") || title_lower.contains("posteingang") {
        return "email";
    }
    "other"
}

#[cfg(test)]
mod tests {
    use super::app_category;

    #[test]
    fn known_apps_and_browser_tabs_land_in_the_right_bucket() {
        assert_eq!(app_category("claude.exe", ""), "ai");
        assert_eq!(app_category("Goetia.exe", "spechy"), "coding");
        assert_eq!(app_category("wezterm-gui.exe", ""), "coding");
        assert_eq!(app_category("olk.exe", "Posteingang"), "email");
        assert_eq!(app_category("folio.exe", "invoice.pdf"), "documents");
        assert_eq!(app_category("instagram.exe", ""), "messages");
    }

    #[test]
    fn browser_windows_are_read_from_their_title() {
        assert_eq!(app_category("chrome.exe", "ChatGPT - Google Chrome"), "ai");
        assert_eq!(app_category("firefox.exe", "remo/spechy: dictation - GitHub"), "coding");
        assert_eq!(app_category("chrome.exe", "localhost:1433/"), "coding");
        assert_eq!(app_category("msedge.exe", "Posteingang - Gmail"), "email");
        assert_eq!(app_category("chrome.exe", "Seminar notes - Google Docs"), "documents");
        assert_eq!(app_category("chrome.exe", "WhatsApp Web"), "messages");
        assert_eq!(app_category("chrome.exe", "Wetter in Hannover"), "other");
    }

    #[test]
    fn unknown_apps_stay_other_unless_the_title_says_mail() {
        assert_eq!(app_category("something.exe", "Untitled"), "other");
        assert_eq!(app_category("something.exe", "Mail - Remo"), "email");
    }
}
