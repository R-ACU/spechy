//! Autostart via the HKCU Run key. The boot start gets "--minimized" so Spechy
//! stays silent in the tray.
#![cfg_attr(not(windows), allow(dead_code))]

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Spechy";

#[cfg(windows)]
fn run_command() -> String {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    format!("\"{exe}\" --minimized")
}

#[cfg(windows)]
pub fn is_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(run) = hkcu.open_subkey(RUN_KEY) {
        if let Ok(value) = run.get_value::<String, _>(VALUE_NAME) {
            return !value.trim().is_empty();
        }
    }
    false
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
    if enabled {
        run.set_value(VALUE_NAME, &run_command())
            .map_err(|e| e.to_string())
    } else {
        // Deleting a value that was never set is not an error for us.
        let _ = run.delete_value(VALUE_NAME);
        Ok(())
    }
}

// Linux: a standard XDG autostart entry. Hyprland does not read that folder on
// its own; the session's own autostart script has to start Spechy when this file exists.

#[cfg(target_os = "linux")]
fn desktop_file() -> Option<std::path::PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))?;
    Some(config.join("autostart").join("spechy.desktop"))
}

#[cfg(target_os = "linux")]
pub fn is_enabled() -> bool {
    desktop_file().is_some_and(|p| p.exists())
}

#[cfg(target_os = "linux")]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = desktop_file().ok_or("No config folder found.")?;
    if !enabled {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // A dev build must not register itself for every login.
    if exe.components().any(|c| c.as_os_str() == "target") {
        return Ok(());
    }
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName=Spechy\nExec=\"{}\" --minimized\nIcon=spechy\nX-GNOME-Autostart-enabled=true\n",
        exe.display()
    );
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, entry).map_err(|e| e.to_string())
}
